import {
  Color, EnvironmentNode, FrontSide, IrradianceNode, MeshPhysicalNodeMaterial, Node, NodeBuilder, Texture, UniformNode,
} from 'three/webgpu'
import {
  attribute, cameraWorldMatrix, clearcoatNormalView, clearcoatRoughness, dot, exp, float, fwidth,
  getParallaxCorrectNormal, materialEnvIntensity, max, mix, normalView, normalize, pmremTexture, positionViewDirection,
  positionWorld, pow4, roughness, saturate, sin, smoothstep, vec3,
} from 'three/tsl'
import type {HollowEnvProbe, HollowLightUniforms} from './HollowLighting.js'
import type {HollowAtmosphere} from './HollowAtmosphere.js'
import {
  type HollowSurfaceControls, type HollowSurfaceMaps, applyBakedHollowSurface, applyHollowSurface,
} from './HollowSurface.js'

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

/** What thin calcite needs to transmit the light reaching its far side. */
export interface HollowTranslucency {
  atmosphere: HollowAtmosphere
  lights: HollowLightUniforms
}

export interface HollowRockMaterialOptions {
  name: string
  /** Indirect irradiance per vertex (`HollowLighting.lightMapNode`). */
  lightMapNode: Node<'vec3'>
  /** The surface: live from its dials (`createHollowSurfaceControls`), or read from its baked maps. */
  surface: HollowSurfaceControls | HollowSurfaceMaps
  /** Transmits the light reaching the far side of thin calcite sheets (`aSheet`): the draperies. */
  translucency?: HollowTranslucency
}

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
 * The cave's surface (`applyHollowSurface`: bedrock, stains, crusts, calcite, rimstone, mud and water from its zones,
 * world position and normal), lit by the bake: indirect diffuse from the VXGI light maps (darkened by the contact
 * occlusion `aOcclusion`), specular from `HollowLitMaterial.setEnv`. With `translucency`, drapery sheets let light
 * through.
 */
export function createHollowRockMaterial(opts: HollowRockMaterialOptions): HollowLitMaterial {
  const {name, lightMapNode, surface, translucency} = opts
  const material = new HollowLitMaterial({side: FrontSide})
  material.name = name
  material.lightMapNode = lightMapNode
  const options = {transmission: translucency ? (normal: Node<'vec3'>) => calciteTransmission(normal, translucency) : undefined}
  if ('albedo' in surface) applyBakedHollowSurface(material, surface, options)
  else applyHollowSurface(material, surface, options)
  return material
}
