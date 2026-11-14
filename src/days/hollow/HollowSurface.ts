import {MeshPhysicalNodeMaterial, Node, UniformNode} from 'three/webgpu'
import {
  Fn, If, abs, attribute, cross, dot, float, floor, fwidth, hash, length, luminance, max, min, mix, mx_noise_float,
  mx_worley_noise_vec2, normalize, normalWorldGeometry, positionWorld, saturate, select, sign, sin,
  smoothstep, sqrt, transformNormalToView, uniform, varying, vec3, vec4,
} from 'three/tsl'

type FloatNode = Node<'float'>
type Vec3Node = Node<'vec3'>

/** The prototype's dials over the surface: uniforms, so turning them recompiles nothing. */
export interface HollowSurfaceControls {
  /** Added to the field's wetness (`aZone.w`, `-1 … 1`). */
  wetness: UniformNode<'float', number>
  /** Cover of iron-oxide stains (`0 … 2`, `1` as found). */
  iron: UniformNode<'float', number>
  /** Cover of mud and dust on what faces up (`0 … 2`). */
  sediment: UniformNode<'float', number>
  /** Cover of dry white crust, moonmilk (`0 … 2`). */
  crust: UniformNode<'float', number>
  /** Depth of the relief the surface adds to the mesh (`0 … 2`). */
  relief: UniformNode<'float', number>
  /** `0` shaded, `1` the layers in false colour. */
  debug: UniformNode<'float', number>
}

export function createHollowSurfaceControls(): HollowSurfaceControls {
  return {
    wetness: uniform(0),
    iron: uniform(1),
    sediment: uniform(1),
    crust: uniform(1),
    relief: uniform(1),
    debug: uniform(0),
  }
}

export interface HollowSurfaceOptions {
  /** Light leaving thin calcite through its front (emissive), given the shading normal: the draperies' glow. */
  transmission?: (normal: Vec3Node) => Vec3Node
}

/**
 * Mean linear albedo of the surface: the VXGI voxelizer reads `material.color` (not the node graph) as the albedo of
 * the bounces.
 */
export const HOLLOW_SURFACE_MEAN_ALBEDO = [0.6, 0.48, 0.34] as const

/** Thickness (`m`) of the limestone's beds. */
const BED = 0.31
/** Spacing (`m`) of the growth bands of flowstone and dripstone. */
const GROWTH_BAND = 0.017
/** Size (`m`) of the blocks the joints cut the bedrock into. */
const JOINT = 0.38
/** Index of refraction of calcite and limestone (`F0 ≈ 0.047`). */
const CALCITE_IOR = 1.55

/** Perlin noise of `q` times `resolved`, evaluated only where `live` (else `0`: the pixels skip it). */
const gatedNoise = Fn(([q, resolved, live]: [Vec3Node, FloatNode, FloatNode]) => {
  const value = float(0).toVar()
  If(live.greaterThan(0), () => {
    value.assign(mx_noise_float(q))
  })
  return value.mul(resolved)
}, {q: 'vec3', resolved: 'float', live: 'float', return: 'float'})

/**
 * Perlin noise (`≈ -1 … 1`, `σ ≈ 0.45`) of world position `p` at `frequency` (`1/m`, or per axis), faded to its mean
 * where the pixels (`px`, the world size of the pixel footprint) can't resolve it, so distant rock doesn't sparkle;
 * and not evaluated there, nor where `gate` (a layer's weight) is `0`.
 */
function noise(
  p: Vec3Node, frequency: number | readonly [number, number, number], seed: number, px: FloatNode, gate?: FloatNode,
): FloatNode {
  const f = typeof frequency === 'number' ? [frequency, frequency, frequency] : frequency
  const resolved = float(1).sub(smoothstep(0.25, 0.6, px.mul(Math.max(...f)))).mul(2)
  const q = p.mul(vec3(f[0], f[1], f[2])).add(vec3(seed * 17.13, seed * 7.37, seed * -11.71))
  return gatedNoise(q, resolved, gate ? resolved.mul(gate) : resolved)
}

type Frequency = number | readonly [number, number, number]

/** Perlin noise as `noise` (`σ ≈ 0.45`), unfaded: for the low frequencies `coarseNoises` takes per vertex. */
function rawNoise(frequency: Frequency, seed: number): FloatNode {
  const f = typeof frequency === 'number' ? [frequency, frequency, frequency] : frequency
  const q = positionWorld.mul(vec3(f[0], f[1], f[2])).add(vec3(seed * 17.13, seed * 7.37, seed * -11.71))
  return mx_noise_float(q).mul(2)
}

/**
 * Noises of world position at low frequencies (`≲ 2/m`, which the cave's cells sample well enough for colour),
 * evaluated per vertex and interpolated, so the pixels needn't: packed four to a varying (WebGPU has 16).
 */
function coarseNoises(specs: readonly (readonly [Frequency, number])[]): FloatNode[] {
  const out: FloatNode[] = []
  for (let i = 0; i < specs.length; i += 4) {
    const n = specs.slice(i, i + 4).map(([f, seed]) => rawNoise(f, seed))
    while (n.length < 4) n.push(float(0))
    const packed = varying(vec4(n[0], n[1], n[2], n[3]))
    out.push(packed.x, packed.y, packed.z, packed.w)
  }
  return out.slice(0, specs.length)
}

/** Octaves of `noise` from `frequency` up, `σ` kept that of one. */
function fbm(p: Vec3Node, frequency: number, octaves: number, seed: number, px: FloatNode): FloatNode {
  let sum: FloatNode = float(0)
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(noise(p, frequency * 2.03 ** i, seed + i * 5, px).mul(amp))
    norm += amp * amp
    amp *= 0.5
  }
  return sum.div(Math.sqrt(norm))
}

/** Ridged octaves of `noise` (`0 … 1`, sharp crests at `1`): weathered limestone's crests and creases. */
function ridged(p: Vec3Node, frequency: number, octaves: number, seed: number, px: FloatNode): FloatNode {
  let sum: FloatNode = float(0)
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const crest = float(1).sub(abs(noise(p, frequency * 2.03 ** i, seed + i * 5, px)).min(1))
    sum = sum.add(crest.mul(crest).mul(amp))
    norm += amp
    amp *= 0.5
  }
  return sum.div(norm)
}

/** A periodic pattern's `sin` faded out where its `period` (`m`) shrinks under a few pixels. */
function bands(phase: FloatNode, period: number, px: FloatNode): FloatNode {
  return sin(phase).mul(float(1).sub(smoothstep(0.2, 0.5, px.div(period))))
}

/**
 * The perturbed normal of a surface raised by `height` (`m`) along `n`: Mikkelsen's surface gradient from the screen
 * derivatives of the height and the world position (in metres both, so the relief is to scale).
 */
function bumpNormal(n: Vec3Node, height: FloatNode): Vec3Node {
  const dpdx = positionWorld.dFdx()
  const dpdy = positionWorld.dFdy()
  const r1 = cross(dpdy, n)
  const r2 = cross(n, dpdx)
  const det = dot(dpdx, r1)
  const grad = r1.mul(height.dFdx()).add(r2.mul(height.dFdy())).mul(sign(det))
  return normalize(abs(det).mul(n).sub(grad))
}

/**
 * The cave's one surface: limestone bedrock, its iron stains, manganese streaks and white crusts, calcite flowstone and
 * dripstone, rimstone and mud, wet or dry, each from world position and world normal (no UVs), the layers chosen by
 * what the signed distance field knows of the place:
 *
 * - `aZone` (`HollowSculpt.zonesAt`): `x` how much the beds show, `y` calcite deposit (dripstones, draperies,
 *   flowstone), `z` rimstone, `w` wetness;
 * - `aOcclusion`: contact occlusion (`1` open … `0` buried): mud gathers and crusts thin in hollows;
 * - the normal: mud lies on what faces up, water runs down what's steep, pools on what's flat.
 *
 * Water films are a clearcoat over the darkened, smoother solid: the wet patches the field marks, rivulets down steep
 * faces, strips down dripstones and flowstone, and puddles whose coat lies level. The relief the mesh lacks (it's `5`
 * to `20 cm` cells in the cave) is bump mapped from the same noises that colour it, so cracks and pits are dark and
 * sunken alike.
 */
export function applyHollowSurface(
  material: MeshPhysicalNodeMaterial,
  controls: HollowSurfaceControls,
  options: HollowSurfaceOptions = {},
) {
  material.color.setRGB(...HOLLOW_SURFACE_MEAN_ALBEDO)
  material.metalness = 0
  material.ior = CALCITE_IOR

  const p = positionWorld
  const n = normalize(normalWorldGeometry)
  const zone = attribute('aZone', 'vec4')
  const occ = attribute('aOcclusion', 'float')
  const px = length(fwidth(p)).max(1e-5)
  const steep = smoothstep(0.25, 0.75, float(1).sub(abs(n.y)))
  const upward = smoothstep(0.4, 0.85, n.y)
  const hollow = occ.oneMinus()

  // The low frequencies, per vertex
  const [
    province, greyTone, bedWarp, openField, ironCoarse, rustField, crustRegion, mudField, wetPatches, puddleField,
  ] = coarseNoises([
    [0.21, 2], [0.5, 30], [[0.5, 0.25, 0.5], 6], [0.8, 8], [[0.6, 0.24, 0.6], 10], [1.1, 12], [0.17, 36], [1.4, 20],
    [1.3, 24], [1.9, 26],
  ])

  // Where the field's zones meet, they meet raggedly
  const ragged = noise(p, 3.1, 1, px)
  const calcite = smoothstep(0.3, 0.7, zone.y.add(ragged.mul(0.22)))
  const rimstone = smoothstep(0.3, 0.7, zone.z.add(ragged.mul(0.2)))
  const strata = zone.x

  // --- Bedrock: grey (or grey-green) limestone, buff or iron-red over metres; swells, weathered crests and creases,
  // grit, beds and partings, joints, pits
  const grey = mix(vec3(0.16, 0.16, 0.15), vec3(0.12, 0.135, 0.115), smoothstep(-0.3, 0.5, greyTone))
  const bedBase = mix(
    mix(grey, vec3(0.36, 0.28, 0.19), smoothstep(0.0, 0.35, province)),
    vec3(0.3, 0.14, 0.07),
    smoothstep(0.45, 0.8, province),
  )
  const lumps = fbm(p, 1.7, 2, 3, px)
  const ridges = ridged(p, 5.5, 2, 4, px)
  const grit = noise(p, 55, 5, px)
  const bedCoord = p.y.add(bedWarp.mul(0.1)).div(BED)
  const bedTone = hash(floor(bedCoord).add(4096)).mul(0.32).add(0.84)
  const bedEdge = min(bedCoord.fract(), bedCoord.fract().oneMinus())
  const parting = float(1).sub(smoothstep(0.015, 0.07, bedEdge)).mul(float(1).sub(smoothstep(0.08, 0.25, px.div(BED))))
  // Joints: the boundaries of Worley cells, open in patches; the blocks between them stand a little proud
  const joints = mx_worley_noise_vec2(p.div(JOINT).add(vec3(lumps.mul(0.15))))
  const jointGap = sqrt(joints.y).sub(sqrt(joints.x))
  const jointWidth = max(px.div(JOINT).mul(1.5), 0.035)
  const open = smoothstep(-0.1, 0.5, openField)
  const crack = float(1).sub(smoothstep(0, jointWidth, jointGap)).mul(float(0.035).div(jointWidth)).mul(open)
  const block = smoothstep(0, 0.35, jointGap).mul(open)
  const porous = smoothstep(-0.2, 0.7, province).mul(0.7).add(0.3)
  const pits = smoothstep(0.5, 0.95, noise(p, 22, 9, px)).mul(porous)
  const bedrock = bedBase
    .mul(lumps.mul(0.16).add(1))
    .mul(ridges.sub(0.5).mul(0.22).add(1))
    .mul(grit.mul(0.07).add(1))
    .mul(mix(float(1), bedTone, strata))
    .mul(float(1).sub(parting.mul(strata).mul(0.4)))
    .mul(float(1).sub(crack.mul(0.55)))
    .mul(float(1).sub(pits.mul(0.3)))

  // --- Stains: iron oxide (ochre to rust, streaked down the walls), manganese (black streaks under ledges)
  const ironField = ironCoarse.add(ragged.mul(0.35))
  const iron = min(smoothstep(0.3, 0.9, ironField).mul(controls.iron), 1)
  const rust = smoothstep(-0.6, 0.6, rustField)
  const ironColor = mix(vec3(0.5, 0.29, 0.07), vec3(0.34, 0.12, 0.05), rust).mul(lumps.mul(0.15).add(1))
  const manganese = smoothstep(0.35, 0.9, noise(p, [5.5, 0.55, 5.5], 13, px, steep)).mul(steep).mul(hollow.mul(0.6).add(0.4))
  // --- Crust: dry white moonmilk and popcorn, draped down steep and overhanging rock, thinned in hollows; in some
  // stretches of the cave, not others. Its edge filtered over the pixel, so the ragged patches don't alias
  const fine = noise(p, 9, 15, px)
  const overhang = float(1).sub(smoothstep(-0.1, 0.5, n.y))
  const crustField = noise(p, [2.6, 0.9, 2.6], 14, px, overhang).add(fine.mul(0.4))
    .add(occ.sub(0.8).mul(0.5))
    .sub(smoothstep(-0.3, 0.3, crustRegion).oneMinus().mul(0.6))
  const crustEdge = fwidth(crustField)
  const crust = min(smoothstep(float(0.45).sub(crustEdge), float(0.9).add(crustEdge), crustField).mul(overhang)
    .mul(controls.crust), 1)
    .mul(float(1).sub(calcite.mul(0.6)))
  const popcorn = abs(grit)

  // --- Calcite: cream streaked with honey, orange with the iron; growth bands, flow lobes, strips down dripstones
  const flow = noise(p, [5, 1.6, 5], 16, px, calcite)
  const streak = smoothstep(-0.2, 0.8, noise(p, [8, 1.2, 8], 35, px, calcite))
  const stripField = noise(p, [34, 2.6, 34], 17, px, calcite)
  const strip = smoothstep(0.05, 0.5, stripField).mul(steep)
  const growth = bands(p.y.mul((2 * Math.PI) / GROWTH_BAND).add(flow.mul(5)), GROWTH_BAND, px)
  const cream = mix(vec3(0.72, 0.65, 0.52), vec3(0.64, 0.5, 0.31), streak.mul(0.6))
  const calciteColor = mix(cream, mix(vec3(0.62, 0.4, 0.17), vec3(0.55, 0.25, 0.07), rust), iron.mul(0.9))
    .mul(growth.mul(0.02).add(1))
    .mul(flow.mul(0.08).add(1))
    .mul(strip.mul(-0.06).add(1))

  // --- Rimstone: honeyed travertine, crenulated in irregular micro-terraces
  const gourField = noise(p, [9, 3, 9], 19, px, rimstone)
  const crenulation = noise(p, [14, 45, 14], 34, px, rimstone)
  const rimColor = mix(vec3(0.52, 0.37, 0.19), vec3(0.5, 0.28, 0.11), iron.mul(0.5))
    .mul(crenulation.mul(0.06).add(1))
    .mul(gourField.mul(0.08).add(1))

  // --- Sediment: mud and dust on what faces up, gathered in hollows
  const sediment = min(upward.mul(smoothstep(-1.0, 0.1, mudField.add(ragged.mul(0.3)).add(hollow.mul(1.2))))
    .mul(controls.sediment), 1)
    .mul(float(1).sub(calcite.mul(0.85)))
    .mul(float(1).sub(rimstone.mul(0.7)))
  const mudTone = lumps.mul(1.3)
  const mudColor = mix(
    mix(vec3(0.16, 0.14, 0.12), vec3(0.2, 0.14, 0.085), smoothstep(-0.6, 0.0, mudTone)),
    vec3(0.24, 0.16, 0.09),
    smoothstep(0.3, 0.8, mudTone),
  ).mul(grit.mul(0.1).add(1))

  // --- Layers, bottom up: each its albedo, roughness, relief (`m`), porosity (how much water darkens it), specular
  let albedo: Vec3Node = mix(bedrock, ironColor, iron.mul(0.75))
  albedo = mix(albedo, vec3(0.035, 0.03, 0.025), manganese.mul(0.7))
  let rough: FloatNode = float(0.82).add(grit.mul(0.04)).add(ridges.mul(0.05)).add(crack.mul(0.08))
  let height: FloatNode = lumps.mul(0.012).add(ridges.mul(0.007)).add(block.mul(0.003)).add(grit.mul(0.001))
    .sub(crack.mul(0.002)).sub(pits.mul(0.0012)).sub(parting.mul(strata).mul(0.005))
  let porosity: FloatNode = float(0.8)
  let specular: FloatNode = float(0.8)

  albedo = mix(albedo, vec3(0.62, 0.6, 0.55).mul(popcorn.sub(0.3).mul(0.12).add(1)), crust.mul(0.7))
  rough = mix(rough, float(0.93), crust)
  height = height.add(crust.mul(popcorn).mul(0.0015))
  porosity = mix(porosity, float(1), crust)
  specular = mix(specular, float(0.5), crust)

  albedo = mix(albedo, calciteColor, calcite)
  rough = mix(rough, float(0.5).add(flow.mul(0.06)).sub(strip.mul(0.25)), calcite)
  height = mix(height, flow.mul(0.003).add(stripField.mul(0.001)), calcite)
  porosity = mix(porosity, float(0.15), calcite)
  specular = mix(specular, float(1), calcite)

  albedo = mix(albedo, rimColor, rimstone)
  rough = mix(rough, float(0.45), rimstone)
  height = mix(height, crenulation.mul(0.0015).add(gourField.mul(0.002)), rimstone)
  porosity = mix(porosity, float(0.35), rimstone)
  specular = mix(specular, float(0.95), rimstone)

  albedo = mix(albedo, mudColor, sediment)
  rough = mix(rough, float(0.9), sediment)
  height = mix(height, fine.mul(0.0018).add(grit.mul(0.0004)), sediment)
  porosity = mix(porosity, float(1), sediment)
  specular = mix(specular, float(0.6), sediment)

  // --- Water: the field's wet patches, rivulets down steep faces, strips down calcite, puddles on the flat
  const wetField = saturate(zone.w.add(controls.wetness))
  const wet = saturate(wetField.mul(wetPatches.mul(0.6).add(1)))
  const rivulet = smoothstep(0.25, 0.65, noise(p, [20, 1.8, 20], 25, px, steep)).mul(steep).mul(smoothstep(0.15, 0.6, wetField))
  const film = max(
    max(smoothstep(0.55, 0.9, wet), rivulet.mul(0.85)),
    strip.mul(calcite).mul(smoothstep(0.2, 0.7, wetField)),
  )
  const level = smoothstep(0.86, 0.97, n.y)
  const puddle = level.mul(smoothstep(0.55, 0.8, wet.add(hollow.mul(0.6)).add(puddleField.mul(0.25))))
  const water = max(film, puddle)
  const soak = max(wet, water)
  // Wet darkening (Lagarde): water in the pores traps light, the more so the more porous; saturation rises with it
  const darken = mix(float(1), mix(float(0.88), float(0.32), porosity), soak)
  const saturated = max(mix(vec3(luminance(albedo)), albedo, porosity.mul(soak).mul(0.4).add(1)), vec3(0))
  albedo = saturated.mul(darken).mul(mix(float(1), float(0.6), puddle))
  rough = mix(rough, rough.mul(0.35).add(0.06), soak)
  // Standing water levels the relief under it
  height = mix(height, float(0), puddle)

  const shading = bumpNormal(n, height.mul(controls.relief))
  // A water film follows the rock's shape but not its grain; a puddle's lies level
  const coatNormal = normalize(mix(normalize(mix(shading, n, 0.6)), vec3(0, 1, 0), puddle))

  const shaded = controls.debug.lessThan(0.5)
  const layers = mix(
    mix(
      mix(mix(mix(vec3(0.3), vec3(1, 0.45, 0.1), iron.mul(0.7)), vec3(1), crust), vec3(0.95, 0.85, 0.6), calcite),
      vec3(1, 0.7, 0.1),
      rimstone,
    ),
    vec3(0.35, 0.2, 0.08),
    sediment,
  )
  material.colorNode = select(shaded, albedo, mix(layers, vec3(0.1, 0.35, 1), water.mul(0.6)))
  material.roughnessNode = saturate(rough)
  material.specularIntensityNode = specular
  material.normalNode = transformNormalToView(shading)
  material.clearcoatNode = select(shaded, water, float(0))
  material.clearcoatRoughnessNode = mix(float(0.08), float(0.025), puddle)
  material.clearcoatNormalNode = transformNormalToView(coatNormal)
  material.aoNode = occ
  if (options.transmission) material.emissiveNode = options.transmission(shading)
  material.needsUpdate = true
}
