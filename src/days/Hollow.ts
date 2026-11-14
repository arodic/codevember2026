import {
  ACESFilmicToneMapping, Box3, BufferGeometry, Color, Group, MathUtils, Mesh, PerspectiveCamera, UniformNode, Vector3,
  WebGPURenderer,
} from 'three/webgpu'
import {uniform} from 'three/tsl'
import {Register, Property, Field, div} from '@io-gui/core'
import {Bloom, Document, DocumentProps, FrameTarget, Timeline} from '@io-gui/three'
import {registerEditor} from '@io-gui/editors'
import {ioNumberSlider} from '@io-gui/sliders'
import {ioOptionSelect, Menu} from '@io-gui/menus'
import type {CaptureDefaults, CaptureOptions} from '../Capture.js'
import {TimelineFade} from '../TimelineFade.js'
import {DEFAULT_HOLLOW_PARAMS, HollowField, createHollowRandom} from './hollow/HollowField.js'
import {buildHollowLakeGeometry, buildRimstonePoolGeometry} from './hollow/HollowLake.js'
import {placeHollowRocks} from './hollow/HollowRocks.js'
import {buildHollowSpeleothems} from './hollow/HollowSpeleothems.js'
import {HollowSculptPool} from './hollow/HollowSculptPool.js'
import {SCULPT_CALCITE_GROUP, SCULPT_ROCK_GROUP, clusterSurface} from './hollow/HollowSculpt.js'
import {
  DEFAULT_HOLLOW_LIGHTS, HOLLOW_GI_LAYER, HollowLighting, createHollowLightUniforms,
} from './hollow/HollowLighting.js'
import {HollowWater, HollowWaterMaterial} from './hollow/HollowWater.js'
import {HollowAtmosphere} from './hollow/HollowAtmosphere.js'
import {
  HollowLitMaterial, bakeRockDetailAtlas, bakeTravertineAtlas, createHollowRockMaterial,
} from './hollow/HollowMaterial.js'

const DURATION = 90
const FADE_SECONDS = 2.5
/** Cluster size (`m`) of the cave's stand-in for the GI voxelizer: under its sub-voxels (`~11 cm`). */
const GI_PROXY_CELL = 0.06

export const HOLLOW_CAMERA_MODES = ['Cinema', 'Cutaway Overview'] as const
export type HollowCameraMode = typeof HOLLOW_CAMERA_MODES[number]

export const HOLLOW_BLOCKOUT_STYLES = ['Lit Rock', 'Geological Zones'] as const
export type HollowBlockoutStyle = typeof HOLLOW_BLOCKOUT_STYLES[number]

const CUTAWAY_POSE = {
  position: new Vector3(16.5, 13.2, 13.5),
  target: new Vector3(-0.8, 1.8, -8.5),
  fov: 44,
}

/**
 * Codevember day 7, **Hollow**:
 * Procedural karst cavern for `2.39:1` widescreen, lit physically: a shadowed sun down the skylight chimney, the sky
 * seen through it and a shadowed fire flickering behind the camera, nothing else. Diffuse GI is VXGI baked into light
 * maps per source (so the light levels stay live); a refracting, absorbing lake mirrors the cave and ripples under
 * falling drops on the GPU; the mist is a participating medium lit by the same sources.
 */
@Register
export class Hollow extends Document implements CaptureDefaults {

  @Property({type: String, value: 'Cinema'})
  declare cameraMode: HollowCameraMode

  @Property({type: String, value: 'Lit Rock'})
  declare blockoutStyle: HollowBlockoutStyle

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.seed})
  declare seed: number

  @Property({type: Number, value: 39})
  declare cameraFov: number

  @Property({type: Number, value: 1.68})
  declare cameraHeight: number

  /** Forward dolly travel (`m`) over the 90 s shot. */
  @Property({type: Number, value: 1.10})
  declare trackForward: number

  /** Lateral camera track (`m`) over the 90 s shot. */
  @Property({type: Number, value: -0.42})
  declare trackLateral: number

  /** Subtle pan of the look target (`m`) across the shot. */
  @Property({type: Number, value: 0.22})
  declare trackLookDrift: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.cavernWidth})
  declare cavernWidth: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.vaultHeight})
  declare vaultHeight: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.meander})
  declare meander: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.strataStrength})
  declare strataStrength: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.skylightSize})
  declare skylightSize: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.terraceSteps})
  declare terraceSteps: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.waterLevel})
  declare waterLevel: number

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.rimstoneScale})
  declare rimstoneScale: number

  @Property({type: Number, value: 1.0})
  declare stalactiteDensity: number

  @Property({type: Number, value: 1.0})
  declare stalagmiteDensity: number

  @Property({type: Number, value: 1.0})
  declare draperyScale: number

  @Property({type: Number, value: 10})
  declare boulderCount: number

  /** Read-only GI bake progress (`0..1`). */
  @Property({type: Number, value: 0})
  declare bakeProgress: number

  /** Sun illuminance down the chimney (scene units, ~1 klx each). */
  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.sunIlluminance})
  declare sunIlluminance: number

  /** Luminance of the sky seen through the chimney. */
  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.skyLuminance})
  declare skyLuminance: number

  /** Mean luminous intensity of the fire behind the camera. */
  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.fireIntensity})
  declare fireIntensity: number

  /** Scattering coefficient (`1/m`) of the mist over the water. */
  @Property({type: Number, value: 0.03})
  declare mistDensity: number

  declare private camera: PerspectiveCamera
  declare private field: HollowField
  declare private hollowLighting: HollowLighting
  declare private water: HollowWater
  declare private atmosphere: HollowAtmosphere
  declare private caveGroup: Group
  /** The light-mapped meshes (a light map texel per vertex). */
  declare private litGroup: Group
  /** The cave with its boulders, dripstones and draperies: one surface (`HollowSculpt`), rock and calcite groups. */
  declare private caveMesh: Mesh<BufferGeometry, HollowLitMaterial[]>
  /** The cave as the GI voxelizer sees it: coarser (`clusterSurface`), in its layer only. */
  declare private giMesh: Mesh<BufferGeometry, HollowLitMaterial>
  declare private sculptPool: HollowSculptPool
  declare private lakeMesh: Mesh<BufferGeometry, HollowWaterMaterial>
  declare private rimstonePoolMesh: Mesh<BufferGeometry, HollowWaterMaterial>
  /** The rock; the translucent calcite of the drapery sheets. */
  declare private rockMaterial: HollowLitMaterial
  declare private calciteMaterial: HollowLitMaterial
  declare private styleModeUniform: UniformNode<'float', number>
  declare private waterLevelUniform: UniformNode<'float', number>
  declare private dripEmitters: Vector3[]
  declare private caveDirty: boolean
  /** The workers are meshing a new cave (no bake until it arrives). */
  declare private sculpting: boolean
  declare private envVersion: number
  declare private _poseAppliedForSeed: number | undefined

  @Field(null)
  declare private _frameTarget: FrameTarget | null

  constructor(args?: DocumentProps) {
    super({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 0.8,
      timeline: new Timeline({autoplay: true, duration: DURATION, loop: true}),
      effects: [
        new Bloom({strength: 0.18, radius: 0.45, threshold: 1.1}),
        new TimelineFade({fadeIn: FADE_SECONDS, fadeOut: FADE_SECONDS, color: new Color(0, 0, 0)}),
      ],
      ...args,
    })

    this.camera = new PerspectiveCamera(this.cameraFov, 2.39, 0.15, 90)
    this.camera.name = 'Camera'
    this.activeCamera = this.camera

    // The cave is closed but for the chimney, whose mouth the sky portal covers: nothing should show the background
    this.scene.background = new Color(0x000000)

    this.field = new HollowField()
    this.styleModeUniform = uniform(this.blockoutStyle === 'Geological Zones' ? 1 : 0)
    this.waterLevelUniform = uniform(this.waterLevel)
    this.dripEmitters = []
    this.caveDirty = false
    this.sculpting = false
    this.envVersion = -1
    this.bakeProgress = 0

    const lightUniforms = createHollowLightUniforms()
    this.atmosphere = new HollowAtmosphere(lightUniforms, this.waterLevelUniform)
    this.atmosphere.density.value = this.mistDensity
    this.atmosphere.applyFog(this.scene)
    this.hollowLighting = new HollowLighting(this.field, this.scene, this.atmosphere, lightUniforms)
    this.water = new HollowWater(this.field, this.atmosphere)
    this.scene.add(this.water.dropletMesh)

    const rockAtlas = bakeRockDetailAtlas(1024)
    const travertineAtlas = bakeTravertineAtlas(1024)
    const rock = {
      rockAtlas,
      travertineAtlas,
      styleMode: this.styleModeUniform,
      lightMapNode: this.hollowLighting.lightMapNode,
    }
    this.rockMaterial = createHollowRockMaterial({...rock, name: 'Hollow Karst Rock'})
    this.calciteMaterial = createHollowRockMaterial({
      ...rock,
      name: 'Hollow Calcite',
      translucency: {atmosphere: this.atmosphere, lights: lightUniforms},
    })

    this.caveGroup = new Group()
    this.caveGroup.name = 'Hollow Cavern'
    this.scene.add(this.caveGroup)
    this.litGroup = new Group()
    this.litGroup.name = 'Light-Mapped Rock'

    const materials: HollowLitMaterial[] = []
    materials[SCULPT_ROCK_GROUP] = this.rockMaterial
    materials[SCULPT_CALCITE_GROUP] = this.calciteMaterial
    this.caveMesh = new Mesh(new BufferGeometry(), materials)
    this.caveMesh.name = 'Cavern'
    this.caveMesh.castShadow = true
    this.caveMesh.receiveShadow = true
    this.giMesh = new Mesh(new BufferGeometry(), this.rockMaterial)
    this.giMesh.name = 'Cavern GI Proxy'
    this.giMesh.layers.set(HOLLOW_GI_LAYER)
    this.litGroup.add(this.caveMesh, this.giMesh)
    this.sculptPool = new HollowSculptPool()

    this.lakeMesh = new Mesh(new BufferGeometry(), this.water.lakeMaterial)
    this.lakeMesh.name = 'Meandering Lake'
    this.lakeMesh.receiveShadow = true
    // Reflector target must be parented to the mesh that samples it (three.js mirror pattern)
    this.lakeMesh.add(this.water.lakeReflector.target)

    this.rimstonePoolMesh = new Mesh(new BufferGeometry(), this.water.rimstoneMaterial)
    this.rimstonePoolMesh.name = 'Rimstone Pool'
    this.rimstonePoolMesh.receiveShadow = true

    this.caveGroup.add(this.litGroup, this.lakeMesh, this.rimstonePoolMesh)

    const frameBox = new Box3(new Vector3(-10, -1.5, -23), new Vector3(8, 8.5, 7))
    this._frameTarget = new Mesh(new BufferGeometry().setFromPoints([frameBox.min, frameBox.max]))

    this.rebuildCave()
    this.updateCamera(this.timeline.currentTime)
  }

  override getEditorFrameTarget() {
    return this._frameTarget
  }

  /** Six seconds of preroll, so drops are falling and ripples spreading by the first saved frame. */
  getCaptureDefaults(): CaptureOptions {
    return {preroll: 6}
  }

  override onRendererInitialized(renderer: WebGPURenderer) {
    this.hollowLighting.initRenderer(renderer)
    // Also while the cave is on its way: the bake creates the mist's and the GI's volumes the materials sample (it
    // bakes again when the cave arrives)
    this.hollowLighting.requestBake()
    this.bakeProgress = 0
  }

  private markCaveDirty() {
    if (!this.caveGroup) return
    this.caveDirty = true
    this.notify({kind: 'geometry'})
  }

  seedChanged() { this.markCaveDirty() }
  cavernWidthChanged() { this.markCaveDirty() }
  vaultHeightChanged() { this.markCaveDirty() }
  meanderChanged() { this.markCaveDirty() }
  strataStrengthChanged() { this.markCaveDirty() }
  skylightSizeChanged() { this.markCaveDirty() }
  terraceStepsChanged() { this.markCaveDirty() }
  waterLevelChanged() {
    if (this.waterLevelUniform) this.waterLevelUniform.value = this.waterLevel
    this.markCaveDirty()
  }
  rimstoneScaleChanged() { this.markCaveDirty() }
  stalactiteDensityChanged() { this.markCaveDirty() }
  stalagmiteDensityChanged() { this.markCaveDirty() }
  draperyScaleChanged() { this.markCaveDirty() }
  boulderCountChanged() { this.markCaveDirty() }

  blockoutStyleChanged() {
    if (!this.styleModeUniform) return
    this.styleModeUniform.value = this.blockoutStyle === 'Geological Zones' ? 1 : 0
    this.notify({kind: 'material'})
  }

  cameraModeChanged() { this.refreshCamera() }
  cameraFovChanged() { this.refreshCamera() }
  cameraHeightChanged() { this.refreshCamera() }
  trackForwardChanged() { this.refreshCamera() }
  trackLateralChanged() { this.refreshCamera() }
  trackLookDriftChanged() { this.refreshCamera() }

  private refreshCamera() {
    if (!this.camera) return
    this.updateCamera(this.timeline.currentTime)
    this.notify({kind: 'other'})
  }

  randomizeSeed() {
    const rand = createHollowRandom(this.seed + Math.floor(performance.now()))
    this.seed = Math.floor(rand() * 9999) + 1
  }

  rebakeLighting() {
    this.hollowLighting.requestBake()
    this.bakeProgress = 0
    this.notify({kind: 'other'})
  }

  private applyLightLevels() {
    if (!this.hollowLighting) return
    this.hollowLighting.setLevels({
      sunIlluminance: this.sunIlluminance,
      skyLuminance: this.skyLuminance,
      fireIntensity: this.fireIntensity,
    })
    this.notify({kind: 'other'})
  }

  sunIlluminanceChanged() { this.applyLightLevels() }
  skyLuminanceChanged() { this.applyLightLevels() }
  fireIntensityChanged() { this.applyLightLevels() }
  mistDensityChanged() {
    if (!this.atmosphere) return
    this.atmosphere.density.value = this.mistDensity
    this.notify({kind: 'other'})
  }

  goFullscreen() {
    this.dispatch('go-fullscreen', {}, true)
  }

  /**
   * Places the bodies and meshes the cave on the sculpt workers (seconds); the old cave stays until the new one
   * arrives, then everything that follows the field (water, lights, mist, camera pose) switches with it.
   */
  private rebuildCave() {
    this.caveDirty = false
    const params = {
      seed: this.seed,
      cavernWidth: this.cavernWidth,
      vaultHeight: this.vaultHeight,
      meander: this.meander,
      strataStrength: this.strataStrength,
      skylightSize: this.skylightSize,
      terraceSteps: this.terraceSteps,
      rimstoneScale: this.rimstoneScale,
      waterLevel: this.waterLevel,
    }
    // Placed against a field of their own: this one keeps serving the cave on screen meanwhile
    const field = new HollowField(params)
    const speleothems = buildHollowSpeleothems(field, {
      stalactiteDensity: this.stalactiteDensity,
      stalagmiteDensity: this.stalagmiteDensity,
      draperyScale: this.draperyScale,
    })
    const bodies = [...placeHollowRocks(field, Math.round(this.boulderCount)), ...speleothems.bodies]
    this.bakeProgress = 0
    this.sculpting = true
    this.sculptPool.build(field, bodies).then((cave) => {
      if (!cave) return
      this.sculpting = false
      this.field.configure(params)
      this.dripEmitters = speleothems.dripEmitters
      this.caveMesh.geometry.dispose()
      this.caveMesh.geometry = cave
      this.giMesh.geometry.dispose()
      this.giMesh.geometry = clusterSurface(cave, GI_PROXY_CELL)
      this.hollowLighting.setLightMapped([this.caveMesh])
      this.applyField()
    }, (error) => console.error(error))
  }

  /** Everything that follows the field: water, lights, mist, the seed's camera pose; then a fresh bake. */
  private applyField() {
    const nextLakeGeo = buildHollowLakeGeometry(this.field)
    this.lakeMesh.geometry.dispose()
    this.lakeMesh.geometry = nextLakeGeo

    const nextRimGeo = buildRimstonePoolGeometry(this.field)
    this.rimstonePoolMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry = nextRimGeo
    this.rimstonePoolMesh.visible = this.rimstoneScale > 0.05

    this.water.syncToField(this.dripEmitters, this.timeline.duration)
    this.hollowLighting.syncToField()
    this.atmosphere.syncToField(this.field)

    const pose = this.field.cinemaPose
    if (!this._poseAppliedForSeed || this._poseAppliedForSeed !== this.seed) {
      this.cameraFov = Math.round(pose.fov * 2) / 2
      this.cameraHeight = Math.round(pose.height * 50) / 50
      this.trackForward = Math.round(this.field.cinemaTracks.forward * 20) / 20
      this.trackLateral = Math.round(this.field.cinemaTracks.lateral * 20) / 20
      this.trackLookDrift = Math.round(this.field.cinemaTracks.lookDrift * 20) / 20
      this._poseAppliedForSeed = this.seed
    }
    this.updateCamera(this.timeline.currentTime)

    this.hollowLighting.requestBake()
    this.bakeProgress = 0
    this.notify({kind: 'geometry'})
  }

  private updateCamera(time: number) {
    if (!this.camera) return

    if (this.cameraMode === 'Cutaway Overview') {
      if (this.camera.fov !== CUTAWAY_POSE.fov) {
        this.camera.fov = CUTAWAY_POSE.fov
        this.camera.updateProjectionMatrix()
      }
      this.camera.position.copy(CUTAWAY_POSE.position)
      this.camera.lookAt(CUTAWAY_POSE.target)
      return
    }

    if (this.camera.fov !== this.cameraFov) {
      this.camera.fov = this.cameraFov
      this.camera.updateProjectionMatrix()
    }

    const duration = Math.max(1e-3, this.timeline.duration)
    const rawU = MathUtils.clamp(time / duration, 0.0, 1.0)
    const easedU = rawU - Math.sin(rawU * Math.PI * 2) * 0.025

    const pose = this.field.cinemaPose
    const startX = pose.startX
    const startZ = pose.startZ
    const baseY = this.waterLevel + this.cameraHeight

    const camX = startX + this.trackLateral * (easedU - 0.5)
    const camZ = startZ - this.trackForward * (easedU - 0.5)

    const benchFloor = this.field.floorHeightAt(camX, camZ, true)
    const camY = Math.max(baseY, benchFloor + 0.42)

    const targetX = pose.targetX + this.trackLookDrift * (easedU - 0.5)
    const targetY = this.waterLevel + pose.targetY
    const targetZ = pose.targetZ

    this.camera.position.set(camX, camY, camZ)
    this.camera.lookAt(targetX, targetY, targetZ)
  }

  override onAnimate(delta: number, time: number) {
    this.updateCamera(time)
    const duration = this.timeline.duration
    this.hollowLighting.updateFire(time, duration)
    this.water.animate(delta, time, duration)
  }

  override onBeforeDraw(renderer: WebGPURenderer, delta: number) {
    if (this.caveDirty) {
      this.rebuildCave()
      this.updateCamera(this.timeline.currentTime)
    }

    // The indirect light at this frame's levels first: the probe capture below renders with it
    this.atmosphere.update(renderer, this.timeline.currentTime, this.timeline.duration)

    const lighting = this.hollowLighting
    const wasBaking = lighting.baking
    lighting.stepBake(renderer)
    if (wasBaking && !this.sculpting) {
      this.bakeProgress = lighting.bakeProgress
      this.notify({kind: 'other'})
    }
    if (lighting.envVersion !== this.envVersion) {
      this.envVersion = lighting.envVersion
      const lake = lighting.lakeEnvMap ? {map: lighting.lakeEnvMap.texture, probe: lighting.lakeProbe} : null
      const sky = lighting.skyEnvMap ? {map: lighting.skyEnvMap.texture, probe: lighting.skyProbe} : null
      const lit = [this.rockMaterial, this.calciteMaterial]
      for (const material of [...lit, this.water.rimstoneMaterial, this.water.dropletMaterial]) {
        material.setEnv(lake, sky)
      }
      this.notify({kind: 'material'})
    }

    this.water.step(renderer, delta)
  }

  override dispose() {
    this.sculptPool.dispose()
    this.caveMesh.geometry.dispose()
    this.giMesh.geometry.dispose()
    this.lakeMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry.dispose()
    this.rockMaterial.dispose()
    this.calciteMaterial.dispose()
    this.water.dispose()
    this.atmosphere.dispose()
    this.hollowLighting.dispose()
    super.dispose()
  }
}

registerEditor(Hollow, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, 'Codevember 2026: Hollow by @arodic & cogs'),
  widgets: [
    ['cameraMode', ioOptionSelect({model: new Menu({options: [...HOLLOW_CAMERA_MODES]})}), {label: 'camera'}],
    ['blockoutStyle', ioOptionSelect({model: new Menu({options: [...HOLLOW_BLOCKOUT_STYLES]})}), {label: 'style'}],
    ['seed', ioNumberSlider({min: 1, max: 9999, step: 1})],
    ['bakeProgress', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'bake'}],
    ['cameraFov', ioNumberSlider({min: 24, max: 65, step: 0.5}), {label: 'fov'}],
    ['cameraHeight', ioNumberSlider({min: 0.6, max: 3.5, step: 0.02}), {label: 'height'}],
    ['trackForward', ioNumberSlider({min: -3.0, max: 3.0, step: 0.05}), {label: 'dolly'}],
    ['trackLateral', ioNumberSlider({min: -2.5, max: 2.5, step: 0.05}), {label: 'truck'}],
    ['trackLookDrift', ioNumberSlider({min: -1.5, max: 1.5, step: 0.05}), {label: 'pan'}],
    ['cavernWidth', ioNumberSlider({min: 0.65, max: 1.45, step: 0.01}), {label: 'width'}],
    ['vaultHeight', ioNumberSlider({min: 0.7, max: 1.45, step: 0.01}), {label: 'vault'}],
    ['meander', ioNumberSlider({min: 0.0, max: 1.6, step: 0.02})],
    ['strataStrength', ioNumberSlider({min: 0.0, max: 2.0, step: 0.02}), {label: 'strata'}],
    ['skylightSize', ioNumberSlider({min: 0.5, max: 1.6, step: 0.02}), {label: 'skylight'}],
    ['terraceSteps', ioNumberSlider({min: 4, max: 18, step: 1}), {label: 'steps'}],
    ['waterLevel', ioNumberSlider({min: -0.6, max: 0.6, step: 0.01}), {label: 'water'}],
    ['rimstoneScale', ioNumberSlider({min: 0.0, max: 1.5, step: 0.02}), {label: 'rimstone'}],
    ['stalactiteDensity', ioNumberSlider({min: 0.0, max: 2.0, step: 0.05}), {label: 'stalactites'}],
    ['stalagmiteDensity', ioNumberSlider({min: 0.0, max: 2.0, step: 0.05}), {label: 'stalagmites'}],
    ['draperyScale', ioNumberSlider({min: 0.0, max: 1.8, step: 0.05}), {label: 'draperies'}],
    ['boulderCount', ioNumberSlider({min: 0, max: 24, step: 1}), {label: 'boulders'}],
    ['sunIlluminance', ioNumberSlider({min: 0, max: 200, step: 1}), {label: 'sun'}],
    ['skyLuminance', ioNumberSlider({min: 0, max: 20, step: 0.1}), {label: 'sky'}],
    ['fireIntensity', ioNumberSlider({min: 0, max: 800, step: 5}), {label: 'fire'}],
    ['mistDensity', ioNumberSlider({min: 0, max: 0.2, step: 0.002}), {label: 'mist'}],
  ],
  groups: {
    Main: ['goFullscreen', 'cameraMode', 'blockoutStyle', 'seed', 'randomizeSeed', 'rebakeLighting', 'bakeProgress'],
    Lights: ['sunIlluminance', 'skyLuminance', 'fireIntensity', 'mistDensity'],
    Camera: ['cameraFov', 'cameraHeight', 'trackForward', 'trackLateral', 'trackLookDrift'],
    Cavern: ['cavernWidth', 'vaultHeight', 'meander', 'strataStrength', 'skylightSize', 'terraceSteps'],
    Features: ['waterLevel', 'rimstoneScale', 'stalactiteDensity', 'stalagmiteDensity', 'draperyScale', 'boulderCount'],
    Hidden: [
      'camera', 'field', 'hollowLighting', 'water', 'atmosphere', 'caveGroup', 'litGroup', 'caveMesh', 'giMesh',
      'sculptPool', 'lakeMesh', 'rimstonePoolMesh', 'rockMaterial', 'calciteMaterial',
      'styleModeUniform', 'waterLevelUniform',
      'dripEmitters', 'caveDirty', 'sculpting', 'envVersion', '_poseAppliedForSeed', '_frameTarget',
    ],
  },
})
