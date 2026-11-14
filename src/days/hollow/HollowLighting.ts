import {
  Box3, Color, CubeCamera, CubeRenderTarget, DirectionalLight, DoubleSide, HalfFloatType, MathUtils,
  Matrix4, Mesh, MeshBasicNodeMaterial, NearestFilter, Node, PMREMGenerator, PlaneGeometry, PointLight, PointLightShadow,
  RenderTarget, SRGBColorSpace, Scene, Texture, UniformNode, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, Loop, abs, cross, cubeTexture, dot, float, int, interleavedGradientNoise, materialColor, max, normalWorld,
  normalize, reference, renderGroup, screenCoordinate, select, uniform, vec3, vogelDiskSample,
} from 'three/tsl'
import {VXGIVolume} from 'three/addons/lighting/vxgi/VXGIVolume.js'
import {vxgiIrradiance} from 'three/addons/lighting/vxgi/VXGIIrradiance.js'
import {HOLLOW_MAX, HOLLOW_MIN, HollowField, createHollowRandom} from './HollowField.js'
import type {HollowAtmosphere} from './HollowAtmosphere.js'
import {
  VERTEX_LIGHT_WIDTH, VertexLightMapper, assignLightTexels, vertexLight, vertexLightRows,
} from './HollowVertexLight.js'

/** Angular radius (rad) of the fire's shadow penumbra: the flames are wide and dance, so its shadows are soft. */
const FIRE_SHADOW_SOFTNESS = 0.1
const FIRE_SHADOW_TAPS = 24

/**
 * Wide percentage-closer filter for the fire's cube shadow: `FIRE_SHADOW_TAPS` Vogel-disk directions within
 * `FIRE_SHADOW_SOFTNESS` of the fragment's, rotated per pixel. three's filter compares every tap against the
 * fragment's own distance, which self-shadows tilted surfaces once the kernel is wide; here each tap compares against
 * where its ray meets the receiver's plane (receiver-plane depth), so lit floors and walls stay lit.
 */
function createFireShadowFilter(shadow: PointLightShadow) {
  return Fn((inputs: {depthTexture: Texture; bd3D: Node<'vec3'>; distance: Node<'float'>}) => {
    const {depthTexture, bd3D, distance} = inputs
    const near = reference('near', 'float', shadow.camera).setGroup(renderGroup)
    const far = reference('far', 'float', shadow.camera).setGroup(renderGroup)
    const bias = reference('bias', 'float', shadow).setGroup(renderGroup)
    const map = depthTexture as unknown as Parameters<typeof cubeTexture>[0]
    // Perspective depth of the point `viewZ` along a face's axis: `depthA + depthB / viewZ`
    const depthA = far.div(far.sub(near)).add(bias).toConst()
    const depthB = near.mul(far).div(near.sub(far)).toConst()

    const a = abs(bd3D)
    const tangent = normalize(cross(bd3D, select(a.x.greaterThan(a.z), vec3(0, 1, 0), vec3(1, 0, 0)))).toConst()
    const bitangent = cross(bd3D, tangent).toConst()
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(2 * Math.PI).toConst()
    // Receiver plane through the fragment: a tap direction `d` meets it at `t = (P · N) / (d · N)`
    const toFragment = bd3D.mul(distance).toConst()
    const planeDistance = dot(toFragment, normalWorld).toConst()

    const lit = float(0).toVar()
    Loop(FIRE_SHADOW_TAPS, ({i}) => {
      const disk = vogelDiskSample(i, int(FIRE_SHADOW_TAPS), phi)
      const dir = bd3D.add(tangent.mul(disk.x).add(bitangent.mul(disk.y)).mul(FIRE_SHADOW_SOFTNESS)).toConst()
      const facing = dot(dir, normalWorld)
      const onPlane = planeDistance.div(select(abs(facing).greaterThan(1e-3), facing, 1e-3))
      const t = select(onPlane.greaterThan(0), onPlane, distance).clamp(distance.mul(0.5), distance.mul(2)).toConst()
      const ad = abs(dir)
      const viewZ = max(max(ad.x, ad.y), ad.z).mul(t)
      lit.addAssign(cubeTexture(map, dir).compare(depthA.add(depthB.div(viewZ))))
    })
    return lit.div(FIRE_SHADOW_TAPS)
  })
}

/** The three light sources, each baked at unit intensity and rescaled live (light transport is linear). */
export const HOLLOW_LIGHT_SOURCES = ['sun', 'fire', 'sky'] as const
export type HollowLightSource = typeof HOLLOW_LIGHT_SOURCES[number]

/** Photometric light levels (scene units: one unit of illuminance is about 1 klx). */
export interface HollowLightLevels {
  /** Sun illuminance at normal incidence, down the skylight chimney. */
  sunIlluminance: number
  /** Luminance of the sky seen through the chimney (the emissive portal). */
  skyLuminance: number
  /** Mean luminous intensity of the fire behind the camera (it flickers around this). */
  fireIntensity: number
}

/**
 * Hazy daylight over the chimney: the veiled sun gives about a third of the sky dome's illuminance (`π · L`; under a
 * clear sky it gives ~6×), so the blue sky light rules the back chamber as in the reference. The fire is far brighter
 * than a real one would be next to daylight, so it reads.
 */
export const DEFAULT_HOLLOW_LIGHTS: HollowLightLevels = {
  sunIlluminance: 8,
  skyLuminance: 12.0,
  fireIntensity: 36,
}

/** Uniforms the materials and the mist read: the live lights and the scale of each unit-intensity bake. */
export interface HollowLightUniforms {
  /** Unit vector toward the sun. */
  sunDirection: UniformNode<'vec3', Vector3>
  /** Sun illuminance (`rgb`). */
  sunColor: UniformNode<'color', Color>
  firePosition: UniformNode<'vec3', Vector3>
  /** Fire luminous intensity (`rgb`, flickering). */
  fireColor: UniformNode<'color', Color>
  /** Scale of the unit-intensity sun bake. */
  giSun: UniformNode<'float', number>
  /** Scale of the unit-luminance sky bake. */
  giSky: UniformNode<'float', number>
  /** Scale of the unit-intensity fire bake (`rgb`: its tint flickers too). */
  giFire: UniformNode<'color', Color>
}

/** Fresh light uniforms (shared by the rig, the materials and the mist). */
export function createHollowLightUniforms(): HollowLightUniforms {
  return {
    sunDirection: uniform(new Vector3(0, 1, 0)),
    sunColor: uniform(new Color()),
    firePosition: uniform(new Vector3()),
    fireColor: uniform(new Color()),
    giSun: uniform(0),
    giSky: uniform(0),
    giFire: uniform(new Color()),
  }
}

/** Objects on this layer are voxelized for the GI. */
export const HOLLOW_GI_LAYER = 3
const VXGI_RESOLUTION = 192
const SAMPLES_PER_SOURCE = 64
const SAMPLES_PER_FRAME = 2
const SUN_KELVIN = 5600
/** Clear-sky radiance tint (linear Rec. 709): Rayleigh scattering, far bluer than any blackbody. */
const SKY_TINT = [0.32, 0.6, 1.0] as const
const FIRE_KELVIN = 2100
const ENV_SIZE = 128
/** Flicker partials as whole cycles per loop, so the flame loops seamlessly with the timeline. */
const FLICKER_CYCLES = [23, 41, 67, 109, 173, 241]

/** Approximate blackbody color (Kelvin, `1000..12000`) as sRGB `0..1`. */
export function kelvinToColor(kelvin: number, target = new Color()) {
  const t = kelvin / 100
  const r = t <= 66 ? 1 : MathUtils.clamp(1.2929 * Math.pow(t - 60, -0.1332), 0, 1)
  const g = t <= 66
    ? MathUtils.clamp(0.3901 * Math.log(t) - 0.6318, 0, 1)
    : MathUtils.clamp(1.1299 * Math.pow(t - 60, -0.0755), 0, 1)
  const b = t >= 66 ? 1 : t <= 19 ? 0 : MathUtils.clamp(0.5432 * Math.log(t - 10) - 1.1963, 0, 1)
  return target.setRGB(r, g, b, SRGBColorSpace)
}

/** Scales a linear Rec. 709 color to unit luminance, so a light's intensity is photometric. */
export function toUnitLuminance(target: Color) {
  const y = 0.2126 * target.r + 0.7152 * target.g + 0.0722 * target.b
  return target.multiplyScalar(1 / Math.max(1e-6, y))
}

/** Blackbody color at unit luminance. */
export function unitLuminance(kelvin: number, target = new Color()) {
  return toUnitLuminance(kelvinToColor(kelvin, target))
}

/** Placement of one PMREM specular probe: captured at `center`, parallax-corrected against a box of `size`. */
export interface HollowEnvProbe {
  center: Vector3
  size: Vector3
}

interface BakeStep {
  weight: number
  /** Runs once per frame until it returns `true`. */
  run: (renderer: WebGPURenderer) => boolean
  progress?: () => number
}

/**
 * Physically based light rig. Every source is occluded by the rock; nothing else emits.
 * - **Sun:** a shadowed `DirectionalLight` down the chimney (its shadow camera fitted around the whole cavern).
 * - **Sky:** the emissive portal over the chimney mouth, seen by the GI with correct occlusion.
 * - **Fire:** a shadowed inverse-square `PointLight` behind the camera, flickering (intensity, 1850–2350 K tint,
 *   ±10 cm position) on whole cycles per loop.
 *
 * Direct light is analytic in real time. Diffuse indirect light (and the sky) comes from **VXGI baked per vertex**:
 * the cave and the draperies are voxelized, each source is injected alone at unit intensity, and a
 * `VertexLightMapper` accumulates `vxgiIrradiance` cones into its own vertex light map. The materials sum the three maps scaled by
 * the live levels, so the sliders and the fire flicker need no rebake. Two PMREM probes give the wet rock its
 * specular reflections; the mist (`HollowAtmosphere`) is lit by the same sources.
 */
export class HollowLighting {

  readonly sun: DirectionalLight
  readonly fire: PointLight
  readonly skyPortal: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  readonly uniforms: HollowLightUniforms
  /** Indirect irradiance (`lux`) per vertex (`aLightTexel`): the three bakes at the live levels. */
  readonly lightMapNode
  readonly lakeProbe: HollowEnvProbe = {center: new Vector3(), size: new Vector3(16, 8, 16)}
  readonly skyProbe: HollowEnvProbe = {center: new Vector3(), size: new Vector3(14, 10, 14)}
  lakeEnvMap: ReturnType<PMREMGenerator['fromCubemap']> | null = null
  skyEnvMap: ReturnType<PMREMGenerator['fromCubemap']> | null = null
  /** Bumped whenever the env map targets are (re)created; recaptures refill them in place. */
  envVersion = 0

  levels: HollowLightLevels = {...DEFAULT_HOLLOW_LIGHTS}

  private readonly field: HollowField
  private readonly scene: Scene
  private readonly atmosphere: HollowAtmosphere
  private readonly volume: VXGIVolume
  private readonly lightMaps: Record<HollowLightSource, RenderTarget>
  private lightMapper: VertexLightMapper | null = null
  private lightMapped: Mesh[] = []
  /** Rows of the vertex light maps (all the lit meshes' vertices). */
  private lightRows = 1
  private lightMapperDirty = true
  private portalVoxelized = false

  private readonly sunUnit = unitLuminance(SUN_KELVIN)
  private readonly skyUnit = toUnitLuminance(new Color().setRGB(...SKY_TINT))
  private readonly fireUnit = unitLuminance(FIRE_KELVIN)
  private readonly skyRadiance = uniform(DEFAULT_HOLLOW_LIGHTS.skyLuminance)
  private readonly fireBase = new Vector3()
  private readonly fireTint = new Color()
  private flickerPhases: number[] = []

  private renderer: WebGPURenderer | null = null
  private pmrem: PMREMGenerator | null = null
  private lakeEnvTarget: CubeRenderTarget | null = null
  private skyEnvTarget: CubeRenderTarget | null = null
  private lakeCube: CubeCamera | null = null
  private skyCube: CubeCamera | null = null
  /** The levels changed: recapture the specular probes on the next frame (a paused editor renders only then). */
  private envStale = false

  private bakeQueue: BakeStep[] = []
  private bakeTotal = 0
  private bakeDone = 0

  constructor(field: HollowField, scene: Scene, atmosphere: HollowAtmosphere, uniforms: HollowLightUniforms) {
    this.field = field
    this.scene = scene
    this.atmosphere = atmosphere
    this.uniforms = uniforms

    this.sun = new DirectionalLight(this.sunUnit, 0)
    this.sun.name = 'Sun'
    this.sun.castShadow = true
    this.sun.shadow.mapSize.setScalar(4096)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    // The geometry is static: the shadow is re-rendered only after a rebuild
    this.sun.shadow.autoUpdate = false

    this.fire = new PointLight(this.fireUnit, 0, 0, 2)
    this.fire.name = 'Hidden Fire'
    this.fire.castShadow = true
    // Blurred wide, so a coarse map will do
    this.fire.shadow.mapSize.setScalar(512)
    this.fire.shadow.camera.near = 0.35
    this.fire.shadow.camera.far = 40
    this.fire.shadow.bias = -0.0015
    this.fire.shadow.normalBias = 0.05
    // @types/three doesn't declare `LightShadow.filterNode` (three's shadow nodes read it)
    Object.assign(this.fire.shadow, {filterNode: createFireShadowFilter(this.fire.shadow)})

    this.skyPortal = this.createSkyPortal()

    this.volume = new VXGIVolume(VXGI_RESOLUTION)
    this.volume.layers.set(HOLLOW_GI_LAYER)
    this.volume.bounces = 2
    this.volume.directionalRadiance = true

    const createMap = (name: string) => {
      const target = new RenderTarget(VERTEX_LIGHT_WIDTH, 1, {
        type: HalfFloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter,
      })
      target.texture.name = name
      return target
    }
    this.lightMaps = {
      sun: createMap('Hollow Light Map Sun'),
      fire: createMap('Hollow Light Map Fire'),
      sky: createMap('Hollow Light Map Sky'),
    }
    this.lightMapNode = vertexLight(this.lightMaps.sun.texture).mul(this.uniforms.giSun)
      .add(vertexLight(this.lightMaps.sky.texture).mul(this.uniforms.giSky))
      .add(vertexLight(this.lightMaps.fire.texture).mul(this.uniforms.giFire))

    scene.add(this.sun, this.sun.target, this.fire, this.skyPortal)
    this.applyLevels()
  }

  /** The sky through the chimney: emits `skyLuminance` (the VXGI collector reads its unit `color`). */
  private createSkyPortal() {
    const material = new MeshBasicNodeMaterial({side: DoubleSide, color: this.skyUnit})
    material.name = 'Hollow Sky'
    material.colorNode = materialColor.mul(this.skyRadiance)
    const mesh = new Mesh(new PlaneGeometry(14, 14), material)
    mesh.name = 'Skylight Portal'
    mesh.rotation.x = Math.PI / 2
    mesh.layers.enable(HOLLOW_GI_LAYER)
    mesh.userData.selectable = false
    return mesh
  }

  initRenderer(renderer: WebGPURenderer) {
    if (this.renderer === renderer) return
    this.renderer = renderer
    this.disposeEnvMaps()
    this.pmrem?.dispose()
    this.lakeEnvTarget?.dispose()
    this.skyEnvTarget?.dispose()
    this.pmrem = new PMREMGenerator(renderer)
    this.lakeEnvTarget = new CubeRenderTarget(ENV_SIZE, {type: HalfFloatType})
    this.skyEnvTarget = new CubeRenderTarget(ENV_SIZE, {type: HalfFloatType})
    this.lakeEnvTarget.texture.name = 'Hollow Lake Probe Cube'
    this.skyEnvTarget.texture.name = 'Hollow Sky Probe Cube'
    this.lakeCube = new CubeCamera(0.2, 60, this.lakeEnvTarget)
    this.skyCube = new CubeCamera(0.2, 60, this.skyEnvTarget)
    this.lightMapperDirty = true
  }

  /** The meshes that get light maps (a texel per vertex, `aLightTexel`); call after every rebuild. */
  setLightMapped(meshes: Mesh[]) {
    this.lightMapped = meshes
    this.lightRows = vertexLightRows(assignLightTexels(meshes))
    for (const target of Object.values(this.lightMaps)) target.setSize(VERTEX_LIGHT_WIDTH, this.lightRows)
    this.lightMapperDirty = true
  }

  /** Aligns the rig, the GI volume and the specular probes to the seeded cavern. */
  syncToField() {
    const sky = this.field.skylightCenter
    this.skyPortal.position.set(sky.x, sky.y + 1.45, sky.z)
    this.skyPortal.updateMatrixWorld()
    this.fitSun()

    this.fireBase.copy(this.field.fireOrigin)
    const rand = createHollowRandom(this.field.params.seed * 7 + 3)
    this.flickerPhases = FLICKER_CYCLES.map(() => rand() * Math.PI * 2)

    this.volume.bounds.set(HOLLOW_MIN.clone(), HOLLOW_MAX.clone()).expandByPoint(
      new Vector3(sky.x, sky.y + 1.45 + 0.5, sky.z),
    )
    this.volume.needsUpdate = true

    const wl = this.field.params.waterLevel
    const lakeZ = this.field.lakeCenterZ
    this.lakeProbe.center.set(this.field.spineX(lakeZ), wl + 1.6, lakeZ)
    this.lakeProbe.size.set(
      13 * this.field.widthScale,
      Math.max(6, 2 * (this.field.ceilingHeightAt(this.lakeProbe.center.x, lakeZ, false) - wl)),
      16,
    )
    this.skyProbe.center.set(sky.x, Math.min(sky.y - 2.5, wl + 6.5), sky.z + 2.2)
    this.skyProbe.size.set(12 * this.field.widthScale, 10, 12)

    this.applyLevels()
  }

  /** Points the sun down the skylight shaft and fits its orthographic shadow camera around the whole cavern. */
  private fitSun() {
    const dir = this.field.skylightDirection
    const center = new Vector3().addVectors(HOLLOW_MIN, HOLLOW_MAX).multiplyScalar(0.5)
    const radius = HOLLOW_MAX.distanceTo(HOLLOW_MIN) * 0.5
    this.sun.target.position.copy(center)
    this.sun.position.copy(center).addScaledVector(dir, radius + 2)
    this.sun.target.updateMatrixWorld()
    this.sun.updateMatrixWorld()
    this.uniforms.sunDirection.value.copy(dir).normalize()

    const view = new Matrix4().lookAt(this.sun.position, center, new Vector3(0, 1, 0))
      .setPosition(this.sun.position).invert()
    const bounds = new Box3()
    const p = new Vector3()
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? HOLLOW_MAX.x : HOLLOW_MIN.x, i & 2 ? HOLLOW_MAX.y : HOLLOW_MIN.y, i & 4 ? HOLLOW_MAX.z : HOLLOW_MIN.z)
      bounds.expandByPoint(p.applyMatrix4(view))
    }
    const cam = this.sun.shadow.camera
    cam.left = bounds.min.x
    cam.right = bounds.max.x
    cam.bottom = bounds.min.y
    cam.top = bounds.max.y
    cam.near = Math.max(0.1, -bounds.max.z - 0.5)
    cam.far = -bounds.min.z + 0.5
    cam.updateProjectionMatrix()
    this.sun.shadow.needsUpdate = true
  }

  /** Sets the live levels (no rebake: the bakes are per unit source); the specular probes follow on the next frame. */
  setLevels(partial: Partial<HollowLightLevels>) {
    this.levels = {...this.levels, ...partial}
    this.applyLevels()
    this.envStale = true
  }

  private applyLevels() {
    const L = this.levels
    this.sun.color.copy(this.sunUnit)
    this.sun.intensity = L.sunIlluminance
    this.uniforms.sunColor.value.copy(this.sunUnit).multiplyScalar(L.sunIlluminance)
    this.uniforms.giSun.value = L.sunIlluminance
    this.skyRadiance.value = L.skyLuminance
    this.uniforms.giSky.value = L.skyLuminance
    this.skyPortal.visible = L.skyLuminance > 0
    this.setFire(L.fireIntensity, this.fireUnit, this.fireBase)
  }

  private setFire(intensity: number, color: Color, position: Vector3) {
    this.fire.intensity = intensity
    this.fire.color.copy(color)
    this.fire.position.copy(position)
    this.fire.updateMatrixWorld()
    this.uniforms.firePosition.value.copy(position)
    this.uniforms.fireColor.value.copy(color).multiplyScalar(intensity)
    // The fire bake used the mean unit tint: scale it per channel to the live tint and intensity
    const gi = this.uniforms.giFire.value
    gi.setRGB(color.r / this.fireUnit.r, color.g / this.fireUnit.g, color.b / this.fireUnit.b).multiplyScalar(intensity)
  }

  /** Flickers the fire from timeline `time`; periodic over `duration`. */
  updateFire(time: number, duration: number) {
    if (this.flickerPhases.length === 0) return
    const w = (Math.PI * 2) / Math.max(1e-3, duration)
    const partial = (k: number, offset: number) => Math.sin(FLICKER_CYCLES[k] * w * time + this.flickerPhases[k] + offset)
    // Slow breathing + faster licks, normalized to about ±1
    const breath = 0.55 * partial(0, 0) + 0.3 * partial(1, 0) + 0.15 * partial(2, 0)
    const lick = 0.45 * partial(3, 0) + 0.35 * partial(4, 0) + 0.2 * partial(5, 0)
    const flicker = 0.65 * breath + 0.35 * lick
    unitLuminance(FIRE_KELVIN + 250 * flicker, this.fireTint)
    const position = new Vector3(
      this.fireBase.x + 0.1 * partial(2, 1.3),
      this.fireBase.y + 0.1 * (0.5 * partial(3, 2.1) + 0.5 * partial(1, 0.4)),
      this.fireBase.z + 0.1 * partial(4, 4.2),
    )
    this.setFire(this.levels.fireIntensity * (1 + 0.22 * flicker), this.fireTint, position)
  }

  get baking() {
    return this.bakeQueue.length > 0
  }

  get bakeProgress() {
    if (!this.baking) return 1
    const current = this.bakeQueue[0]
    const partial = current.progress ? current.weight * current.progress() : 0
    return MathUtils.clamp((this.bakeDone + partial) / Math.max(1e-6, this.bakeTotal), 0, 0.99)
  }

  /**
   * Queues a full bake: clear, shadow maps, mist visibility, then per source (sun, fire, sky) inject + ambient +
   * light map, then the specular probes. Runs a step per frame in `stepBake`.
   */
  requestBake() {
    const steps: BakeStep[] = [
      {weight: 1, run: (renderer) => this.prime(renderer)},
      {weight: 1, run: (renderer) => this.atmosphere.bakeVisibility(renderer, this.sun, this.fire)},
    ]
    for (const source of HOLLOW_LIGHT_SOURCES) {
      steps.push({weight: 2, run: (renderer) => this.inject(renderer, source)})
      steps.push({
        weight: 10,
        run: (renderer) => this.accumulate(renderer, source),
        progress: () => (this.lightMapper?.samples ?? 0) / SAMPLES_PER_SOURCE,
      })
    }
    steps.push({weight: 1, run: (renderer) => this.captureEnvProbes(renderer)})
    this.bakeQueue = steps
    this.bakeTotal = steps.reduce((sum, step) => sum + step.weight, 0)
    this.bakeDone = 0
  }

  stepBake(renderer: WebGPURenderer) {
    if (this.baking) {
      const step = this.bakeQueue[0]
      if (step.run(renderer)) {
        this.bakeQueue.shift()
        this.bakeDone += step.weight
      }
    } else if (this.envStale) {
      this.captureEnvProbes(renderer)
    }
  }

  /** Clears the light maps and the mist and re-renders the sun's shadow in this frame (the geometry changed). */
  private prime(renderer: WebGPURenderer) {
    for (const target of Object.values(this.lightMaps)) {
      renderer.setRenderTarget(target)
      renderer.clear()
    }
    renderer.setRenderTarget(null)
    this.atmosphere.clear(renderer)
    this.sun.shadow.needsUpdate = true
    if (this.lightMapperDirty) {
      this.lightMapper?.dispose()
      this.lightMapper = new VertexLightMapper(renderer, this.lightRows, vxgiIrradiance(this.volume, {coneCount: 8}))
      this.lightMapper.addObjects(this.lightMapped)
      this.lightMapperDirty = false
    }
    return true
  }

  /**
   * Injects one source alone at unit intensity into the voxel volume, cone-traces the mist's ambient for it and
   * restarts the light map. Zero intensities isolate a source without changing the light set (no shader rebuilds);
   * the portal's emission is part of the voxelized triangles, so switching it re-voxelizes.
   */
  private inject(renderer: WebGPURenderer, source: HollowLightSource) {
    this.sun.intensity = source === 'sun' ? 1 : 0
    this.sun.color.copy(this.sunUnit)
    this.setFire(source === 'fire' ? 1 : 0, this.fireUnit, this.fireBase)
    const portal = this.skyPortal.material
    portal.color.copy(source === 'sky' ? this.skyUnit : new Color(0, 0, 0))
    const portalVisible = this.skyPortal.visible
    this.skyPortal.visible = true
    if (this.portalVoxelized !== (source === 'sky')) {
      this.volume.needsUpdate = true
      this.portalVoxelized = source === 'sky'
    }

    this.volume.update(renderer, this.scene)
    this.atmosphere.bakeAmbient(renderer, source, this.volume)

    portal.color.copy(this.skyUnit)
    this.skyPortal.visible = portalVisible
    this.applyLevels()
    this.lightMapper?.reset()
    return true
  }

  private accumulate(renderer: WebGPURenderer, source: HollowLightSource) {
    const mapper = this.lightMapper
    if (!mapper) return true
    mapper.update(Math.min(SAMPLES_PER_FRAME, SAMPLES_PER_SOURCE - mapper.samples))
    if (mapper.samples < SAMPLES_PER_SOURCE) return false
    renderer.copyTextureToTexture(mapper.texture, this.lightMaps[source].texture)
    return true
  }

  private disposeEnvMaps() {
    this.lakeEnvMap?.dispose()
    this.skyEnvMap?.dispose()
    this.lakeEnvMap = null
    this.skyEnvMap = null
    this.envVersion++
  }

  private captureEnvProbes(renderer: WebGPURenderer) {
    this.envStale = false
    if (!this.pmrem || !this.lakeCube || !this.skyCube || !this.lakeEnvTarget || !this.skyEnvTarget) return true

    this.lakeCube.position.copy(this.lakeProbe.center)
    this.skyCube.position.copy(this.skyProbe.center)
    this.lakeCube.updateMatrixWorld()
    this.skyCube.updateMatrixWorld()
    // The probes see the cave without its own reflections: rendering the previous probes into the next would keep
    // light alive after the lights go out (the env node scales by `scene.environmentIntensity`)
    const environmentIntensity = this.scene.environmentIntensity
    this.scene.environmentIntensity = 0
    this.lakeCube.update(renderer, this.scene)
    this.skyCube.update(renderer, this.scene)
    this.scene.environmentIntensity = environmentIntensity

    // Refilter into the same targets, so the materials keep their bindings (no rebuild, nothing disposed in use)
    const created = !this.lakeEnvMap || !this.skyEnvMap
    this.lakeEnvMap = this.pmrem.fromCubemap(this.lakeEnvTarget.texture, this.lakeEnvMap)
    this.skyEnvMap = this.pmrem.fromCubemap(this.skyEnvTarget.texture, this.skyEnvMap)
    if (created) this.envVersion++
    return true
  }

  /** The baked light maps (for inspection). */
  getLightMap(source: HollowLightSource): Texture {
    return this.lightMaps[source].texture
  }

  dispose() {
    this.disposeEnvMaps()
    this.lakeEnvTarget?.dispose()
    this.skyEnvTarget?.dispose()
    this.pmrem?.dispose()
    this.lightMapper?.dispose()
    for (const target of Object.values(this.lightMaps)) target.dispose()
    this.volume.dispose()
    this.skyPortal.geometry.dispose()
    this.skyPortal.material.dispose()
  }
}
