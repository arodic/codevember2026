import {
  ACESFilmicToneMapping, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, FrontSide, Group, HemisphereLight,
  MathUtils, Mesh, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Node, PerspectiveCamera,
  PlaneGeometry, PointLight, UniformNode, Vector3,
} from 'three/webgpu'
import {
  Fn, attribute, cameraPosition, clamp, color, dot, exp, float, fog, max, mix, mx_noise_float, normalWorldGeometry,
  normalize, positionLocal, positionWorld, pow, saturate, select, smoothstep, texture3D, transformNormalToView, uniform,
  vec3,
} from 'three/tsl'
import { reflector } from 'three/tsl'
import { Register, Property, Field, div } from '@io-gui/core'
import { Bloom, Document, DocumentProps, FrameTarget, Timeline } from '@io-gui/three'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { TimelineFade } from '../TimelineFade.js'
import {
  DEFAULT_HOLLOW_PARAMS, HOLLOW_MIN, HOLLOW_SIZE, HollowField, RIMSTONE_POOL_STEP, createHollowRandom,
} from './hollow/HollowField.js'
import {
  buildHollowLakeGeometry, buildHollowShellGeometry, buildRimstonePoolGeometry,
} from './hollow/HollowShell.js'
import { buildHollowRocks } from './hollow/HollowRocks.js'
import { buildHollowSpeleothems } from './hollow/HollowSpeleothems.js'

const DURATION = 90
const FADE_SECONDS = 2.5

export const HOLLOW_CAMERA_MODES = ['Cinema', 'Cutaway Overview'] as const
export type HollowCameraMode = typeof HOLLOW_CAMERA_MODES[number]

export const HOLLOW_BLOCKOUT_STYLES = ['Lit Clay', 'Geological Zones'] as const
export type HollowBlockoutStyle = typeof HOLLOW_BLOCKOUT_STYLES[number]

const CUTAWAY_POSE = {
  position: new Vector3(16.5, 13.2, 13.5),
  target: new Vector3(-0.8, 1.8, -8.5),
  fov: 44,
}

/**
 * Codevember day 7, **Hollow** (Phase 1 procedural karst blockout):
 * A subterranean karst limestone cavern composed for `2.39:1` widescreen around a meandering mirror lake, a stepped
 * foreground rimstone (`gour`) pool with shallow meniscus, terraced rear cascade beneath a cyan skylight sinkhole,
 * warm fire alcove behind the cinema camera plane, cleaved limestone boulders, rib-guided stalactite curtains,
 * gallery pagoda stalagmites, and fluted calcite draperies. Seed reshuffles the major composition landmarks.
 */
@Register
export class Hollow extends Document {

  @Property({type: String, value: 'Cinema'})
  declare cameraMode: HollowCameraMode

  @Property({type: String, value: 'Lit Clay'})
  declare blockoutStyle: HollowBlockoutStyle

  @Property({type: Number, value: DEFAULT_HOLLOW_PARAMS.seed})
  declare seed: number

  @Property({type: Number, value: 39})
  declare cameraFov: number

  @Property({type: Number, value: 1.68})
  declare cameraHeight: number

  /** Forward dolly travel (`m`) over the 90 s shot (`~1.2 cm/s` at default `1.1 m`). */
  @Property({type: Number, value: 1.10})
  declare trackForward: number

  /** Lateral camera track (`m`) over the 90 s shot (`negative` = gentle leftward drift across the pool). */
  @Property({type: Number, value: -0.42})
  declare trackLateral: number

  /** Subtle pan of the look target (`m`) across the shot to hold the skylight reflection balanced. */
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

  declare private camera: PerspectiveCamera
  declare private field: HollowField
  declare private caveGroup: Group
  declare private shellMesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  declare private rocksMesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  declare private speleothemsMesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  declare private lakeMesh: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  declare private rimstonePoolMesh: Mesh<BufferGeometry, MeshPhysicalNodeMaterial>
  declare private skyPortalMesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  declare private lakeReflector: ReturnType<typeof reflector>
  declare private skylight: DirectionalLight
  declare private fireLight: PointLight
  declare private fillLight: HemisphereLight
  declare private styleModeUniform: UniformNode<'float', number>
  declare private waterLevelUniform: UniformNode<'float', number>
  declare private dripEmitters: Vector3[]
  declare private caveDirty: boolean
  declare private _poseAppliedForSeed: number | undefined

  @Field(null)
  declare private _frameTarget: FrameTarget | null

  constructor(args?: DocumentProps) {
    super({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1.05,
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

    this.scene.background = new Color(0x070b0f)

    this.field = new HollowField()
    this.styleModeUniform = uniform(this.blockoutStyle === 'Geological Zones' ? 1 : 0)
    this.waterLevelUniform = uniform(this.waterLevel)
    this.dripEmitters = []
    this.caveDirty = false

    // Atmospheric rear-chamber cyan mist (`#3998d1` linear) that also renders inside the lake reflector
    this.setupCaveFog()

    // Preview lighting rig (Phase 1 blockout: skylight shaft + occluded left fire alcove + low sculptural fill)
    this.skylight = new DirectionalLight(0x8ad8f0, 5.2)
    this.skylight.name = 'Skylight'
    this.skylight.castShadow = true
    this.skylight.shadow.mapSize.setScalar(2048)
    this.skylight.shadow.camera.near = 2
    this.skylight.shadow.camera.far = 36
    this.skylight.shadow.camera.left = -9
    this.skylight.shadow.camera.right = 9
    this.skylight.shadow.camera.top = 9
    this.skylight.shadow.camera.bottom = -9
    this.skylight.shadow.bias = -0.0008
    this.skylight.shadow.normalBias = 0.04
    this.scene.add(this.skylight)
    this.scene.add(this.skylight.target)

    this.fireLight = new PointLight(0xff8c2e, 58, 26, 1.75)
    this.fireLight.name = 'Hidden Fire'
    this.fireLight.castShadow = true
    this.fireLight.shadow.mapSize.setScalar(1024)
    this.fireLight.shadow.camera.near = 0.4
    this.fireLight.shadow.camera.far = 24
    this.fireLight.shadow.bias = -0.0015
    this.fireLight.shadow.normalBias = 0.05
    this.scene.add(this.fireLight)

    this.fillLight = new HemisphereLight(0x4a7b9d, 0x3b2618, 0.52)
    this.fillLight.name = 'Blockout Fill'
    this.scene.add(this.fillLight)

    // Luminous sky portal cap above the rear karst sinkhole opening
    this.skyPortalMesh = this.createSkyPortal()
    this.scene.add(this.skyPortalMesh)

    // Planar mirror reflector for the meandering subterranean lake
    this.lakeReflector = reflector({resolutionScale: 0.5, bounces: false})
    this.lakeReflector.target.name = 'Lake Reflector'
    this.lakeReflector.target.rotateX(-Math.PI / 2)
    this.lakeReflector.target.userData.selectable = false
    this.scene.add(this.lakeReflector.target)

    // Shared Phase 1 blockout rock material with 3D-SDF collar normal blending & 5-step SDF cavity AO
    const rockMaterial = this.createBlockoutRockMaterial()
    const lakeMaterial = this.createBlockoutLakeMaterial()
    const rimstoneWaterMaterial = this.createBlockoutRimstoneWaterMaterial()

    this.caveGroup = new Group()
    this.caveGroup.name = 'Hollow Cavern'
    this.scene.add(this.caveGroup)

    this.shellMesh = new Mesh(new BufferGeometry(), rockMaterial)
    this.shellMesh.name = 'Cavern Shell'
    this.shellMesh.castShadow = true
    this.shellMesh.receiveShadow = true

    this.rocksMesh = new Mesh(new BufferGeometry(), rockMaterial)
    this.rocksMesh.name = 'Cleaved Boulders'
    this.rocksMesh.castShadow = true
    this.rocksMesh.receiveShadow = true

    this.speleothemsMesh = new Mesh(new BufferGeometry(), rockMaterial)
    this.speleothemsMesh.name = 'Speleothems'
    this.speleothemsMesh.castShadow = true
    this.speleothemsMesh.receiveShadow = true

    this.lakeMesh = new Mesh(new BufferGeometry(), lakeMaterial)
    this.lakeMesh.name = 'Meandering Lake'
    this.lakeMesh.receiveShadow = true

    this.rimstonePoolMesh = new Mesh(new BufferGeometry(), rimstoneWaterMaterial)
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

  private setupCaveFog() {
    const camDist = positionWorld.sub(cameraPosition).length()
    const rearChamberFactor = smoothstep(-7.5, -22.5, positionWorld.z)
    const heightMist = exp(max(positionWorld.y.sub(this.waterLevelUniform).mul(0.22), 0.0).negate())
    const distFog = smoothstep(8.0, 34.0, camDist)
    const fogAmount = saturate(rearChamberFactor.mul(0.62).mul(heightMist.mul(0.55).add(0.45)).add(distFog.mul(0.22)))
    const mistColor = mix(color(0x16384c), color(0x3998d1), rearChamberFactor)
    this.scene.fogNode = fog(mistColor, fogAmount)
  }

  private createSkyPortal() {
    const mat = new MeshBasicNodeMaterial({side: DoubleSide})
    mat.fog = false
    // PlaneGeometry lives in local XY; portal mesh is rotated flat so radial is centered on the sinkhole
    const radial = saturate(positionLocal.xy.length().div(5.5))
    const skyCore = color(0x96cfdc).mul(3.4)
    const skyEdge = color(0x3998d1).mul(1.8)
    mat.colorNode = mix(skyCore, skyEdge, radial)

    const mesh = new Mesh(new PlaneGeometry(14, 14), mat)
    mesh.name = 'Skylight Portal'
    mesh.rotation.x = Math.PI / 2
    mesh.userData.selectable = false
    return mesh
  }

  /**
   * Phase 1 sculptural blockout material:
   * - Seamless 3D-SDF normal collar blending (`aCollar` warped by world fracture noise -> `grad(phi)`) so boulders,
   *   stalactites, stalagmites, and draperies fuse into host limestone with zero sharp CG intersection seams.
   * - 5-step 3D-SDF volumetric ambient occlusion (`aoNode`).
   * - Switchable between `'Lit Clay'` and `'Geological Zones'` for layout & facies inspection.
   */
  private createBlockoutRockMaterial() {
    const sdfTex = this.field.sdfTexture
    const bMin = vec3(HOLLOW_MIN.x, HOLLOW_MIN.y, HOLLOW_MIN.z)
    const bSize = vec3(HOLLOW_SIZE.x, HOLLOW_SIZE.y, HOLLOW_SIZE.z)
    const styleMode = this.styleModeUniform

    const sampleSdfVolume = Fn(([worldPos]: [Node<'vec3'>]) => {
      const uvw = clamp(worldPos.sub(bMin).div(bSize), 0.0, 1.0)
      return texture3D(sdfTex, uvw).level(float(0.0))
    }, {worldPos: 'vec3', return: 'vec4'})

    const material = new MeshStandardNodeMaterial({
      roughness: 0.74,
      metalness: 0.0,
      side: FrontSide,
      shadowSide: DoubleSide,
    })
    material.name = 'Hollow Blockout Rock'

    const zoneAttr = attribute('aZone', 'vec4')
    const collarAttr = attribute('aCollar', 'float')

    const sdfHere = sampleSdfVolume(positionWorld)
    const sdfNormal = normalize(sdfHere.xyz)
    // Modulate collar blend boundary with 3D rock noise so the transition is jagged and geological, never a ring
    const seamNoise = mx_noise_float(positionWorld.mul(2.3)).mul(0.22)
    const collarWeight = saturate(collarAttr.add(seamNoise.mul(collarAttr)))
    const blendedWorldNormal = normalize(mix(normalWorldGeometry, sdfNormal, collarWeight))
    material.normalNode = transformNormalToView(blendedWorldNormal)

    // 5-tap 3D-SDF cavity & contact ambient occlusion along the blended surface normal
    const stepDistances = [0.14, 0.32, 0.65, 1.15, 1.95]
    let occSum: Node<'float'> = float(0.0)
    let weightSum = 0.0
    stepDistances.forEach((dist, idx) => {
      const w = Math.pow(0.68, idx)
      const phiStep = sampleSdfVolume(positionWorld.add(blendedWorldNormal.mul(dist))).w
      const deficit = saturate(float(dist).sub(phiStep).div(dist))
      occSum = occSum.add(deficit.mul(w))
      weightSum += w
    })
    const sdfAO = clamp(float(1.0).sub(occSum.div(weightSum).mul(0.78)), 0.16, 1.0)
    // Subtle extra contact meniscus darkening right in rock-to-cave collars
    const collarCrevice = mix(float(1.0), float(0.88), collarWeight.mul(float(1.0).sub(collarWeight)).mul(4.0))
    material.aoNode = sdfAO.mul(collarCrevice)

    // Subtle stratified horizontal bedding cue in world space so ledges read crisply during Phase 1 review
    const bedBand = mx_noise_float(vec3(positionWorld.x.mul(0.35), positionWorld.y.mul(3.2), positionWorld.z.mul(0.35)))
    const strataCue = float(1.0).add(bedBand.mul(0.08).mul(zoneAttr.x))

    // Mode 0: 'Lit Clay' (neutral warm-limestone maquette with subtle wet shoreline darkening)
    const clayDry = color(0xcabdb0).mul(strataCue)
    const clayTravertine = mix(clayDry, color(0xd8c3a5), zoneAttr.y.mul(0.45))
    const clayWet = pow(clayTravertine, vec3(1.22)).mul(0.68)
    const litClayColor = mix(clayTravertine, clayWet, zoneAttr.w.mul(0.65))

    // Mode 1: 'Geological Zones' (host karst, stratified beds, calcite travertine/speleothems, rimstone sinter)
    const zoneHost = color(0x7c6d61).mul(strataCue)
    const zoneStrata = mix(zoneHost, color(0xb37b46), zoneAttr.x.mul(0.75))
    const zoneTravertine = mix(zoneStrata, color(0xd9a86c), zoneAttr.y.mul(0.85))
    const zoneRimstone = mix(zoneTravertine, color(0xe38d34), zoneAttr.z.mul(0.9))
    const zoneFinal = mix(zoneRimstone, zoneRimstone.mul(0.58), zoneAttr.w.mul(0.55))

    material.colorNode = select(styleMode.greaterThan(0.5), zoneFinal, litClayColor)
    material.roughnessNode = mix(float(0.78), float(0.28), zoneAttr.w.mul(0.75))
    return material
  }

  private createBlockoutLakeMaterial() {
    const waterDepth = attribute('aWaterDepth', 'float')
    const material = new MeshPhysicalNodeMaterial({
      roughness: 0.03,
      metalness: 0.0,
      ior: 1.333,
    })
    material.name = 'Hollow Lake Preview'

    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const nDotV = saturate(dot(vec3(0, 1, 0), viewDir))
    const fresnel = float(0.025).add(float(0.975).mul(pow(float(1.0).sub(nDotV), 5.0)))

    // Shallow warm ochre travertine shore (`#a56b32`) -> deep cerulean mineral water (`#1b88b0`)
    const shallowTint = color(0xa56b32).mul(0.55)
    const deepTint = color(0x0f4d68).mul(0.45)
    const bodyColor = mix(shallowTint, deepTint, smoothstep(0.04, 0.72, waterDepth))

    material.colorNode = mix(bodyColor, this.lakeReflector.rgb, saturate(fresnel.mul(0.92).add(0.14)))
    return material
  }

  private createBlockoutRimstoneWaterMaterial() {
    const waterDepth = attribute('aWaterDepth', 'float')
    const material = new MeshPhysicalNodeMaterial({
      roughness: 0.06,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      ior: 1.333,
    })
    material.name = 'Rimstone Pool Preview'

    const sinterFloor = color(0xb97c3e)
    const amberPool = color(0x9e6329)
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const fresnel = float(0.03).add(float(0.97).mul(pow(float(1.0).sub(saturate(viewDir.y)), 5.0)))
    const base = mix(sinterFloor, amberPool, smoothstep(0.01, 0.09, waterDepth))
    material.colorNode = mix(base, this.lakeReflector.rgb.mul(0.85), fresnel.mul(0.65))
    return material
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

    // 1. Cleaved boulders & SDF proxies first so `sdfTexture` smooth-unions boulder collars with the cave shell
    const rockSet = buildHollowRocks(this.field, Math.round(this.boulderCount))
    this.field.setBoulderProxies(rockSet.proxies)
    this.field.rebuildVolumeTexture()

    // 2. Surface Nets karst cavern shell
    const nextShellGeo = buildHollowShellGeometry(this.field)
    this.shellMesh.geometry.dispose()
    this.shellMesh.geometry = nextShellGeo

    this.rocksMesh.geometry.dispose()
    this.rocksMesh.geometry = rockSet.geometry

    // 3. Ceiling stalactite curtains, pagoda stalagmites, fluted draperies & active over-lake drip emitters
    const speleothems = buildHollowSpeleothems(this.field, {
      stalactiteDensity: this.stalactiteDensity,
      stalagmiteDensity: this.stalagmiteDensity,
      draperyScale: this.draperyScale,
    })
    this.speleothemsMesh.geometry.dispose()
    this.speleothemsMesh.geometry = speleothems.geometry
    this.dripEmitters = speleothems.dripEmitters

    // 4. Main meandering lake (`y = waterLevel`) & stepped foreground rimstone (`gour`) pool (`+8.5 cm`)
    const nextLakeGeo = buildHollowLakeGeometry(this.field)
    this.lakeMesh.geometry.dispose()
    this.lakeMesh.geometry = nextLakeGeo

    const nextRimGeo = buildRimstonePoolGeometry(this.field)
    this.rimstonePoolMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry = nextRimGeo
    this.rimstonePoolMesh.visible = this.rimstoneScale > 0.05

    this.lakeReflector.target.position.set(
      this.field.spineX(-4.0),
      this.waterLevel,
      -4.0,
    )

    // 5. Align skylight rig, sky portal, and behind-camera fire to the seeded cavern anatomy
    const skyPos = this.field.skylightCenter
    this.skyPortalMesh.position.set(skyPos.x, skyPos.y + 1.45, skyPos.z)
    this.skylight.target.position.set(
      skyPos.x - this.field.skylightDirection.x * 4.0,
      this.waterLevel + 1.1,
      skyPos.z - this.field.skylightDirection.z * 4.0,
    )
    this.skylight.position.copy(this.skylight.target.position).addScaledVector(this.field.skylightDirection, 21.0)
    this.fireLight.position.copy(this.field.fireOrigin)

    // Apply seed cinema framing defaults (inspector can still override fov/height/dolly after)
    const pose = this.field.cinemaPose
    if (!this._poseAppliedForSeed || this._poseAppliedForSeed !== this.seed) {
      this.cameraFov = Math.round(pose.fov * 2) / 2
      this.cameraHeight = Math.round(pose.height * 50) / 50
      this._poseAppliedForSeed = this.seed
    }

    void RIMSTONE_POOL_STEP
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

    // Ultra-slow configurable dolly + lateral track from the seed cinema pose
    const duration = Math.max(1e-3, this.timeline.duration)
    const rawU = MathUtils.clamp(time / duration, 0.0, 1.0)
    const easedU = rawU - Math.sin(rawU * Math.PI * 2) * 0.025

    const pose = this.field.cinemaPose
    const startX = pose.startX
    const startZ = pose.startZ
    const baseY = this.waterLevel + this.cameraHeight

    const camX = startX + this.trackLateral * (easedU - 0.5)
    const camZ = startZ - this.trackForward * (easedU - 0.5)

    const benchFloor = this.field ? this.field.floorHeightAt(camX, camZ, true) : this.waterLevel
    const camY = Math.max(baseY, benchFloor + 0.42)

    const targetX = pose.targetX + this.trackLookDrift * (easedU - 0.5)
    const targetY = this.waterLevel + pose.targetY
    const targetZ = pose.targetZ

    this.camera.position.set(camX, camY, camZ)
    this.camera.lookAt(targetX, targetY, targetZ)
  }

  override onAnimate(_delta: number, time: number) {
    this.updateCamera(time)
  }

  override onBeforeDraw() {
    if (this.caveDirty) {
      this.rebuildCave()
      this.updateCamera(this.timeline.currentTime)
    }
  }

  override dispose() {
    this.shellMesh.geometry.dispose()
    this.rocksMesh.geometry.dispose()
    this.speleothemsMesh.geometry.dispose()
    this.lakeMesh.geometry.dispose()
    this.rimstonePoolMesh.geometry.dispose()
    this.shellMesh.material.dispose()
    this.lakeMesh.material.dispose()
    this.rimstonePoolMesh.material.dispose()
    this.skyPortalMesh.geometry.dispose()
    this.skyPortalMesh.material.dispose()
    this.lakeReflector.dispose()
    this.field.dispose()
    super.dispose()
  }
}

registerEditor(Hollow, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, 'Codevember 2026: Hollow (Phase 1 Blockout) by @arodic & cogs'),
  widgets: [
    ['cameraMode', ioOptionSelect({model: new Menu({options: [...HOLLOW_CAMERA_MODES]})}), {label: 'camera'}],
    ['blockoutStyle', ioOptionSelect({model: new Menu({options: [...HOLLOW_BLOCKOUT_STYLES]})}), {label: 'style'}],
    ['seed', ioNumberSlider({min: 1, max: 9999, step: 1})],
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
  ],
  groups: {
    Main: ['goFullscreen', 'cameraMode', 'blockoutStyle', 'seed', 'randomizeSeed'],
    Camera: ['cameraFov', 'cameraHeight', 'trackForward', 'trackLateral', 'trackLookDrift'],
    Cavern: ['cavernWidth', 'vaultHeight', 'meander', 'strataStrength', 'skylightSize', 'terraceSteps'],
    Features: ['waterLevel', 'rimstoneScale', 'stalactiteDensity', 'stalagmiteDensity', 'draperyScale', 'boulderCount'],
    Hidden: [
      'camera', 'field', 'caveGroup', 'shellMesh', 'rocksMesh', 'speleothemsMesh', 'lakeMesh', 'rimstonePoolMesh',
      'skyPortalMesh', 'lakeReflector', 'skylight', 'fireLight', 'fillLight', 'styleModeUniform', 'waterLevelUniform',
      'dripEmitters', 'caveDirty', '_poseAppliedForSeed', '_frameTarget',
    ],
  },
})
