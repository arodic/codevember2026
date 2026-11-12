import {
  Box3, BufferAttribute, BufferGeometry, Color, ComputeNode, DataTexture, FloatType, HalfFloatType, IrradianceNode, Mesh,
  MeshPhysicalNodeMaterial, Node, NodeBuilder, PlaneGeometry, Sphere, StorageTexture, UniformNode, Vector2, Vector3,
  Vector4, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, abs, add, asin, atan, cameraPosition, cameraProjectionMatrix, clamp, cos, cross, dot, exp, float, floor,
  fract, hash, instanceIndex, int, ivec2, length, max, min, mix, mod, mx_fractal_noise_float, mx_noise_float,
  mx_noise_vec3, normalLocal, normalize, positionGeometry, positionView, positionWorld, pow, round, saturate,
  screenSize, select, sign, sin, smoothstep, sqrt, sub, texture, textureLoad, textureStore, transformNormalToView,
  uniform, uvec2, varying, vec2, vec3, vec4,
} from 'three/tsl'
import { SkyUniforms, cloudShadow, skyMapUV } from './FoldSky.js'
import { CanyonPath } from './CanyonPath.js'

/** Width and depth of the diorama block. */
export const TERRAIN_SIZE = 160
/** Bottom of the block's cut faces. */
export const BLOCK_BASE = -42
/** Texels per side of the computed fields; the surface has one vertex per texel. */
export const FIELD_RESOLUTION = 2048
/** Texels per side of the occlusion field (cavity a few units across, sky visibility): low frequencies. */
const OCCLUSION_RESOLUTION = 512

const CELL = TERRAIN_SIZE / (FIELD_RESOLUTION - 1)
/** Thickness of one bed of the stratigraphic column. */
const BED_THICKNESS = 1.55
/** Depth of the column over which the palette runs from caprock to core redbeds. */
const COLUMN_DEPTH = 12
const CAPROCK_DEPTH = BED_THICKNESS * 1.5
const LAMINAE_PER_BED = 5
/** Taps on either side of the smoothing kernel. */
const SMOOTHING_RADIUS = 5

/**
 * Global illumination: texels per side of the irradiance over the block, rays each gathers per update, steps a ray
 * marches over the height field (growing from the first), and the height above which it has left for the sky.
 */
const GI_RESOLUTION = 384
const GI_CELL = TERRAIN_SIZE / GI_RESOLUTION
const GI_RAYS = 6
const GI_STEPS = 16
const GI_FIRST_STEP = 0.35
const GI_STEP_GROWTH = 1.42
const GI_CEILING = 48
/**
 * The edge-aware filter each estimate goes through before it is blended in: texels on either side, and how far off
 * a texel's tangent plane a neighbor may sit (units) before it stops counting (across a crest or a wall's foot).
 */
const GI_FILTER_RADIUS = 2
const GI_FILTER_PLANE = 0.3

/**
 * Sharpness of the marched shadows' penumbra: the light fades in over a clearance of the distance over this, as from a
 * sun some 3.6° across (the sun is half a degree; the coarse field cannot keep an edge that sharp).
 */
const PENUMBRA = 16

/** Half the span the slope of a wall is taken over before it is sculpted: floors and ledge tops stay put. */
const WALL_SPAN = 2
/** Heights above a point of a wall at which it looks for the lip of an overhang. */
const LIP_RISES = [0.6, 1.2, 2.2, 3.5, 5.2, 7.5]
/** Distances downhill (units) at which a wall looks for the sand at its foot. */
const SAND_LINE_DISTANCES = [0.1, 0.25, 0.5, 1, 2]
/** Blur of the sculpting, in texels. */
const DISPLACEMENT_SMOOTHING = 4
/** Distances back into the rock (units) at which it looks for its far side, so a wall never comes out through a fin. */
const THROUGH_DISTANCES = [0.6, 1.2, 2, 3, 4.5, 6.5, 9]

type Float = Node<'float'>
type Vec2 = Node<'vec2'>
type Vec3 = Node<'vec3'>

/** The fold train's controls and its seeded shape, as uniforms. */
export function createGeologyUniforms() {
  return {
    /** Tectonic progress: 0 flat-lying beds, 1 the folded, faulted and eroded belt. */
    age: uniform(1),
    shortening: uniform(0.35),
    amplitude: uniform(14),
    wavelength: uniform(72),
    /** -1 box folds, 0 concentric, 1 chevron. */
    sharpness: uniform(0.35),
    vergence: uniform(0.45),
    axialCurvature: uniform(9),
    /** 0 parallel fold trains, 1 ridges and basins wandering at random. */
    irregularity: uniform(0.4),
    thrustSlip: uniform(6),
    erosion: uniform(0.45),
    sandFill: uniform(3),
    /** Blur of the height field, in texels: keeps ledges and cliffs several texels wide. */
    smoothing: uniform(2.5),
    /** How far steep faces weather back under their lips, in units: 0 leaves a pure height field. */
    overhang: uniform(0.8),
    /** Fold axis direction. */
    strike: uniform(new Vector2(1, 0)),
    /** Axial trace bends: frequency, phase, second-harmonic ratio, second phase. */
    curve: uniform(new Vector4(0.02, 0, 2.3, 0)),
    /** Plunge envelope: frequency, phase, en-échelon skew. */
    plunge: uniform(new Vector3(0.02, 0, 0.5)),
    foldPhase: uniform(Math.PI / 2),
    /** Cross folds that interfere with the train: direction, then phase. */
    crossStrike: uniform(new Vector3(0, 1, 0)),
    /** Thrust: trace offset, ramp tangent, ramp sine, side (±1). */
    thrust: uniform(new Vector4(24, 0.7, 0.57, 1)),
    noiseOffset: uniform(new Vector3()),
    /** Noise offsets of the irregular warp (x, y), its phase noise (z) and amplitude noise (w). */
    warpSeed: uniform(new Vector4()),
    bedSeed: uniform(0),
    layer1: uniform(new Color()),
    layer2: uniform(new Color()),
    layer3: uniform(new Color()),
    layer4: uniform(new Color()),
    layer5: uniform(new Color()),
    sand: uniform(new Color()),
    /** Toward the light that casts shadows (the sun, or the moon at night). */
    keyDirection: uniform(new Vector3(0, 1, 0)),
  }
}

export type GeologyUniforms = ReturnType<typeof createGeologyUniforms>

/**
 * What the strata are lit with: the sky's radiance map (`SkyRadianceMap`, not pre-exposed), the key light's color
 * times intensity (pre-exposed), the level of the light (the sky's and the key light's on level ground, pre-exposed:
 * the irradiance is kept relative to it, so the light the running average remembers follows a falling dusk), the GI
 * switch, and the strength and saturation of the indirect light.
 */
export interface TerrainLighting {
  skyMap: DataTexture
  keyRadiance: UniformNode<'vec3', Vector3>
  level: UniformNode<'float', number>
  gi: UniformNode<'float', number>
  bounce: UniformNode<'float', number>
  saturation: UniformNode<'float', number>
}

/**
 * Fold coordinates of a map position: `v` along the axial trace, `u` across it (the trace bent into an S), `um` the
 * same across-strike position before shortening, which carries the fold phase as the belt is squeezed. With
 * `irregularity` the map is warped first by noise a wavelength across, so axes wander, bend and break, and a phase
 * and an amplitude noise come along for the uplift.
 */
function foldFrame(g: GeologyUniforms, xz: Vec2) {
  const frequency = float(1.1).div(g.wavelength)
  const at = (offset: Float) => vec3(xz.mul(frequency), offset)
  const warp = vec2(mx_fractal_noise_float(at(g.warpSeed.x), 3, 2.0, 0.5), mx_fractal_noise_float(at(g.warpSeed.y), 3, 2.0, 0.5))
  const warped = xz.add(warp.mul(g.irregularity.mul(g.wavelength).mul(0.42)))
  const v = dot(warped, g.strike)
  const across = dot(warped, vec2(g.strike.y.negate(), g.strike.x))
  const bend = sin(v.mul(g.curve.x).add(g.curve.y)).add(sin(v.mul(g.curve.x.mul(g.curve.z)).add(g.curve.w)).mul(0.35))
  const u = across.add(g.axialCurvature.mul(bend))
  const um = u.div(sub(1.0, g.shortening.mul(g.age)))
  const phaseNoise = mx_fractal_noise_float(vec3(xz.mul(frequency.mul(0.7)), g.warpSeed.z), 3, 2.0, 0.5)
  return {u, v, um, warped, phaseNoise, amplitudeNoise: warp.y}
}

type FoldFrame = ReturnType<typeof foldFrame>

function growthOf(g: GeologyUniforms) {
  return smoothstep(0.0, 1.0, g.age)
}

/**
 * Structural uplift of the beds: a fold train whose limbs steepen with vergence and whose profile runs from box to
 * chevron, plunging in and out along en-échelon axes, highest in the central anticline, with parasitic drag folds
 * on the limbs. `irregularity` breaks the hinges with phase noise, swells and dies out the folds, and crosses them
 * with a second set into domes and basins. It grows as the belt shortens.
 */
function foldUplift(g: GeologyUniforms, frame: FoldFrame): Float {
  const k = float(Math.PI * 2).div(g.wavelength)
  const theta = frame.um.mul(k).add(g.foldPhase).add(g.irregularity.mul(2.4).mul(frame.phaseNoise))
  const skewed = theta.add(g.vergence.mul(sin(theta)))
  const s = sin(skewed)
  const chevron = asin(clamp(s, -1.0, 1.0)).mul(2 / Math.PI)
  const box = sign(s).mul(pow(abs(s), 0.35))
  const profile = s.add(max(g.sharpness, 0.0).mul(chevron.sub(s))).add(max(g.sharpness.negate(), 0.0).mul(box.sub(s)))
  const plunge = add(0.62, sin(frame.v.add(frame.um.mul(g.plunge.z)).mul(g.plunge.x).add(g.plunge.y)).mul(0.38))
  const core = add(1.0, exp(pow(frame.u.div(g.wavelength.mul(0.55)), 2.0).negate()).mul(0.55))
  const growth = growthOf(g)
  const parasitic = sin(theta.mul(5.3).add(1.7)).mul(abs(cos(skewed))).mul(0.07).mul(growth)
  const swell = add(1.0, g.irregularity.mul(0.55).mul(frame.amplitudeNoise.mul(1.6)))
  const cross = sin(dot(frame.warped, g.crossStrike.xy).mul(k.mul(0.85)).add(g.crossStrike.z)).mul(g.irregularity.mul(0.45))
  return g.amplitude.mul(growth).mul(profile.mul(plunge).mul(core).mul(swell).add(cross).add(parasitic))
}

/** Throw of the listric thrust at height `y`: the hanging wall rides up the ramp late in the shortening. */
function thrustUplift(g: GeologyUniforms, u: Float, y: Float): Float {
  const across = u.mul(g.thrust.w)
  const fault = g.thrust.x.add(y.div(g.thrust.y)).add(y.mul(abs(y)).mul(0.004))
  const hangingWall = smoothstep(-1.2, 1.2, fault.sub(across))
  return g.thrustSlip.mul(smoothstep(0.25, 1.0, g.age)).mul(g.thrust.z).mul(hangingWall)
}

/** Position in the column in beds, with beds of varying thickness (monotonic in depth). */
function bedCoordinate(g: GeologyUniforms, depth: Float): Float {
  const beds = depth.div(BED_THICKNESS)
  return beds.add(sin(beds.mul(0.83).add(g.bedSeed)).mul(0.22)).add(sin(beds.mul(2.1).add(g.bedSeed.mul(1.7))).mul(0.12))
}

function bedDerivative(g: GeologyUniforms, depth: Float): Float {
  const beds = depth.div(BED_THICKNESS)
  return add(1.0, cos(beds.mul(0.83).add(g.bedSeed)).mul(0.22 * 0.83)).add(cos(beds.mul(2.1).add(g.bedSeed.mul(1.7))).mul(0.12 * 2.1)).div(BED_THICKNESS)
}

/**
 * A bed's lithology: where it sits in the palette (0 core redbed … 4 caprock, jittered so neighbors interleave), how
 * well it resists erosion (sandstone and caprock stand, shale and bentonite recede) and its tone.
 */
function bedProperties(g: GeologyUniforms, bed: Float) {
  const key = bed.add(g.bedSeed).add(4096.0)
  const jitter = hash(key)
  const variation = hash(key.mul(3.0).add(17.0))
  const tone = hash(key.mul(5.0).add(29.0))
  const index = clamp(sub(4.0, bed.mul(BED_THICKNESS / COLUMN_DEPTH * 4.4)).add(jitter.sub(0.5).mul(1.5)), 0.0, 4.0)
  const lithology = mix(mix(mix(mix(0.75, 0.95, saturate(index)), 0.4, saturate(index.sub(1.0))), 0.1, saturate(index.sub(2.0))), 1.0, saturate(index.sub(3.0)))
  return {index, competence: lithology.mul(variation.mul(0.4).add(0.6)), tone: tone.mul(0.3).add(0.85), crossbedding: hash(key.mul(7.0).add(3.0))}
}

/** Competence across the column, eased into the next bed's at each contact so the surface never steps at one. */
function competenceAt(g: GeologyUniforms, beta: Float): Float {
  const bed = floor(beta)
  return mix(bedProperties(g, bed).competence, bedProperties(g, bed.add(1.0)).competence, smoothstep(0.7, 1.0, fract(beta)))
}

/**
 * Differential erosion on a depth into the column: a resistant bed holds the surface at its top over a wide reach
 * (a ledge), then drops through it in a short cliff; weak beds wear back as slopes. Continuous across contacts.
 */
function terrace(g: GeologyUniforms, depth: Float): Float {
  const beta = bedCoordinate(g, depth)
  const f = fract(beta)
  const {competence} = bedProperties(g, floor(beta))
  const cliff = mix(1.0, 0.35, competence)
  const shaped = mix(f, smoothstep(sub(1.0, cliff), 1.0, f), competence.mul(0.85))
  return depth.add(shaped.sub(f).div(bedDerivative(g, depth)))
}

/**
 * How far a steep face has weathered back at a height (before `overhang`): weak beds under resistant ones, alcoves
 * wandering along the walls (noise that changes fast with height and slowly along them), and the notch the river cut
 * at the foot of the canyon walls (`channel`).
 */
function recessAt(g: GeologyUniforms, canyonFloor: Float, xz: Vec2, height: Float, depth: Float, channel: Float): Float {
  const weak = sub(1.0, competenceAt(g, bedCoordinate(g, depth)))
  const alcove = mx_fractal_noise_float(vec3(xz.x.mul(0.03), height.mul(0.2), xz.y.mul(0.03)).add(g.noiseOffset.zxy), 2, 2.0, 0.5)
  const notch = height.sub(canyonFloor).sub(3.4).div(1.5)
  return weak.mul(0.6).add(saturate(alcove.mul(0.7).add(0.5))).add(exp(notch.mul(notch).negate()).mul(channel).mul(0.7))
}

/**
 * A physical material lit indirectly by a node (`lightMapNode`) instead of a light map texture. three r188 adds
 * `NodeMaterial.lightMapNode`; r187, which this ships with, only reads `lightMap`, so the light map setup is overridden.
 */
class LightMappedMaterial extends MeshPhysicalNodeMaterial {

  lightMapNode: Node<'vec3'> | null = null

  override setupLightMap(builder: NodeBuilder): Node {
    return this.lightMapNode ? new IrradianceNode(this.lightMapNode) : super.setupLightMap(builder)
  }
}

/** A `receivedShadowNode`: three calls it with the light's shadow, which @types/three leaves out. */
function shadowFilter(filter: (shadow: Node<'vec4'>) => Node): () => Node {
  return filter as unknown as () => Node
}

/** Occlusion of the hollow a height sits in: how far the ring of heights `radii` units around rises above it. */
function cavityAt(heightAt: (dx: number, dy: number) => Float, height: Float, radii: number[], cell: number): Float {
  let cavity: Float = float(1.0)
  for (const radius of radii) {
    const texels = Math.max(1, Math.round(radius / cell))
    let sum: Float = float(0.0)
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2
      sum = sum.add(heightAt(Math.round(Math.cos(angle) * texels), Math.round(Math.sin(angle) * texels)))
    }
    const rise = max(sum.div(8.0).sub(height), 0.0).div(texels * cell)
    cavity = cavity.mul(clamp(sub(1.0, rise.mul(0.9)), 0.25, 1.0))
  }
  return cavity
}

/** Smooth maximum (polynomial). */
function smax(a: Float, b: Float, k: number): Float {
  const h = clamp(b.sub(a).div(k).mul(0.5).add(0.5), 0.0, 1.0)
  return mix(a, b, h).add(h.mul(sub(1.0, h)).mul(k))
}

/** Smooth minimum (polynomial). */
function smin(a: Float, b: Float, k: number): Float {
  return smax(a.negate(), b.negate(), k).negate()
}

/**
 * The landscape at a map position: the uplifted original surface, worn down by erosion that bevels crests and
 * breaches the weak core under the caprock, entrenched by the looping canyon down to its floor, carved into ledges by
 * bed competence, then buried in the troughs by wind-blown sand (the canyon keeps only a wash). Returns the surface
 * height, the fold uplift, the sand depth and the canyon channel, and the fold coordinates.
 */
function landscape(g: GeologyUniforms, canyon: CanyonPath, xz: Vec2) {
  const frame = foldFrame(g, xz)
  const fold = foldUplift(g, frame)
  const uplift = fold.add(thrustUplift(g, frame.u, fold))
  const growth = growthOf(g)

  const roughness = mx_fractal_noise_float(vec3(xz.mul(0.03), 0.0).add(g.noiseOffset), 5, 2.0, 0.5).mul(0.5).add(0.5)
  const depth = max(uplift, 0.0).mul(g.erosion).add(roughness.mul(growth).mul(2.5)).add(0.25).toVar()
  depth.addAssign(max(depth.sub(CAPROCK_DEPTH), 0.0).mul(g.erosion).mul(0.9))

  const c = canyon.uniforms
  const ring = canyon.coordinates(xz)
  const channel = sub(1.0, smoothstep(c.halfWidth, c.halfWidth.add(c.wall), ring.distance.add(mx_noise_float(vec3(xz.mul(0.09), 7.0)).mul(1.2))))
  depth.assign(max(depth, uplift.sub(c.floor).mul(channel)))

  const ledges = terrace(g, depth)
  const recessed = ledges.add(sub(1.0, competenceAt(g, bedCoordinate(g, ledges))).mul(BED_THICKNESS * 1.4).mul(growth))
  const height = uplift.sub(terrace(g, recessed))

  // sand: dunes in the troughs and a wash on the canyon floor, lumpy, banked up against the foot of the walls
  const wind = vec2(0.8, 0.6)
  const dunes = pow(sin(dot(xz, wind).mul(0.22).add(mx_noise_float(vec3(xz.mul(0.04), 3.0)).mul(2.0))).mul(0.5).add(0.5), 2.0).mul(1.4)
  const lumps = mx_fractal_noise_float(vec3(xz.mul(0.11), 11.0), 3, 2.0, 0.5)
  const fill = g.amplitude.mul(growth).mul(-0.5).add(g.sandFill.mul(growth)).sub(1.0).add(dunes.mul(growth)).add(lumps.mul(0.8))
  const banks = smoothstep(c.halfWidth.mul(0.45), c.halfWidth.add(c.wall.mul(0.2)), ring.distance).mul(lumps.mul(0.6).add(0.8)).mul(2.4)
  const wash = c.floor.add(0.35).add(dunes.mul(0.15)).add(lumps.mul(0.6)).add(banks)
  const surface = smax(height, mix(fill, wash, smoothstep(0.0, 0.2, channel)), 1.2)
  return {field: vec4(surface, fold, surface.sub(height), channel), frame: vec3(frame.u, frame.um, frame.v)}
}

/** Field texture coordinates of a local map position (texel centers at the surface's vertices). */
function fieldUV(xz: Vec2): Vec2 {
  return xz.div(TERRAIN_SIZE).add(0.5).mul((FIELD_RESOLUTION - 1) / FIELD_RESOLUTION).add(0.5 / FIELD_RESOLUTION)
}

function fieldTexel(xz: Vec2) {
  return ivec2(round(xz.div(TERRAIN_SIZE).add(0.5).mul(FIELD_RESOLUTION - 1)))
}

/**
 * The field's height at a map position through a cubic B-spline (four bilinear taps): smooth to its second derivative,
 * where both the surface's triangles and plain bilinear filtering kink at every texel.
 */
function smoothHeight(field: StorageTexture, xz: Vec2): Float {
  const texel = fieldUV(xz).mul(FIELD_RESOLUTION).sub(0.5)
  const base = floor(texel)
  const f = texel.sub(base)
  const f2 = f.mul(f)
  const f3 = f2.mul(f)
  const w0 = sub(1.0, f).mul(sub(1.0, f)).mul(sub(1.0, f)).div(6.0)
  const w1 = f3.mul(3.0).sub(f2.mul(6.0)).add(4.0).div(6.0)
  const w2 = f3.mul(-3.0).add(f2.mul(3.0)).add(f.mul(3.0)).add(1.0).div(6.0)
  const w3 = f3.div(6.0)
  const g0 = w0.add(w1)
  const g1 = w2.add(w3)
  const h0 = base.sub(0.5).add(w1.div(g0)).div(FIELD_RESOLUTION)
  const h1 = base.add(1.5).add(w3.div(g1)).div(FIELD_RESOLUTION)
  const tap = (u: Float, v: Float) => texture(field, vec2(u, v)).level(float(0)).x
  return g0.y.mul(g0.x.mul(tap(h0.x, h0.y)).add(g1.x.mul(tap(h1.x, h0.y))))
    .add(g1.y.mul(g0.x.mul(tap(h0.x, h1.y)).add(g1.x.mul(tap(h1.x, h1.y)))))
}

/** The normal of the (sculpted) surface from the shading field. */
function shadingNormal(shade: Node<'vec4'>): Vec3 {
  return normalize(shade.xyz)
}

/** The normal of the height field at a map position, by central differences `step` units across. */
function fieldNormal(field: StorageTexture, xz: Vec2, step: number): Vec3 {
  const heightAt = (dx: number, dz: number) => texture(field, fieldUV(xz.add(vec2(dx, dz)))).level(float(0)).x
  return normalize(vec3(heightAt(-step, 0).sub(heightAt(step, 0)), 2 * step, heightAt(0, -step).sub(heightAt(0, step))))
}

/**
 * Light reaching `start` from the key light, marched over height fields toward it: `near` steps over `nearHeight`
 * from `first` units out, then `far` steps over `farHeight` (a coarser field, for its cache), each step growing by
 * `growth`; past the rim nothing is in the way. Soft with distance (the ray's clearance over its length, `PENUMBRA`).
 */
function marchShadow(
  nearHeight: (xz: Vec2) => Float, farHeight: (xz: Vec2) => Float, start: Vec3, key: Vec3,
  near: number, far: number, first: number, growth: number,
): Float {
  return Fn(() => {
    const planar = length(key.xz).max(1e-3)
    const direction = key.xz.div(planar)
    const rise = key.y.div(planar)
    const visibility = float(1.0).toVar()
    const distance = float(first).toVar()
    const march = (heightAt: (xz: Vec2) => Float) => () => {
      const point = start.xz.add(direction.mul(distance))
      const inside = abs(point.x).max(abs(point.y)).lessThan(TERRAIN_SIZE / 2)
      const height = select(inside, heightAt(point), float(BLOCK_BASE - 100))
      visibility.assign(min(visibility, start.y.add(rise.mul(distance)).sub(height).mul(PENUMBRA).div(distance).add(0.5)))
      distance.mulAssign(growth)
    }
    if (near > 0) Loop(near, march(nearHeight))
    Loop(far, march(farHeight))
    return smoothstep(0.0, 1.0, visibility)
  })()
}

/** Map position of a texel's center on a grid of `resolution` texels over the block. */
function texelPosition(resolution: number) {
  return vec2(float(instanceIndex.mod(resolution)), float(instanceIndex.div(resolution))).add(0.5).div(resolution).sub(0.5).mul(TERRAIN_SIZE)
}

function texelCoordinate(resolution: number) {
  return uvec2(instanceIndex.mod(resolution), instanceIndex.div(resolution))
}

/** Texture coordinates over the block of a map position, for the grids whose texel centers sit at cell centers. */
function blockUV(xz: Vec2): Vec2 {
  return xz.div(TERRAIN_SIZE).add(0.5)
}

/** Rook pattern of the field's 4× supersampling, in texels. */
const SUBSAMPLES = [[-0.375, 0.125], [-0.125, 0.375], [0.125, -0.375], [0.375, -0.125]]

/**
 * The folded, eroded strata of the diorama. The field compute writes the landscape, supersampled (height, fold
 * uplift, sand, canyon channel) and the fold coordinates to storage textures; two passes smooth the landscape, and the
 * last ones derive the larger occlusion (cavity, sky visibility, a coarse height), the sculpting of steep faces back
 * into the rock (which lets them overhang, where a height field cannot) and the shading terms of the sculpted surface
 * (normal, cavity). The surface (one vertex per texel, pushed sideways by the sculpting) and the block's cut faces read
 * them. Each face's color comes from where its point sits in the deformed column, so laminae, ledges and faulted beds
 * line up on the surface and in section.
 *
 * The strata light themselves (`updateLighting`): each texel of a coarse grid knows what it sends out (its albedo lit
 * by the key light, through the height field's shadow and the clouds', and by its irradiance), then gathers rays
 * marched over the height field, the light of the surfaces they hit or of the sky they reach. The estimate is denoised
 * by an edge-aware filter and folded into a running average of the irradiance. Light bounces once more every update,
 * picking up the color of the rock it bounces off, and changes smoothly.
 */
export class FoldTerrain {

  /** Irradiance over the block, relative to the level of the light (`TerrainLighting.level`), averaged update by update. */
  readonly irradiance = new StorageTexture(GI_RESOLUTION, GI_RESOLUTION)
  private readonly irradianceNext = new StorageTexture(GI_RESOLUTION, GI_RESOLUTION)
  /** What each surface sends out (diffuse radiance, pre-exposed), for the rays that hit it. */
  private readonly radiance = new StorageTexture(GI_RESOLUTION, GI_RESOLUTION)
  /** One update's raw estimate of the irradiance, and the height of its texel (for the filter's edges). */
  private readonly estimate = new StorageTexture(GI_RESOLUTION, GI_RESOLUTION)
  /** The share of the new estimate, and a counter turning the rays. */
  private readonly blend = uniform(1)
  private readonly turn = uniform(0)
  private readonly lightingComputes: ComputeNode[]

  readonly field = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  readonly frame = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  /** Normal of the sculpted surface, and the cavity of small recesses. */
  readonly shading = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  /** The sculpting: sideways shift of each vertex (x, z), and the angle of the lowest lip over it (2: none). */
  readonly displacement = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  readonly occlusion = new StorageTexture(OCCLUSION_RESOLUTION, OCCLUSION_RESOLUTION)
  /** Samples per texel of the landscape: 1 for drafts (while the timeline folds the belt), 4 otherwise. */
  private readonly samples = uniform(4)
  /** Half-smoothed landscape, between the two smoothing passes. */
  private readonly smoothingTexture = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  readonly surface: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  readonly sides: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  private readonly computes: ComputeNode[]

  constructor(readonly geology: GeologyUniforms, readonly sky: SkyUniforms, readonly canyon: CanyonPath, readonly lighting: TerrainLighting) {
    this.field.name = 'Fold Field'
    this.field.type = FloatType
    this.smoothingTexture.name = 'Fold Smoothing'
    this.smoothingTexture.type = FloatType
    this.frame.name = 'Fold Frame'
    this.frame.type = HalfFloatType
    this.shading.name = 'Fold Shading'
    this.shading.type = HalfFloatType
    this.displacement.name = 'Fold Displacement'
    this.displacement.type = HalfFloatType
    this.occlusion.name = 'Fold Occlusion'
    this.occlusion.type = FloatType
    const lightingTextures = [
      [this.irradiance, 'Fold Irradiance'], [this.irradianceNext, 'Fold Irradiance Next'], [this.radiance, 'Fold Radiance'],
      [this.estimate, 'Fold Irradiance Estimate'],
    ] as const
    for (const [texture, name] of lightingTextures) {
      texture.name = name
      texture.type = HalfFloatType
    }

    this.computes = [
      this.createFieldCompute(),
      this.createSmoothingCompute(this.field, this.smoothingTexture, 1, 0),
      this.createSmoothingCompute(this.smoothingTexture, this.field, 0, 1),
      this.createOcclusionCompute(),
      this.createDisplacementCompute(),
      // smoothed (in the half-smoothed texture, free by now): no step between texels to tear into a strip, and shifts that
      // converge in the bend of a wall averaged before they cross
      this.createSmoothingCompute(this.displacement, this.smoothingTexture, 1, 0, float(DISPLACEMENT_SMOOTHING), DISPLACEMENT_SMOOTHING * 2),
      this.createSmoothingCompute(this.smoothingTexture, this.displacement, 0, 1, float(DISPLACEMENT_SMOOTHING), DISPLACEMENT_SMOOTHING * 2),
      this.createShadingCompute(),
    ]
    this.lightingComputes = [this.createRadianceCompute(), this.createGatherCompute(), this.createFilterCompute()]

    const bounds = new Box3(new Vector3(-TERRAIN_SIZE / 2, BLOCK_BASE, -TERRAIN_SIZE / 2), new Vector3(TERRAIN_SIZE / 2, 32, TERRAIN_SIZE / 2))
    const surfaceMaterial = this.createMaterial('surface')

    // shadows come from the height field (`receivedShadowNode`), not from a shadow map of the strata
    this.surface = new Mesh(createGrid(FIELD_RESOLUTION - 1, bounds), surfaceMaterial)
    this.surface.name = 'Strata'
    this.surface.receiveShadow = true

    this.sides = new Mesh(createSides(bounds), this.createMaterial('section'))
    this.sides.name = 'Section'
    this.sides.receiveShadow = true
  }

  /** Recomputes the landscape and its shading terms (after a change of the geology), as a `draft` or in full. */
  update(renderer: WebGPURenderer, draft = false) {
    this.samples.value = draft ? 1 : SUBSAMPLES.length
    for (const compute of this.computes) void renderer.compute(compute)
  }

  /**
   * One update of the global illumination: `blend` is the share of the new estimate (1 starts over, 1/n averages n
   * updates), `turn` turns the rays so updates sample new directions.
   */
  updateLighting(renderer: WebGPURenderer, blend: number, turn: number) {
    this.blend.value = blend
    this.turn.value = turn % 1024
    for (const compute of this.lightingComputes) void renderer.compute(compute)
    renderer.copyTextureToTexture(this.irradianceNext, this.irradiance)
  }

  /** The coarse height (from the occlusion field) under a map position, for marches over the block. */
  private coarseHeight(xz: Vec2): Float {
    return texture(this.occlusion, blockUV(xz)).level(float(0)).z
  }

  /** The strata's color at a map position, without the fine detail: the bed there, or sand. */
  private albedoAt(sample: Node<'vec4'>, frame: Node<'vec4'>): Vec3 {
    const g = this.geology
    const height = sample.x
    const depth = sample.y.add(thrustUplift(g, frame.x, height)).sub(height)
    const lithology = bedProperties(g, floor(bedCoordinate(g, depth)))
    return mix(this.paletteColor(lithology.index).mul(lithology.tone), g.sand, smoothstep(0.03, 0.12, sample.z))
  }

  /**
   * What each texel's surface sends out: its albedo over π times the key light reaching it (through the height
   * field's shadow and the clouds') and its irradiance.
   */
  private createRadianceCompute() {
    const g = this.geology
    const sky = this.sky
    const lighting = this.lighting
    return Fn(() => {
      const xz = texelPosition(GI_RESOLUTION)
      const uv = fieldUV(xz)
      const sample = texture(this.field, uv).level(float(0))
      const normal = fieldNormal(this.field, xz, GI_CELL / 2)
      const start = vec3(xz.x, sample.x, xz.y).add(normal.mul(0.3))
      const key = g.keyDirection
      const shadow = marchShadow(xz => this.coarseHeight(xz), xz => this.coarseHeight(xz), start, key, 0, 16, 0.5, 1.35)
      const clouds = cloudShadow(sky, start, key)
      const direct = lighting.keyRadiance.mul(max(dot(normal, key), 0.0)).mul(shadow).mul(clouds)
      const irradiance = texture(this.irradiance, blockUV(xz)).level(float(0)).rgb.mul(lighting.level)
      const albedo = this.albedoAt(sample, texture(this.frame, uv).level(float(0)))
      textureStore(this.radiance, texelCoordinate(GI_RESOLUTION), vec4(albedo.mul(direct.add(irradiance)).div(Math.PI), 1.0)).toWriteOnly()
    })().compute(GI_RESOLUTION * GI_RESOLUTION)
  }

  /**
   * Each texel's estimate of its irradiance: cosine-distributed rays (a spiral over the hemisphere, turned at random
   * per texel and update) marched over the coarse height field bring back the radiance of the surface they hit, or the
   * sky's (and past the rim, the desert floor's) where they leave the block.
   */
  private createGatherCompute() {
    const sky = this.sky
    const lighting = this.lighting
    return Fn(() => {
      const xz = texelPosition(GI_RESOLUTION)
      const height = texture(this.field, fieldUV(xz)).level(float(0)).x
      const normal = fieldNormal(this.field, xz, GI_CELL / 2)
      const origin = vec3(xz.x, height, xz.y).add(normal.mul(0.3))
      const tangent = normalize(cross(select(abs(normal.y).lessThan(0.999), vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0)), normal))
      const bitangent = cross(normal, tangent)
      const seed = instanceIndex.add(this.turn.toUint().mul(GI_RESOLUTION * GI_RESOLUTION)).mul(2)
      const jitter = hash(seed)
      const spin = hash(seed.add(1))
      const sum = vec3(0.0).toVar()
      Loop(GI_RAYS, ({i}) => {
        const u = float(i).add(jitter).div(GI_RAYS)
        const phi = fract(float(i).mul(0.618034).add(spin)).mul(Math.PI * 2)
        const radius = sqrt(u)
        const direction = tangent.mul(radius.mul(cos(phi))).add(normal.mul(sqrt(sub(1.0, u)))).add(bitangent.mul(radius.mul(sin(phi))))
        const light = vec3(0.0).toVar()
        // 1 marching, 0 left the block, -1 hit a surface
        const state = float(1.0).toVar()
        const distance = float(GI_FIRST_STEP).toVar()
        Loop(GI_STEPS, () => {
          If(state.greaterThan(0.5), () => {
            const point = origin.add(direction.mul(distance))
            If(max(abs(point.x), abs(point.z)).greaterThan(TERRAIN_SIZE / 2).or(point.y.greaterThan(GI_CEILING)), () => {
              state.assign(0.0)
            }).ElseIf(point.y.lessThan(this.coarseHeight(point.xz)), () => {
              light.assign(texture(this.radiance, blockUV(point.xz)).level(float(0)).rgb)
              state.assign(-1.0)
            })
            distance.mulAssign(GI_STEP_GROWTH)
          })
        })
        If(state.greaterThan(-0.5), () => {
          light.assign(texture(lighting.skyMap, skyMapUV(direction)).level(float(0)).rgb.mul(sky.preExposure))
        })
        sum.addAssign(light)
      })
      textureStore(this.estimate, texelCoordinate(GI_RESOLUTION), vec4(sum.mul(Math.PI / GI_RAYS), height)).toWriteOnly()
    })().compute(GI_RESOLUTION * GI_RESOLUTION)
  }

  /**
   * Denoises each texel's estimate with its neighbors' (a Gaussian over a few texels, each neighbor counting less the
   * farther it sits off the texel's tangent plane, so light does not bleed over crests or up walls) and blends it,
   * relative to the level of the light, into the running average.
   */
  private createFilterCompute() {
    const level = this.lighting.level
    return Fn(() => {
      const xz = texelPosition(GI_RESOLUTION)
      const x = float(instanceIndex.mod(GI_RESOLUTION))
      const y = float(instanceIndex.div(GI_RESOLUTION))
      const estimateAt = (dx: number, dy: number) => {
        return textureLoad(this.estimate, ivec2(int(clamp(x.add(dx), 0, GI_RESOLUTION - 1)), int(clamp(y.add(dy), 0, GI_RESOLUTION - 1))))
      }
      const height = estimateAt(0, 0).w
      const normal = fieldNormal(this.field, xz, GI_CELL / 2)
      let sum: Vec3 = vec3(0.0)
      let weights: Float = float(0.0)
      for (let dy = -GI_FILTER_RADIUS; dy <= GI_FILTER_RADIUS; dy++) {
        for (let dx = -GI_FILTER_RADIUS; dx <= GI_FILTER_RADIUS; dx++) {
          const neighbor = estimateAt(dx, dy)
          const plane = dot(normal, vec3(dx * GI_CELL, neighbor.w.sub(height), dy * GI_CELL)).div(GI_FILTER_PLANE)
          const weight = exp(plane.mul(plane).negate()).mul(Math.exp(-(dx * dx + dy * dy) / (2 * 1.2 * 1.2)))
          sum = sum.add(neighbor.rgb.mul(weight))
          weights = weights.add(weight)
        }
      }
      const previous = texture(this.irradiance, blockUV(xz)).level(float(0)).rgb
      const estimate = sum.div(weights).div(level.max(1e-12))
      textureStore(this.irradianceNext, texelCoordinate(GI_RESOLUTION), vec4(mix(previous, estimate, this.blend), 1.0)).toWriteOnly()
    })().compute(GI_RESOLUTION * GI_RESOLUTION)
  }

  private createFieldCompute() {
    const g = this.geology
    const canyon = this.canyon
    const field = this.field
    const frameTexture = this.frame
    return Fn(() => {
      const x = instanceIndex.mod(FIELD_RESOLUTION)
      const y = instanceIndex.div(FIELD_RESOLUTION)
      const texel = vec2(float(x), float(y))
      const sum = vec4(0.0).toVar()
      const frames = vec3(0.0).toVar()
      const samples = this.samples
      Loop({start: float(0), end: samples, type: 'float'}, ({i}) => {
        const rook = vec2(i.mul(0.25).sub(0.375), mod(i.add(2.0), 4.0).mul(0.25).sub(0.375))
        const offset = select(samples.greaterThan(1.5), rook, vec2(0.0))
        const sample = landscape(g, canyon, texel.add(offset).div(FIELD_RESOLUTION - 1).sub(0.5).mul(TERRAIN_SIZE))
        sum.addAssign(sample.field)
        frames.addAssign(sample.frame)
      })
      textureStore(field, uvec2(x, y), sum.div(samples)).toWriteOnly()
      textureStore(frameTexture, uvec2(x, y), vec4(frames.div(samples), 0.0)).toWriteOnly()
    })().compute(FIELD_RESOLUTION * FIELD_RESOLUTION)
  }

  /**
   * One axis of a separable Gaussian over a field, `sigma` texels wide (the landscape's `smoothing` by default) and
   * `radius` taps to either side.
   */
  private createSmoothingCompute(
    source: StorageTexture, target: StorageTexture, stepX: number, stepY: number,
    sigma: Float = this.geology.smoothing.max(0.05), radius = SMOOTHING_RADIUS,
  ) {
    return Fn(() => {
      const x = float(instanceIndex.mod(FIELD_RESOLUTION))
      const y = float(instanceIndex.div(FIELD_RESOLUTION))
      const sum = vec4(0.0).toVar()
      const weights = float(0.0).toVar()
      for (let tap = -radius; tap <= radius; tap++) {
        const weight = exp(float(-tap * tap).div(sigma.mul(sigma).mul(2.0)))
        const texel = ivec2(int(clamp(x.add(tap * stepX), 0, FIELD_RESOLUTION - 1)), int(clamp(y.add(tap * stepY), 0, FIELD_RESOLUTION - 1)))
        sum.addAssign(textureLoad(source, texel).mul(weight))
        weights.addAssign(weight)
      }
      const texel = uvec2(instanceIndex.mod(FIELD_RESOLUTION), instanceIndex.div(FIELD_RESOLUTION))
      textureStore(target, texel, sum.div(weights)).toWriteOnly()
    })().compute(FIELD_RESOLUTION * FIELD_RESOLUTION)
  }

  /**
   * The sculpting of steep faces (`overhang`): each texel of a wall is pushed back into the rock, up its slope taken
   * over a few units (so floors and benches stay put), by how far the rock at its height has weathered back, less
   * toward the top of the wall (so its rim overhangs, and the ledge behind it does not fold) and toward its foot and
   * the sand at it (so the ground there does not tear away from the wall), never deeper than half the rock behind.
   * Where the recess shrinks upward faster than the wall leans back, the rock above overhangs. Also the steepest light
   * (its elevation over a right angle, toward the face) that still passes under the lowest lip over the texel, for the
   * shadow a height field cannot cast. Smoothed afterwards, so no texel steps away from its neighbors.
   */
  private createDisplacementCompute() {
    const g = this.geology
    const field = this.field
    const frameTexture = this.frame
    const displacement = this.displacement
    const canyonFloor = this.canyon.uniforms.floor
    return Fn(() => {
      const x = float(instanceIndex.mod(FIELD_RESOLUTION))
      const y = float(instanceIndex.div(FIELD_RESOLUTION))
      const xz = vec2(x, y).div(FIELD_RESOLUTION - 1).sub(0.5).mul(TERRAIN_SIZE)
      const texelAt = (dx: number, dy: number) => ivec2(int(clamp(x.add(dx), 0, FIELD_RESOLUTION - 1)), int(clamp(y.add(dy), 0, FIELD_RESOLUTION - 1)))
      const sample = textureLoad(field, texelAt(0, 0))
      const coarse = (offset: Vec2) => this.coarseHeight(xz.add(offset))
      const gradient = vec2(
        coarse(vec2(WALL_SPAN, 0.0)).sub(coarse(vec2(-WALL_SPAN, 0.0))),
        coarse(vec2(0.0, WALL_SPAN)).sub(coarse(vec2(0.0, -WALL_SPAN))),
      ).div(2 * WALL_SPAN)
      const slope = length(gradient)
      const uphill = gradient.div(slope.max(1e-4))
      // the recess fades out toward the top of a wall (what rises above within a few units), so its rim stands out
      // over it and the ledge behind stays put; and toward its foot (how high it stands over the ground in front), so
      // the floor, the sand banked against it and the rock just under them stay put too
      const above = max(coarse(uphill), max(coarse(uphill.mul(2.0)), coarse(uphill.mul(3.5)))).sub(sample.x)
      const ground = (distance: number) => texture(field, fieldUV(xz.sub(uphill.mul(distance)))).level(float(0))
      const front = min(min(ground(0.3).x, ground(0.7).x), min(ground(1.5).x, min(coarse(uphill.mul(-2.0)), coarse(uphill.mul(-3.5)))))
      const beneath = sample.x.sub(front)
      // and over the first units above the sand just below (a bank against the wall drops away in front of it too)
      const sandLine = float(-1e3).toVar()
      const sandFound = float(0.0).toVar()
      for (const distance of SAND_LINE_DISTANCES) {
        const below = ground(distance)
        If(sandFound.lessThan(0.5).and(below.z.greaterThan(0.03)), () => {
          sandLine.assign(below.x)
          sandFound.assign(1.0)
        })
      }
      const border = smoothstep(0.0, 4.0, sub(TERRAIN_SIZE / 2, max(abs(xz.x), abs(xz.y))))
      const amount = saturate(slope.sub(0.4).div(1.4)).mul(smoothstep(0.5, 2.5, above)).mul(smoothstep(0.3, 2.0, beneath))
        .mul(smoothstep(0.0, 1.5, sample.x.sub(sandLine))).mul(sub(1.0, smoothstep(0.0, 0.12, sample.z)))
        .mul(border).mul(g.overhang).mul(growthOf(g))
      const result = vec4(0.0, 0.0, 2.0, 0.0).toVar()
      If(amount.greaterThan(1e-3), () => {
        const height = sample.x
        const depth = sample.y.add(thrustUplift(g, textureLoad(frameTexture, texelAt(0, 0)).x, height)).sub(height)
        const recess = recessAt(g, canyonFloor, xz, height, depth, sample.w)
        // the face `rise` above leans back by `rise` over the slope here, and is recessed by its own amount
        const heightAt = (dx: number, dy: number) => textureLoad(field, texelAt(dx, dy)).x
        const lean = length(vec2(heightAt(1, 0).sub(heightAt(-1, 0)), heightAt(0, 1).sub(heightAt(0, -1)))).div(2 * CELL).max(1e-3)
        const lip = float(2.0).toVar()
        for (const rise of LIP_RISES) {
          const recessAbove = recessAt(g, canyonFloor, xz, height.add(rise), depth.sub(rise), sample.w)
          const protrusion = recess.sub(recessAbove).mul(amount).sub(float(rise).div(lean))
          If(protrusion.greaterThan(0.02), () => {
            lip.assign(min(lip, atan(float(rise), protrusion).div(Math.PI / 2)))
          })
        }
        // no deeper than half the rock behind: where the ground behind first drops below this height (a fin's far
        // side), found between fixed samples so it changes smoothly from texel to texel
        const thickness = float(1e3).toVar()
        const found = float(0.0).toVar()
        let lastDistance = 0
        let lastRise: Float = float(0.5)
        for (const distance of THROUGH_DISTANCES) {
          const rise = this.coarseHeight(xz.add(uphill.mul(distance))).sub(height)
          const crossing = lastRise.div(lastRise.sub(rise).max(1e-4)).mul(distance - lastDistance).add(lastDistance)
          If(found.lessThan(0.5).and(rise.lessThanEqual(0.0)), () => {
            thickness.assign(crossing)
            found.assign(1.0)
          })
          lastDistance = distance
          lastRise = rise.max(1e-4)
        }
        result.assign(vec4(uphill.mul(smin(recess.mul(amount), thickness.mul(0.5), 0.3).max(0.0)), lip, 0.0))
      })
      textureStore(displacement, uvec2(instanceIndex.mod(FIELD_RESOLUTION), instanceIndex.div(FIELD_RESOLUTION)), result).toWriteOnly()
    })().compute(FIELD_RESOLUTION * FIELD_RESOLUTION)
  }

  /** Normal of the sculpted surface by central differences, and the cavity of small recesses (under ledges, between laminae). */
  private createShadingCompute() {
    const field = this.field
    const displacement = this.displacement
    const shading = this.shading
    return Fn(() => {
      const x = float(instanceIndex.mod(FIELD_RESOLUTION))
      const y = float(instanceIndex.div(FIELD_RESOLUTION))
      const texelAt = (dx: number, dy: number) => ivec2(int(clamp(x.add(dx), 0, FIELD_RESOLUTION - 1)), int(clamp(y.add(dy), 0, FIELD_RESOLUTION - 1)))
      const heightAt = (dx: number, dy: number) => textureLoad(field, texelAt(dx, dy)).x
      const pointAt = (dx: number, dy: number) => {
        const shift = textureLoad(displacement, texelAt(dx, dy)).xy
        return vec3(shift.x.add(dx * CELL), heightAt(dx, dy), shift.y.add(dy * CELL))
      }
      const normal = normalize(cross(pointAt(0, 1).sub(pointAt(0, -1)), pointAt(1, 0).sub(pointAt(-1, 0))))
      const cavity = cavityAt(heightAt, heightAt(0, 0), [0.6, 1.6], CELL)
      const texel = uvec2(instanceIndex.mod(FIELD_RESOLUTION), instanceIndex.div(FIELD_RESOLUTION))
      textureStore(shading, texel, vec4(normal, cavity)).toWriteOnly()
    })().compute(FIELD_RESOLUTION * FIELD_RESOLUTION)
  }

  /**
   * The occlusion of larger forms, at a quarter of the field's resolution: the cavity of fold troughs and canyon
   * floors, the sky visibility left by the horizon in eight directions out to 30 units (canyon walls), and the height
   * there (for marches, and the slope the sculpting follows).
   */
  private createOcclusionCompute() {
    const field = this.field
    const occlusion = this.occlusion
    return Fn(() => {
      const cell = TERRAIN_SIZE / OCCLUSION_RESOLUTION
      const ox = float(instanceIndex.mod(OCCLUSION_RESOLUTION))
      const oy = float(instanceIndex.div(OCCLUSION_RESOLUTION))
      // the field texel under this one's center
      const x = ox.add(0.5).div(OCCLUSION_RESOLUTION).mul(FIELD_RESOLUTION - 1).round()
      const y = oy.add(0.5).div(OCCLUSION_RESOLUTION).mul(FIELD_RESOLUTION - 1).round()
      const heightAt = (dx: number, dy: number) => {
        return textureLoad(field, ivec2(int(clamp(x.add(dx), 0, FIELD_RESOLUTION - 1)), int(clamp(y.add(dy), 0, FIELD_RESOLUTION - 1)))).x
      }
      const height = heightAt(0, 0)
      const cavity = cavityAt(heightAt, height, [4], CELL)
      // the coarse height averages the field over this texel (a box four field texels wide): sampled at one texel, it
      // would alias the ledges into a jagged crest whose shadow streaks the ground
      let coarse: Float = float(0.0)
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          coarse = coarse.add(heightAt(dx, dy).mul((Math.abs(dx) === 2 ? 0.5 : 1) * (Math.abs(dy) === 2 ? 0.5 : 1) / 16))
        }
      }

      let visibility: Float = float(0.0)
      for (let i = 0; i < 8; i++) {
        const angle = (i + 0.5) / 8 * Math.PI * 2
        let horizon: Float = float(0.0)
        for (const distance of [0.3, 0.6, 1, 1.6, 2.6, 4.2, 6.8, 11, 18, 30]) {
          const texels = Math.max(1, Math.max(distance, cell * 0.5) / CELL)
          const sample = heightAt(Math.round(Math.cos(angle) * texels), Math.round(Math.sin(angle) * texels))
          horizon = max(horizon, sample.sub(height).div(texels * CELL))
        }
        visibility = visibility.add(sub(1.0, horizon.div(sqrt(horizon.mul(horizon).add(1.0)))))
      }

      const texel = uvec2(instanceIndex.mod(OCCLUSION_RESOLUTION), instanceIndex.div(OCCLUSION_RESOLUTION))
      textureStore(occlusion, texel, vec4(cavity, visibility.div(8.0), coarse, 0.0)).toWriteOnly()
    })().compute(OCCLUSION_RESOLUTION * OCCLUSION_RESOLUTION)
  }

  /** The palette blended across a bed's (fractional) index, mostly holding one key color per bed. */
  private paletteColor(index: Float): Vec3 {
    const g = this.geology
    const banded = floor(index).add(smoothstep(0.35, 0.65, fract(index)))
    return mix(mix(mix(mix(g.layer1, g.layer2, saturate(banded)), g.layer3, saturate(banded.sub(1.0))), g.layer4, saturate(banded.sub(2.0))), g.layer5, saturate(banded.sub(3.0)))
  }

  /**
   * `surface` reads its height and shading from the fields; `section` stands the block's cut faces from its base up
   * to the surface along the rim. Both take their color from the column, with solid procedural detail at two scales
   * (solid noise in world space: nothing to project, so nothing stretches on any face, and it fades with the size of a
   * pixel before it aliases) that also varies roughness and specular reflectance; they are shadowed by marching the
   * height field toward the key light and lit indirectly by the gathered irradiance.
   */
  private createMaterial(part: 'surface' | 'section') {
    const g = this.geology
    const sky = this.sky
    const field = this.field
    const lighting = this.lighting
    const material = new LightMappedMaterial({roughness: 0.9, metalness: 0})
    material.name = part === 'surface' ? 'Strata' : 'Section'

    // the surface's map position stays where its texel is (`vLocal`, which the fields are read at); its vertex is
    // pushed sideways by the sculpting
    const vLocal = varying(vec3(), 'vFoldLocal')
    material.positionNode = Fn(() => {
      const texel = fieldTexel(positionGeometry.xz)
      const top = textureLoad(field, texel).x
      if (part === 'section') {
        vLocal.assign(vec3(positionGeometry.x, select(positionGeometry.y.greaterThan(-0.5), top, float(BLOCK_BASE)), positionGeometry.z))
        return vLocal
      }
      vLocal.assign(vec3(positionGeometry.x, top, positionGeometry.z))
      const shift = textureLoad(this.displacement, texel).xy
      return vec3(positionGeometry.x.add(shift.x), top, positionGeometry.z.add(shift.y))
    })()

    const uv = fieldUV(vLocal.xz)
    const sample = texture(field, uv)
    const shade = texture(this.shading, uv)
    const occluded = texture(this.occlusion, blockUV(vLocal.xz))
    const frame = texture(this.frame, uv)
    const sculpt = part === 'surface' ? texture(this.displacement, uv) : vec4(0.0, 0.0, 2.0, 0.0)
    const normal = part === 'surface' ? shadingNormal(shade) : normalLocal
    const steep = sub(1.0, normal.y)

    // where this point sits in the deformed column: on the surface at the smooth height there, since the triangles
    // of a steep wall zigzag around it and thin laminae would follow the zigzag; `solid`, where it sits once sculpted
    const height = part === 'surface' ? smoothHeight(field, vLocal.xz) : vLocal.y
    const point = vec3(vLocal.x, height, vLocal.z)
    const solid = point.add(vec3(sculpt.x, 0.0, sculpt.y))
    const depth = sample.y.add(thrustUplift(g, frame.x, height)).sub(height)
    const beta = bedCoordinate(g, depth)
    const bed = floor(beta)
    const withinBed = fract(beta)
    const lithology = bedProperties(g, bed)

    // cross-bedded laminae, swirled by the folds: the Wave's red and cream lines
    const material2D = frame.yz
    const angle = lithology.crossbedding.mul(Math.PI * 2)
    const swirl = mx_noise_float(vec3(material2D.mul(0.06), bed.mul(1.7))).mul(3.0)
    const dip = lithology.competence.mul(0.9)
    const lamina = withinBed.mul(LAMINAE_PER_BED).add(dip.mul(dot(material2D, vec2(cos(angle), sin(angle))).mul(0.35).add(swirl)))

    // laminae per unit across the beds: depth into the column changes with height and with the fold uplift
    const step = CELL * 2
    const east = texture(field, fieldUV(vLocal.xz.add(vec2(step, 0.0))))
    const south = texture(field, fieldUV(vLocal.xz.add(vec2(0.0, step))))
    const depthGradient = vec3(east.y.sub(sample.y).div(step), -1.0, south.y.sub(sample.y).div(step))
    const laminaGradient = depthGradient.mul(bedDerivative(g, depth).mul(LAMINAE_PER_BED))
    // the height field's own normal, unsculpted, for marches over it
    const fieldUp = part === 'surface' ? normalize(vec3(sample.x.sub(east.x), step, sample.x.sub(south.x))) : normalLocal

    // the size of a pixel here (from the distance, not screen derivatives: those change from one triangle of a steep
    // wall to the next and speckle it); laminae fade once several fall in a pixel, detail before it aliases
    const focal = cameraProjectionMatrix.mul(vec4(0.0, 1.0, -1.0, 1.0)).y.abs()
    const pixelAngle = float(2.0).div(focal.mul(screenSize.y))
    // seen at a grazing angle, a pixel stretches along the surface
    const facing = abs(dot(normalize(positionWorld.sub(cameraPosition)), normal)).max(0.12)
    const pixel = length(positionView).mul(pixelAngle).div(facing)
    const fade = sub(1.0, smoothstep(0.15, 0.5, length(laminaGradient).mul(pixel)))
    const fine = sub(1.0, smoothstep(0.012, 0.045, pixel))
    const medium = sub(1.0, smoothstep(0.08, 0.35, pixel))
    const wave = cos(lamina.mul(Math.PI * 2)).mul(0.5).add(0.5)
    const line = smoothstep(0.4, 1.0, wave).mul(fade)
    const pale = this.paletteColor(min(lithology.index.add(1.0), 4.0))
    const bedding = mix(1.0, 0.82, smoothstep(0.92, 1.0, withinBed).add(smoothstep(0.06, 0.0, withinBed)).mul(0.5))
    const rock = mix(this.paletteColor(lithology.index), pale, line.mul(lithology.competence).mul(0.45)).mul(lithology.tone).mul(bedding)

    // rock detail: mottling and iron staining a unit or so across; Liesegang bands, rings of iron oxide precipitated
    // through the sandstone (the contours of a slow, swirling field, in patches: smooth curves, as on sculpted faces);
    // grain and pits
    const mottle = mx_fractal_noise_float(solid.mul(0.55), 2, 2.0, 0.5).mul(medium)
    const stain = smoothstep(0.15, 0.65, mx_fractal_noise_float(solid.mul(0.17).add(19.0), 2, 2.0, 0.5))
    const precipitation = mx_fractal_noise_float(solid.mul(0.045).add(vec3(5.0, 11.0, 17.0)), 3, 2.0, 0.5)
    const iron = smoothstep(0.05, 0.45, mx_fractal_noise_float(solid.mul(0.025).add(41.0), 2, 2.0, 0.5))
    const bands = smoothstep(0.6, 0.95, cos(precipitation.mul(Math.PI * 2 * 4))).mul(iron).mul(medium)
    const grain = mx_noise_float(solid.mul(11.0)).mul(0.6).add(mx_noise_float(solid.mul(29.0)).mul(0.4)).mul(fine)
    const pits = smoothstep(0.55, 0.85, mx_noise_float(solid.mul(7.0).add(31.0))).mul(fine)
    const detailed = rock.mul(add(1.0, mottle.mul(0.16)))
      .mul(mix(vec3(1.0), vec3(0.72, 0.46, 0.34), stain.mul(0.35)))
      .mul(mix(vec3(1.0), vec3(0.6, 0.33, 0.22), bands.mul(0.4)))
      .mul(add(1.0, grain.mul(0.08)))
      .mul(sub(1.0, pits.mul(0.1)))

    // sand: its edge frays where it thins over the rock (only where there is sand: bare rock keeps none); ripples on
    // the flats with heavy minerals in their troughs,
    // and glinting quartz grains
    const sandBase = sample.x.sub(sample.z)
    const fray = mx_fractal_noise_float(point.mul(0.8).add(5.0), 2, 2.0, 0.5)
    const edge = smoothstep(0.0, 0.04, sample.z)
    const isSand = smoothstep(0.02, 0.16, sample.z.add(fray.mul(0.09).mul(edge))).mul(smoothstep(-0.05, 0.05, height.sub(sandBase).add(fray.mul(0.06).mul(edge))))
    const windward = dot(vLocal.xz, vec2(0.8, 0.6))
    const flat = smoothstep(0.75, 0.95, normal.y)
    const ripplePhase = windward.mul(7.0).add(mx_noise_float(point.mul(0.35).add(1.0)).mul(4.0))
    const ripple = cos(ripplePhase).mul(0.5).add(0.5)
    const glint = smoothstep(0.62, 0.8, mx_noise_float(point.mul(41.0))).mul(fine)
    const sandColor = g.sand.mul(mx_noise_float(point.mul(0.5).add(9.0)).mul(0.07).add(0.97))
      .mul(mix(1.0, 0.86, sample.w.mul(0.6)))
      .mul(sub(1.0, pow(sub(1.0, ripple), 3.0).mul(flat).mul(0.18)))
      .mul(add(1.0, grain.mul(0.06)))

    const ground = mix(detailed, sandColor, isSand)
    // sandstone rough, rougher and duller in pits, smoother where iron cements its bands; sand rough but for its
    // glinting quartz
    const roughness = mix(add(0.86, grain.mul(0.05)).add(pits.mul(0.08)).sub(bands.mul(0.08)), mix(0.96, 0.5, glint), isSand)
    const specular = mix(sub(0.9, pits.mul(0.2)).add(bands.mul(0.2)), add(1.0, glint.mul(3.0)), isSand)

    if (part === 'surface') {
      // desert varnish in curtains down steep, resistant faces, where water runs over them: dark, with a slight sheen
      const curtains = mx_noise_float(vec3(solid.x.mul(0.7), height.mul(0.08), solid.z.mul(0.7)).add(vec3(13.0, 0.0, 7.0)))
      const varnish = smoothstep(0.35, 0.8, steep).mul(smoothstep(0.15, 0.55, curtains)).mul(lithology.competence).mul(sub(1.0, isSand))
      const varnished = mix(ground, ground.mul(vec3(0.38, 0.3, 0.26)), varnish.mul(0.7))
      // talus: rubble of the beds above, gathered in the hollows at the foot of the ledges, on slopes it can rest on
      const talus = smoothstep(0.85, 0.55, shade.w.mul(occluded.x)).mul(smoothstep(0.08, 0.3, steep)).mul(smoothstep(0.55, 0.35, steep))
        .mul(sub(1.0, isSand))
      material.colorNode = mix(varnished, mix(varnished, g.sand, 0.35).mul(0.85), talus.mul(0.6))
      material.roughnessNode = mix(roughness, 0.7, varnish)
      material.specularIntensityNode = mix(specular, 1.1, varnish)
    } else {
      material.colorNode = ground
      material.roughnessNode = roughness
      material.specularIntensityNode = specular
    }

    // relief, as a world-space height gradient: the laminae (resistant ones stand proud), the ripples and the grain
    const ramp = saturate(wave.sub(0.4).div(0.6))
    const lineSlope = ramp.mul(sub(1.0, ramp)).mul(6.0 / 0.6).mul(sin(lamina.mul(Math.PI * 2)).mul(-Math.PI)).mul(fade)
    const laminaRelief = laminaGradient.mul(lineSlope).mul(lithology.competence.mul(0.035).mul(sub(1.0, isSand)))
    const rippleRelief = vec3(0.8, 0.0, 0.6).mul(cos(ripplePhase).mul(7.0 * 0.5 * 0.025)).mul(isSand.mul(flat))
    const grainRelief = mx_noise_vec3(solid.mul(11.0)).mul(0.1).mul(fine).mul(sub(1.0, isSand.mul(0.6)))
    const relief = laminaRelief.add(rippleRelief).add(grainRelief)
    material.normalNode = transformNormalToView(normalize(normal.sub(relief.sub(normal.mul(dot(relief, normal))))))

    // under the lip of an overhang (which the height field knows nothing of): the light is cut off above the lip's
    // angle, seen from here toward the face, and so is that much of the sky
    const key = g.keyDirection
    const recessed = length(sculpt.xy)
    const sheltered = smoothstep(0.0, 0.05, recessed)
    const toward = dot(key.xz, sculpt.xy.negate().div(recessed.max(1e-4)))
    const keyAngle = atan(key.y, toward.max(1e-4)).div(Math.PI / 2)
    const lip = sub(1.0, smoothstep(sculpt.z.sub(0.04), sculpt.z.add(0.04), keyAngle).mul(sheltered))
    const shelter = sub(1.0, saturate(sub(1.0, sculpt.z)).mul(sheltered).mul(0.6))

    // occlusion of the environment: ledge recesses and fold troughs, the sky the horizon leaves, the cracks between
    // laminae and pits in the rock (not in the sand over it, where the laminae would draw its contours), the lips of
    // overhangs
    const crevices = sub(1.0, sub(1.0, line).mul(lithology.competence).mul(0.25).add(pits.mul(0.3)).mul(sub(1.0, isSand)))
    const skyVisibility = part === 'surface' ? occluded.y : float(1.0)
    const cavity = part === 'surface' ? shade.w.mul(occluded.x) : float(1.0)
    material.aoNode = cavity.mul(skyVisibility).mul(crevices).mul(shelter)

    // indirect light: the gathered irradiance already sees the walls, so the sky visibility comes back out of it; the
    // cut faces take the rim's, dimmed
    const gathered = texture(this.irradiance, blockUV(vLocal.xz)).rgb.mul(lighting.level).mul(part === 'surface' ? 1.0 : 0.6)
    const indirect = gathered.div(max(skyVisibility, 0.2)).mul(lighting.gi).mul(lighting.bounce)
    material.lightMapNode = mix(vec3(dot(indirect, vec3(0.2126, 0.7152, 0.0722))), indirect, lighting.saturation).max(vec3(0.0))

    // self-shadowing marched over the height field toward the key light, from the smooth, unsculpted surface lifted
    // along its normal (the triangles zigzag around the field the march samples); the lips; and the clouds' shadows
    const clouds = cloudShadow(sky, positionWorld, key)
    const horizon = marchShadow(xz => texture(field, fieldUV(xz)).level(float(0)).x, xz => this.coarseHeight(xz), point.add(fieldUp.mul(0.15)), key, 9, 17, 0.3, 1.27)
    material.receivedShadowNode = shadowFilter(shadow => shadow.mul(horizon).mul(lip).mul(clouds))
    return material
  }

  dispose() {
    this.field.dispose()
    this.smoothingTexture.dispose()
    this.frame.dispose()
    this.shading.dispose()
    this.displacement.dispose()
    this.occlusion.dispose()
    this.irradiance.dispose()
    this.irradianceNext.dispose()
    this.radiance.dispose()
    this.estimate.dispose()
    this.surface.geometry.dispose()
    this.sides.geometry.dispose()
    this.surface.material.dispose()
    this.sides.material.dispose()
  }
}

/** A flat grid over the block with the block's bounds (its height is displaced on the GPU). */
function createGrid(segments: number, bounds: Box3) {
  const geometry = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments)
  geometry.rotateX(-Math.PI / 2)
  geometry.deleteAttribute('uv')
  geometry.deleteAttribute('normal')
  geometry.boundingBox = bounds.clone()
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere())
  return geometry
}

/**
 * The block's four cut faces along its rim, one column of two vertices per surface texel: `y` 0 marks the top (raised
 * to the surface), -1 the bottom (lowered to the base). Normals face out.
 */
function createSides(bounds: Box3) {
  const n = FIELD_RESOLUTION
  const half = TERRAIN_SIZE / 2
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const sides: [number, number, number, number, number, number][] = [
    // start x, start z, step x, step z, normal x, normal z
    [-half, half, 1, 0, 0, 1],
    [half, half, 0, -1, 1, 0],
    [half, -half, -1, 0, 0, -1],
    [-half, -half, 0, 1, -1, 0],
  ]
  for (const [startX, startZ, stepX, stepZ, normalX, normalZ] of sides) {
    const first = positions.length / 3
    for (let i = 0; i < n; i++) {
      const x = startX + stepX * i * CELL
      const z = startZ + stepZ * i * CELL
      positions.push(x, 0, z, x, -1, z)
      normals.push(normalX, 0, normalZ, normalX, 0, normalZ)
      if (i === n - 1) continue
      const a = first + i * 2
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setIndex(indices)
  geometry.boundingBox = bounds.clone()
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere())
  return geometry
}
