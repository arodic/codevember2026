import {
  ACESFilmicToneMapping, Box3, BufferGeometry, Color, DoubleSide, Group, MathUtils, Mesh, MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial, PerspectiveCamera, PlaneGeometry, UniformNode, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {color, mix, positionLocal, saturate, uniform} from 'three/tsl'
import {Register, Property, Field, div} from '@io-gui/core'
import {Document, DocumentProps, FrameTarget, Timeline} from '@io-gui/three'
import {registerEditor} from '@io-gui/editors'
import {ioNumberSlider} from '@io-gui/sliders'
import {ioOptionSelect, Menu} from '@io-gui/menus'
import {
  DEFAULT_HOLLOW_PARAMS, HollowField, RIMSTONE_POOL_STEP, createHollowRandom,
} from './hollow/HollowField.js'
import {
  buildHollowLakeGeometry, buildHollowShellGeometry, buildRimstonePoolGeometry,
} from './hollow/HollowShell.js'
import {buildHollowRocks} from './hollow/HollowRocks.js'
import {buildHollowSpeleothems} from './hollow/HollowSpeleothems.js'
import {DEFAULT_HOLLOW_LIGHTS, HollowLighting} from './hollow/HollowLighting.js'
import {HollowWater} from './hollow/HollowWater.js'
import {HollowVolumetrics} from './hollow/HollowVolumetrics.js'
import {
  HollowLightMappedMaterial, applyHollowRockEnv, bakeRockDetailAtlas, bakeTravertineAtlas, createHollowRockMaterial,
} from './hollow/HollowMaterial.js'

const DURATION = 90

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
 * Procedural karst cavern for `2.39:1` widescreen — Phase 2 `LightProbeGrid` GI, static fire area (bake) + point
 * (realtime), planar lake, volumetric skylight shafts, wet clearcoat limestone. Bloom/fade off while tuning lights.
 */
@Register
export class Hollow extends Document {

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

  /** Read-only dual-grid GI bake progress (`0..1`). */
  @Property({type: Number, value: 0})
  declare bakeProgress: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.skylightIntensity})
  declare skylightIntensity: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.skyAreaIntensity})
  declare skyAreaIntensity: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.firePointIntensity})
  declare firePointIntensity: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.fireAreaIntensity})
  declare fireAreaIntensity: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.fillIntensity})
  declare fillIntensity: number

  @Property({type: Number, value: DEFAULT_HOLLOW_LIGHTS.probeIntensity})
  declare probeIntensity: number

  declare private camera: PerspectiveCamera
  declare private field: HollowField
  declare private hollowLighting: HollowLighting
  declare private water: HollowWater
  declare private volumetrics: HollowVolumetrics
  declare private caveGroup: Group
  declare private shellMesh: Mesh<BufferGeometry, HollowLightMappedMaterial>
  declare private rocksMesh: Mesh<BufferGeometry, HollowLightMappedMaterial>
  declare private speleothemsMesh: Mesh<BufferGeometry, HollowLightMappedMaterial>
  declare private lakeMesh: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  declare private rimstonePoolMesh: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  declare private skyPortalMesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  declare private rockMaterial: HollowLightMappedMaterial
  declare private styleModeUniform: UniformNode<'float', number>
  declare private waterLevelUniform: UniformNode<'float', number>
  declare private dripEmitters: Vector3[]
  declare private caveDirty: boolean
  declare private envApplied: boolean
  declare private _poseAppliedForSeed: number | undefined
  declare private _lastAnimateTime: number

  @Field(null)
  declare private _frameTarget: FrameTarget | null

  constructor(args?: DocumentProps) {
    super({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1.05,
      timeline: new Timeline({autoplay: true, duration: DURATION, loop: true}),
      // Bloom + TimelineFade off while lighting is tuned
      effects: [],
      ...args,
    })

    this.camera = new PerspectiveCamera(this.cameraFov, 2.39, 0.15, 90)
    this.camera.name = 'Camera'
    this.activeCamera = this.camera

    // Pure black so zero-light bakes / isolation aren't lifted by a teal clear color
    this.scene.background = new Color(0x000000)

    this.field = new HollowField()
    this.styleModeUniform = uniform(this.blockoutStyle === 'Geological Zones' ? 1 : 0)
    this.waterLevelUniform = uniform(this.waterLevel)
    this.dripEmitters = []
    this.caveDirty = false
    this.envApplied = false
    this._lastAnimateTime = 0
    this.bakeProgress = 0

    this.hollowLighting = new HollowLighting(this.field, this.scene)
    this.water = new HollowWater(this.field, this.hollowLighting.skyEmitter)
    this.volumetrics = new HollowVolumetrics(this.waterLevelUniform, this.hollowLighting.skyEmitter)
    // Fog off while lighting is tuned
    this.scene.fogNode = null

    this.skyPortalMesh = this.createSkyPortal()
    this.scene.add(this.skyPortalMesh)
    this.scene.add(this.volumetrics.shaftMesh)
    this.scene.add(this.water.dropletMesh)

    const rockAtlas = bakeRockDetailAtlas(1024)
    const travertineAtlas = bakeTravertineAtlas(1024)
    this.rockMaterial = createHollowRockMaterial({
      field: this.field,
      lighting: this.hollowLighting,
      rockAtlas,
      travertineAtlas,
      styleMode: this.styleModeUniform,
      waterLevel: this.waterLevelUniform,
    })

    this.caveGroup = new Group()
    this.caveGroup.name = 'Hollow Cavern'
    this.scene.add(this.caveGroup)

    this.shellMesh = new Mesh(new BufferGeometry(), this.rockMaterial)
    this.shellMesh.name = 'Cavern Shell'
    this.shellMesh.castShadow = true
    this.shellMesh.receiveShadow = true

    this.rocksMesh = new Mesh(new BufferGeometry(), this.rockMaterial)
    this.rocksMesh.name = 'Cleaved Boulders'
    this.rocksMesh.castShadow = true
    this.rocksMesh.receiveShadow = true

    this.speleothemsMesh = new Mesh(new BufferGeometry(), this.rockMaterial)
    this.speleothemsMesh.name = 'Speleothems'
    this.speleothemsMesh.castShadow = true
    this.speleothemsMesh.receiveShadow = true

    this.lakeMesh = new Mesh(new BufferGeometry(), this.water.lakeMaterial)
    this.lakeMesh.name = 'Meandering Lake'
    this.lakeMesh.receiveShadow = true
    // Reflector target must be parented to the mesh that samples it (three.js mirror pattern)
    this.lakeMesh.add(this.water.lakeReflector.target)

    this.rimstonePoolMesh = new Mesh(new BufferGeometry(), this.water.rimstoneMaterial)
    this.rimstonePoolMesh.name = 'Rimstone Pool'
    this.rimstonePoolMesh.receiveShadow = true

    this.caveGroup.add(
      this.shellMesh,
      this.rocksMesh,
      this.speleothemsMesh,
      this.lakeMesh,
      this.rimstonePoolMesh,
    )

    const frameBox = new Box3(new Vector3(-10, -1.5, -23), new Vector3(8, 8.5, 7))
    this._frameTarget = new Mesh(new BufferGeometry().setFromPoints([frameBox.min, frameBox.max]))

    this.rebuildCave()
    this.updateCamera(this.timeline.currentTime)
  }

  override getEditorFrameTarget() {
    return this._frameTarget
  }

  override onRendererInitialized(renderer: WebGPURenderer) {
    this.hollowLighting.initRenderer(renderer)
    this.hollowLighting.requestBake()
    this.envApplied = false
    this.bakeProgress = 0
  }

  private createSkyPortal() {
    const mat = new MeshBasicNodeMaterial({side: DoubleSide})
    mat.fog = false
    const radial = saturate(positionLocal.xy.length().div(5.5))
    const skyCore = color(0x96cfdc).mul(3.4)
    const skyEdge = color(0x3998d1).mul(1.8)
    // Scales with sky light levels — off when both skylight + sky area are zero
    mat.colorNode = mix(skyCore, skyEdge, radial).mul(this.hollowLighting.skyEmitter)

    const mesh = new Mesh(new PlaneGeometry(14, 14), mat)
    mesh.name = 'Skylight Portal'
    mesh.rotation.x = Math.PI / 2
    mesh.userData.selectable = false
    return mesh
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
    this.applyLightLevels()
    // Drop previous IBL immediately so the frame (and next bake) don't keep old light
    applyHollowRockEnv(this.rockMaterial, null, null, this.field)
    this.hollowLighting.clearEnvMaps()
    this.hollowLighting.requestBake()
    this.envApplied = false
    this.bakeProgress = 0
    this.notify({kind: 'other'})
  }

  private applyLightLevels() {
    if (!this.hollowLighting) return
    this.hollowLighting.setLevels({
      skylightIntensity: this.skylightIntensity,
      skyAreaIntensity: this.skyAreaIntensity,
      firePointIntensity: this.firePointIntensity,
      fireAreaIntensity: this.fireAreaIntensity,
      fillIntensity: this.fillIntensity,
      probeIntensity: this.probeIntensity,
    })
    if (this.skyPortalMesh) {
      const skyOn = this.hollowLighting.skyLightsOn
      this.skyPortalMesh.visible = skyOn
      if (this.volumetrics?.shaftMesh) this.volumetrics.shaftMesh.visible = skyOn
    }
  }

  skylightIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }
  skyAreaIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }
  firePointIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }
  fireAreaIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }
  fillIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }
  probeIntensityChanged() { this.applyLightLevels(); this.notify({kind: 'other'}) }

  goFullscreen() {
    this.dispatch('go-fullscreen', {}, true)
  }

  private rebuildCave() {
    this.caveDirty = false

    this.field.configure({
      seed: this.seed,
      cavernWidth: this.cavernWidth,
      vaultHeight: this.vaultHeight,
      meander: this.meander,
      strataStrength: this.strataStrength,
      skylightSize: this.skylightSize,
      terraceSteps: this.terraceSteps,
      rimstoneScale: this.rimstoneScale,
      waterLevel: this.waterLevel,
    })

    const rockSet = buildHollowRocks(this.field, Math.round(this.boulderCount))
    this.field.setBoulderProxies(rockSet.proxies)
    this.field.rebuildVolumeTexture()

    const nextShellGeo = buildHollowShellGeometry(this.field)
    this.shellMesh.geometry.dispose()
    this.shellMesh.geometry = nextShellGeo

    this.rocksMesh.geometry.dispose()
    this.rocksMesh.geometry = rockSet.geometry

    const speleothems = buildHollowSpeleothems(this.field, {
      stalactiteDensity: this.stalactiteDensity,
      stalagmiteDensity: this.stalagmiteDensity,
      draperyScale: this.draperyScale,
    })
    this.speleothemsMesh.geometry.dispose()
    this.speleothemsMesh.geometry = speleothems.geometry
    this.dripEmitters = speleothems.dripEmitters

    const nextLakeGeo = buildHollowLakeGeometry(this.field)
    this.lakeMesh.geometry.dispose()
    this.lakeMesh.geometry = nextLakeGeo

    const nextRimGeo = buildRimstonePoolGeometry(this.field)
    this.rimstonePoolMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry = nextRimGeo
    this.rimstonePoolMesh.visible = this.rimstoneScale > 0.05

    this.water.syncToField(this.dripEmitters)
    this.applyLightLevels()
    this.hollowLighting.syncToField()
    this.volumetrics.syncToField(this.field)

    const skyPos = this.field.skylightCenter
    this.skyPortalMesh.position.set(skyPos.x, skyPos.y + 1.45, skyPos.z)

    const pose = this.field.cinemaPose
    if (!this._poseAppliedForSeed || this._poseAppliedForSeed !== this.seed) {
      this.cameraFov = Math.round(pose.fov * 2) / 2
      this.cameraHeight = Math.round(pose.height * 50) / 50
      this.trackForward = Math.round(this.field.cinemaTracks.forward * 20) / 20
      this.trackLateral = Math.round(this.field.cinemaTracks.lateral * 20) / 20
      this.trackLookDrift = Math.round(this.field.cinemaTracks.lookDrift * 20) / 20
      this._poseAppliedForSeed = this.seed
    }

    this.hollowLighting.requestBake()
    this.envApplied = false
    this.bakeProgress = 0

    void RIMSTONE_POOL_STEP
  }

  private setBakeVisibility(baking: boolean) {
    // Shafts / droplets out of probe captures. Portal only when sky lights are on.
    const skyOn = this.hollowLighting.skyLightsOn
    this.skyPortalMesh.visible = skyOn
    this.volumetrics.shaftMesh.visible = !baking && skyOn
    this.water.dropletMesh.visible = !baking
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
    // Prefer timeline delta; fall back to wall-clock when scrubbing jumps
    const dt = delta > 0 ? delta : Math.max(0, time - this._lastAnimateTime)
    this.water.update(time, dt)
    this._lastAnimateTime = time
  }

  override onBeforeDraw(renderer: WebGPURenderer) {
    if (this.caveDirty) {
      this.rebuildCave()
      this.updateCamera(this.timeline.currentTime)
    }

    if (this.hollowLighting.baking) {
      this.setBakeVisibility(true)
      this.hollowLighting.stepBake(renderer)
      this.bakeProgress = this.hollowLighting.bakeProgress
      this.setBakeVisibility(false)
      this.notify({kind: 'other'})
    } else if (this.hollowLighting.bakeStage === 'done' && !this.envApplied) {
      applyHollowRockEnv(
        this.rockMaterial,
        this.hollowLighting.lakeEnvMap?.texture ?? null,
        this.hollowLighting.skyEnvMap?.texture ?? null,
        this.field,
      )
      this.envApplied = true
      this.bakeProgress = 1
      this.notify({kind: 'material'})
    }

    this.water.onBeforeDraw(renderer)
  }

  override dispose() {
    this.shellMesh.geometry.dispose()
    this.rocksMesh.geometry.dispose()
    this.speleothemsMesh.geometry.dispose()
    this.lakeMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry.dispose()
    this.rockMaterial.dispose()
    this.skyPortalMesh.geometry.dispose()
    this.skyPortalMesh.material.dispose()
    this.water.dispose()
    this.volumetrics.dispose()
    this.hollowLighting.dispose()
    this.field.dispose()
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
    ['skylightIntensity', ioNumberSlider({min: 0, max: 20, step: 0.1}), {label: 'sky dir'}],
    ['skyAreaIntensity', ioNumberSlider({min: 0, max: 60, step: 0.5}), {label: 'sky area'}],
    ['firePointIntensity', ioNumberSlider({min: 0, max: 120, step: 1}), {label: 'fire point'}],
    ['fireAreaIntensity', ioNumberSlider({min: 0, max: 80, step: 0.5}), {label: 'fire area'}],
    ['fillIntensity', ioNumberSlider({min: 0, max: 2, step: 0.02}), {label: 'fill'}],
    ['probeIntensity', ioNumberSlider({min: 0, max: 3, step: 0.05}), {label: 'GI'}],
  ],
  groups: {
    Main: ['goFullscreen', 'cameraMode', 'blockoutStyle', 'seed', 'randomizeSeed', 'rebakeLighting', 'bakeProgress'],
    Lights: [
      'skylightIntensity', 'skyAreaIntensity', 'firePointIntensity', 'fireAreaIntensity', 'fillIntensity',
      'probeIntensity',
    ],
    Camera: ['cameraFov', 'cameraHeight', 'trackForward', 'trackLateral', 'trackLookDrift'],
    Cavern: ['cavernWidth', 'vaultHeight', 'meander', 'strataStrength', 'skylightSize', 'terraceSteps'],
    Features: ['waterLevel', 'rimstoneScale', 'stalactiteDensity', 'stalagmiteDensity', 'draperyScale', 'boulderCount'],
    Hidden: [
      'camera', 'field', 'hollowLighting', 'water', 'volumetrics', 'caveGroup', 'shellMesh', 'rocksMesh',
      'speleothemsMesh', 'lakeMesh', 'rimstonePoolMesh', 'skyPortalMesh', 'rockMaterial', 'styleModeUniform',
      'waterLevelUniform', 'dripEmitters', 'caveDirty', 'envApplied', '_poseAppliedForSeed', '_lastAnimateTime',
      '_frameTarget',
    ],
  },
})
