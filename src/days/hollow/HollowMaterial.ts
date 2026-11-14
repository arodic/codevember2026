import {
  Color, DataTexture, EnvironmentNode, FrontSide, IrradianceNode, LinearFilter, LinearMipmapLinearFilter,
  MeshPhysicalNodeMaterial, Node, NodeBuilder, RGBAFormat, RepeatWrapping, Texture, UniformNode, UnsignedByteType,
} from 'three/webgpu'
import {
  abs, attribute, cameraWorldMatrix, clearcoatNormalView, clearcoatRoughness, dot, exp, float, fwidth,
  getParallaxCorrectNormal,
  materialEnvIntensity, max, mix, normalView, normalWorldGeometry, normalize, pmremTexture, positionViewDirection,
  positionWorld, pow, pow4, roughness, saturate, select, sin, smoothstep, texture, transformNormalToView, vec3,
} from 'three/tsl'
import type {HollowEnvProbe, HollowLightUniforms} from './HollowLighting.js'
import type {HollowAtmosphere} from './HollowAtmosphere.js'

/** One baked PMREM specular probe. */
export interface HollowEnvMap {
  map: Texture
  probe: HollowEnvProbe
}

/**
 * Specular-only, parallax-corrected environment from the two baked cave probes. The light maps already supply the
 * diffuse GI, so unlike three's `EnvironmentNode` this adds no irradiance (no second diffuse bounce). Base and
 * clearcoat layers each reflect about their own normal and roughness.
 */
class HollowSpecularEnvironmentNode extends EnvironmentNode {

  private readonly lake: HollowEnvMap
  private readonly sky: HollowEnvMap

  constructor(lake: HollowEnvMap, sky: HollowEnvMap) {
    super(pmremTexture(lake.map))
    this.lake = lake
    this.sky = sky
  }

  private radianceFor(nView: Node<'vec3'>, rough: Node<'float'>) {
    const reflectView = positionViewDirection.negate().reflect(nView)
    // As three: lean rough reflections toward the normal so they don't gather light from behind the tangent plane
    const dir = pow4(rough).mix(reflectView, nView).normalize().transformDirection(cameraWorldMatrix)
    const sample = ({map, probe}: HollowEnvMap) => pmremTexture(
      map,
      getParallaxCorrectNormal(dir, vec3(probe.size), vec3(probe.center)),
      rough,
    )
    const lakeZ = this.lake.probe.center.z
    const skyZ = this.sky.probe.center.z
    const towardSky = saturate(positionWorld.z.sub(lakeZ).div(skyZ - lakeZ))
    // `materialEnvIntensity` is `scene.environmentIntensity` here (no `material.envMap`)
    return mix(sample(this.lake), sample(this.sky), towardSky).mul(materialEnvIntensity)
  }

  override setup(builder: NodeBuilder) {
    const context = builder.context as unknown as {
      radiance: Node<'vec3'>
      lightingModel: {clearcoatRadiance?: Node<'vec3'> | null}
    }
    context.radiance.addAssign(this.radianceFor(normalView, roughness))
    const clearcoatRadiance = context.lightingModel.clearcoatRadiance
    if (clearcoatRadiance) clearcoatRadiance.addAssign(this.radianceFor(clearcoatNormalView, clearcoatRoughness))
    return null
  }
}

/**
 * Physical material lit by the baked cave: diffuse indirect light from a light map node (`lightMapNode`, irradiance
 * in lux per vertex; three r187 only reads a `lightMap` texture) and specular reflections from the two cave probes.
 */
export class HollowLitMaterial extends MeshPhysicalNodeMaterial {

  /** Indirect irradiance (`lux`), or `null` for none. */
  lightMapNode: Node<'vec3'> | null = null
  private env: {lake: HollowEnvMap; sky: HollowEnvMap} | null = null

  /** Sets the baked specular probes (or `null` while a bake runs) and rebuilds the material. */
  setEnv(lake: HollowEnvMap | null, sky: HollowEnvMap | null) {
    this.env = lake && sky ? {lake, sky} : null
    this.needsUpdate = true
  }

  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    void builder
    return this.env ? new HollowSpecularEnvironmentNode(this.env.lake, this.env.sky) : null
  }

  override setupLightMap(builder: NodeBuilder): Node {
    return this.lightMapNode ? new IrradianceNode(this.lightMapNode) : super.setupLightMap(builder)
  }
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x))
}

function hash2(ix: number, iy: number) {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function createAtlasTexture(data: Uint8Array, size: number, name: string) {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.needsUpdate = true
  tex.name = name
  return tex
}

/** CPU-bakes a seamless (periodic) limestone atlas: linear albedo in rgb, roughness in a. */
export function bakeRockDetailAtlas(size = 1024): DataTexture {
  const cells = 18
  const data = new Uint8Array(size * size * 4)
  const tau = Math.PI * 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const wx = Math.cos(u * tau)
      const wy = Math.sin(u * tau)
      const wz = Math.cos(v * tau)
      const ww = Math.sin(v * tau)

      // Periodic Voronoi: cell ids wrap, so the tile edges match
      const cellX = Math.floor(u * cells)
      const cellY = Math.floor(v * cells)
      let minD = 1e9
      let minD2 = 1e9
      let nearestId = 0
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = cellX + ox
          const cy = cellY + oy
          const hx = ((cx % cells) + cells) % cells
          const hy = ((cy % cells) + cells) % cells
          const px = (cx + hash2(hx, hy)) / cells
          const py = (cy + hash2(hx + 19, hy + 7)) / cells
          const d = Math.hypot(u - px, v - py)
          if (d < minD) {
            minD2 = minD
            minD = d
            nearestId = hx + hy * cells
          } else if (d < minD2) {
            minD2 = d
          }
        }
      }
      const edge = minD2 - minD
      const facet = clamp01(edge * 14)
      const fbm = 0.55
        + 0.25 * Math.sin(wx * 3.1 + wz * 2.7)
        + 0.12 * Math.sin(wy * 7.3 + ww * 5.1)
        + 0.08 * Math.sin((wx + ww) * 13.0)
      // Hairline fractures along some cell borders (not a lattice), fading in and out around the tile
      const crackOn = hash2(nearestId, 3) > 0.45 ? 1 : 0
      const crack = crackOn * (1 - clamp01(edge / 0.006)) * (0.6 + 0.4 * Math.sin(wx * 2.0 + ww * 3.0))
      const pit = Math.pow(clamp01(0.55 - minD * 3.2), 2)

      const baseR = 0.52 + 0.12 * fbm + 0.03 * facet
      const baseG = 0.46 + 0.10 * fbm + 0.02 * facet
      const baseB = 0.40 + 0.08 * fbm
      const spar = pit * 0.35
      const i = (y * size + x) * 4
      data[i] = 255 * clamp01(baseR - crack * 0.1 + spar)
      data[i + 1] = 255 * clamp01(baseG - crack * 0.09 + spar * 0.9)
      data[i + 2] = 255 * clamp01(baseB - crack * 0.07 + spar * 0.7)
      data[i + 3] = 255 * clamp01(0.72 - facet * 0.08 - spar * 0.35 + crack * 0.2 + pit * 0.1)
    }
  }
  return createAtlasTexture(data, size, 'Hollow Rock Detail Atlas')
}

/** Seamless travertine micro-terrace / sinter atlas: linear albedo in rgb, roughness in a. */
export function bakeTravertineAtlas(size = 1024): DataTexture {
  const data = new Uint8Array(size * size * 4)
  const tau = Math.PI * 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const terrace = Math.abs(Math.sin(v * Math.PI * 28 + Math.sin(u * Math.PI * 6) * 0.8))
      const scallop = Math.pow(terrace, 0.45)
      const sparkle = Math.pow(Math.max(0, Math.sin(u * tau * 14) * Math.cos(v * tau * 11)), 16)
      const i = (y * size + x) * 4
      data[i] = 255 * clamp01(0.72 + 0.12 * scallop + sparkle * 0.2)
      data[i + 1] = 255 * clamp01(0.58 + 0.10 * scallop + sparkle * 0.15)
      data[i + 2] = 255 * clamp01(0.40 + 0.08 * scallop)
      data[i + 3] = 255 * clamp01(0.55 - scallop * 0.2 - sparkle * 0.4)
    }
  }
  return createAtlasTexture(data, size, 'Hollow Travertine Atlas')
}

/** What thin calcite needs to transmit the light reaching its far side. */
export interface HollowTranslucency {
  atmosphere: HollowAtmosphere
  lights: HollowLightUniforms
}

export interface HollowRockMaterialOptions {
  name: string
  rockAtlas: DataTexture
  travertineAtlas: DataTexture
  styleMode: Node<'float'>
  /** Indirect irradiance per vertex (`HollowLighting.lightMapNode`). */
  lightMapNode: Node<'vec3'>
  /** Transmits the light reaching the far side of thin calcite sheets (`aSheet`): the draperies. */
  translucency?: HollowTranslucency
}

/**
 * Mean linear albedo of the dry limestone: the VXGI voxelizer reads `material.color` (not the node graph) as the
 * albedo of the bounces.
 */
const ROCK_MEAN_ALBEDO = [0.62, 0.54, 0.46] as const

/**
 * Absorption `σa` (`1/m`, red / green / blue) of the iron-tinted calcite of the speleothems: a few centimetres glow
 * amber, a decimetre deep red, thicker rock is opaque.
 */
const CALCITE_ABSORPTION = vec3(9, 22, 48)
/** Fraction of the light entering one face of a scattering calcite sheet that leaves the other (the rest returns). */
const CALCITE_DIFFUSE_TRANSMISSION = 0.5
/** Spacing (`m`) of the stained growth bands of the draperies. */
const CALCITE_BAND = 0.11

/** A color uniform as the `vec3` it is in the shader (@types/three keeps `color` apart). */
function rgb(node: UniformNode<'color', Color>): Node<'vec3'> {
  return node as unknown as Node<'vec3'>
}

/**
 * Light leaving thin calcite through its front: the irradiance on its far side (`thickness` behind, facing away)
 * from the shadowed sun and fire and the cave's indirect light, times the slab's diffuse transmittance
 * `T = t_d · exp(−σa · stain · thickness)`, out as Lambertian radiance `E · T / π`. Draperies carry iron-stained
 * growth bands parallel to their growing edge (cave bacon), which absorb more.
 */
function calciteTransmission(n: Node<'vec3'>, {atmosphere, lights}: HollowTranslucency): Node<'vec3'> {
  const sheet = attribute('aSheet', 'vec2')
  const thickness = sheet.x
  const behind = n.negate()
  // A little past the far face: the face itself is what the shadow maps hold
  const far = positionWorld.add(behind.mul(thickness.add(0.03)))
  const visible = atmosphere.directVisibility(far, lights.firePosition)
  const toFire = lights.firePosition.sub(far)
  const sun = rgb(lights.sunColor).mul(max(dot(behind, lights.sunDirection), 0).mul(visible.x))
  const fire = rgb(lights.fireColor)
    .mul(max(dot(behind, normalize(toFire)), 0).mul(visible.y).div(dot(toFire, toFire).max(0.04)))
  // Mean radiance `L` around the far side: a uniform field gives a plane `π L`
  const indirect = atmosphere.ambientAt(far).mul(Math.PI)
  // Broad bands of uneven width: a slow wobble of the phase stretches some and squeezes others
  const phase = sheet.y.mul((2 * Math.PI) / CALCITE_BAND).add(sin(sheet.y.mul((2 * Math.PI) / (CALCITE_BAND * 3.7))).mul(2.2))
  const band = smoothstep(0.25, 0.75, sin(phase).mul(0.5).add(0.5))
  // Bands finer than ~2 pixels average out (else they alias into moiré)
  const resolved = float(1).sub(smoothstep(0.15, 0.45, fwidth(sheet.y).div(CALCITE_BAND)))
  const stain = mix(float(1), mix(float(0.75), float(2.0), band), resolved)
  const transmittance = exp(CALCITE_ABSORPTION.mul(stain.mul(thickness)).negate())
    .mul(CALCITE_DIFFUSE_TRANSMISSION)
  return sun.add(fire).add(indirect).mul(transmittance).div(Math.PI)
}

/**
 * Wet limestone: world-space triplanar detail, zone-driven darkening and wet clearcoat. Indirect diffuse comes from
 * the VXGI light maps (darkened by the baked contact occlusion `aOcclusion`), specular from
 * `HollowLitMaterial.setEnv`. With `translucency`, drapery sheets let light through.
 */
export function createHollowRockMaterial(opts: HollowRockMaterialOptions): HollowLitMaterial {
  const {name, rockAtlas, travertineAtlas, styleMode, lightMapNode, translucency} = opts

  const material = new HollowLitMaterial({
    roughness: 0.62,
    metalness: 0.0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.08,
    side: FrontSide,
  })
  material.name = name
  material.color.setRGB(...ROCK_MEAN_ALBEDO)
  material.lightMapNode = lightMapNode
  material.aoNode = attribute('aOcclusion', 'float')

  // `aZone`: strata, travertine, rimstone, wetness
  const zoneAttr = attribute('aZone', 'vec4')
  // The light maps bake from the vertex normals (blended into the cave's fillets at the contacts): shade with them
  const worldN = normalWorldGeometry

  const bw = abs(worldN).pow(5.0)
  const bSum = bw.x.add(bw.y).add(bw.z).max(1e-4)
  const b = bw.div(bSum)
  const scale = float(0.42)
  const rockMap = texture(rockAtlas)
  const travMap = texture(travertineAtlas)
  const sampleTri = (map: typeof rockMap) => {
    const xS = map.sample(positionWorld.zy.mul(scale))
    const yS = map.sample(positionWorld.xz.mul(scale))
    const zS = map.sample(positionWorld.xy.mul(scale))
    return xS.mul(b.x).add(yS.mul(b.y)).add(zS.mul(b.z))
  }
  const detail = mix(sampleTri(rockMap), sampleTri(travMap), zoneAttr.y.mul(0.85).add(zoneAttr.z.mul(0.55)))

  const wetness = zoneAttr.w
  const dryAlbedo = detail.rgb.mul(mix(float(1.0), float(0.92), zoneAttr.x.mul(0.35))).mul(1.2)
  const wetAlbedo = pow(dryAlbedo, vec3(1.25)).mul(0.75)
  const albedo = mix(dryAlbedo, wetAlbedo, wetness)

  const zoneHost = albedo.mul(vec3(0.9, 0.82, 0.72))
  const zoneTint = mix(
    mix(zoneHost, albedo.mul(vec3(1.15, 0.78, 0.45)), zoneAttr.x.mul(0.55)),
    albedo.mul(vec3(1.2, 0.95, 0.6)),
    zoneAttr.y.mul(0.45),
  )
  const zoneFinal = mix(zoneTint, albedo.mul(vec3(1.25, 0.8, 0.35)), zoneAttr.z.mul(0.4))

  material.colorNode = select(styleMode.greaterThanEqual(0.5), zoneFinal, albedo)
  material.roughnessNode = mix(detail.a, float(0.18), wetness.mul(0.85))
  material.clearcoatNode = wetness.mul(0.92)
  material.clearcoatRoughnessNode = mix(float(0.12), float(0.04), wetness)

  // Water films bridge micro-relief: the coat's normal relaxes toward up as the rock gets wetter
  const coatN = normalize(mix(worldN, vec3(0, 1, 0), wetness.mul(0.35)))
  material.clearcoatNormalNode = transformNormalToView(coatN)

  if (translucency) material.emissiveNode = calciteTransmission(worldN, translucency)

  return material
}
