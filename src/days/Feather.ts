import {
  Color, Group, MathUtils, Matrix4, NeutralToneMapping, PerspectiveCamera, Vector3, WebGPURenderer,
} from 'three/webgpu'
import { Register, Property, div } from '@io-gui/core'
import { Bloom, Document, DocumentProps, Timeline, renderScheduler, ScheduledTicker } from '@io-gui/three'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { ioSwitch } from '@io-gui/inputs'
import { ioColorRgba } from '@io-gui/colors'
import {
  DESKTOP_BARBULES_PER_SIDE, FULL_FEATHER_CAMERA_POSE, MACRO_CAMERA_POSE, MOBILE_BARBULES_PER_SIDE,
  REFERENCE_BG_BASE_HEX, REFERENCE_BG_GLOW_HEX, REFERENCE_BG_TOP_HEX, buildFeatherMorphology,
  inverseNeutralToneMappingColor,
} from './feather/FeatherMorphology.js'
import { FeatherPhysics } from './feather/FeatherPhysics.js'
import { FeatherVolume } from './feather/FeatherVolume.js'
import {
  BarbMesh, BarbuleMesh, FeatherBackdrop, FeatherShadingUniforms, RachisMesh, createFeatherShadingUniforms,
} from './feather/FeatherMaterial.js'
import { MacroDepthOfField } from './feather/MacroDepthOfField.js'
import { Soundtrack } from '../Soundtrack.js'
import { TimelineFade } from '../TimelineFade.js'
import type {
  CaptureDefaults, CaptureLens, CaptureLensConfig, CaptureListener, CaptureOptions, CaptureStage, CaptureStageInfo,
} from '../Capture.js'
import type { GestureListener, ViewportGesture } from '../DrawnViewport.js'
import type { PlaybackListener } from '../IoCodevember.js'

/** The soundtrack, which plays with the timeline. */
const SOUNDTRACK = new URL('./feather/BreathOfTheStillness.mp3', import.meta.url).href
/** Seconds of playback, the soundtrack's length (the track's own replaces it once it has loaded). */
const DURATION = 224.04
/** Seconds the picture takes to fade in from white at the start and out to it at the end. */
const FADE = 5
/** Seconds the air takes to come round: each loop of the timeline holds a whole number of its cycles, so it loops. */
const AIR_PERIOD = 32
/**
 * Seconds the simulation steps at a time while a capture plays it, in `CAPTURE_SUBSTEPS`: as finely as playback on a
 * 120 Hz display steps it, and the same however long the frames take to draw.
 */
const CAPTURE_STEP = 1 / 120
const CAPTURE_SUBSTEPS = 2
const MOBILE = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

export const FEATHER_CAMERA_MODES = ['Macro', 'Full Feather'] as const
export type FeatherCameraMode = typeof FEATHER_CAMERA_MODES[number]

const _linearTmp = new Color()
const _invTmp = new Color()
const _lookAt = new Matrix4()
const _origin = new Vector3()
const _yAxis = new Vector3(0, 1, 0)

/**
 * Codevember day 12, **Feather**: macro photography and two-layer aerodynamic GPU simulation of a single connected
 * snowy-white plumulaceous feather against a calibrated studio softbox gradient.
 *
 * A single central rachis (`32` Cosserat nodes) carries `128` `C^2` cubic B-spline barbs (`rami`) and `65,536`
 * (`32,768` on mobile) 3D curved microscopic barbules (`radii`). Layer 0/1 GPU compute simulates inextensible stems
 * under low-Reynolds exponential Stokes air drag, two-way rachis root torque (so every breeze or touch rocks the whole
 * connected feather in common fate), and soft nonlinear variable-envelope (`R_env(s)`) stem–stem collisions. Layer 2
 * simulates 2-mode cantilever barbules with emergent metachronal air waves, envelope-contact splay, and shared-memory
 * neighbor steric ordering. Rendered with a Marschner/Chiang dielectric beta-keratin BSDF (`R/TT/TRT` + medullary pith),
 * a `64×48×40` 3D dual-scattering optical-depth volume, `1.35 px` energy-conserving sub-pixel clamping, GPU back-to-front
 * barb sorting and physical real-time `MacroDepthOfField`. `capture()` plays the simulation through in fixed steps from
 * rest and draws the depth of field through the lens itself, from 64 points of its aperture (`getCaptureDefaults`).
 * The camera hangs from a rig that turns around the feather `orbitTurns` times per loop and, in `Macro`, swings from the
 * crown's tips down the shaft and back `craneCycles` times, carrying the studio (backdrop and lights) with it. The soundtrack (BreathOfTheStillness) plays with the timeline, which is as long as it, fading in
 * from and out to white.
 */
@Register
export class Feather extends Document implements CaptureDefaults, CaptureListener, CaptureLens, GestureListener, PlaybackListener {

  @Property({type: String, value: 'Macro'})
  declare cameraMode: FeatherCameraMode

  /** Turns the camera rig makes around the feather per loop of the timeline (negative turns the other way). */
  @Property({type: Number, value: 4})
  declare orbitTurns: number

  /**
   * Times per loop of the timeline the camera rig swings down from `craneTop` to `craneBottom` and back up, on a sine,
   * in `Macro` (`Full Feather` holds the whole feather in view).
   */
  @Property({type: Number, value: 2})
  declare craneCycles: number

  /** Height (`cm`) of the camera at the top of its swing, where it starts: level with the crown's tips. */
  @Property({type: Number, value: 1})
  declare craneTop: number

  /** Height (`cm`) of the camera at the bottom of its swing: down the shaft, with the quill's end below the frame. */
  @Property({type: Number, value: -3.5})
  declare craneBottom: number

  /** Volume of the soundtrack. */
  @Property({type: Number, value: 0.8})
  declare volume: number

  @Property({type: Number, value: 12})
  declare seed: number

  /** Overall length & volume of the downy barbule envelopes (`R_env(s)`). */
  @Property({type: Number, value: 1.0})
  declare fluffiness: number

  /** Natural graceful arch of the rachis and barbs. */
  @Property({type: Number, value: 1.0})
  declare barbCurvature: number

  /** Ambient room air breath & curl-eddy strength (`cm / s`). */
  @Property({type: Number, value: 0.85})
  declare airCurrent: number

  /** Gentle upward warm convective drift keeping the feather buoyant. */
  @Property({type: Number, value: 0.45})
  declare thermalLift: number

  /** Elastic bending stiffness of the rachis and barb shafts. */
  @Property({type: Number, value: 1.0})
  declare stemStiffness: number

  /** Structural damping (`1 / s`) of each barb's motion relative to its rachis socket: higher settles flapping sooner. */
  @Property({type: Number, value: 3.0})
  declare stemDamping: number

  /** Wavelike responsiveness of microscopic barbules to fine air ripples. */
  @Property({type: Number, value: 1.0})
  declare barbuleWave: number

  /** Damping of the barbules' bending modes (`1` = the tuned default). */
  @Property({type: Number, value: 1.0})
  declare barbuleDamping: number

  /** Scale of the variable barbule collision envelopes between neighboring stems. */
  @Property({type: Number, value: 1.0})
  declare envelopeScale: number

  /** Envelope contact stiffness: fraction of a penetration resolved per substep at full compression. */
  @Property({type: Number, value: 0.012})
  declare contactStiffness: number

  /** Velcro damping (`1 / s` at full compression) of barbs pressed into their neighbors' envelopes. */
  @Property({type: Number, value: 50})
  declare contactDamping: number

  /** Fraction of a collision push kept as velocity: `0` cushions, `1` rebounds. */
  @Property({type: Number, value: 0.15})
  declare contactBounce: number

  /**
   * How much of the rest pose's envelope overlap is accepted as contact-free. The core is crowded by design (most
   * barbs overlap a few neighbors at rest): `1` lets it rest uncompressed and resist only further pressing, `0` makes
   * every overlap push.
   */
  @Property({type: Number, value: 0.5})
  declare restOverlap: number

  /** Strength of interactive pointer hover whispers and drag breezes. */
  @Property({type: Number, value: 1.0})
  declare gestureResponse: number

  /** Sharp focal-plane distance from the camera lens (`cm`). */
  @Property({type: Number, value: 5.65})
  declare focusDistance: number

  /** Physical thin-lens entrance-pupil radius (`cm`); `0` disables optical blur. */
  @Property({type: Number, value: 0.19})
  declare aperture: number

  /**
   * The real-time depth of field (`MacroDepthOfField`). A capture through the lens draws the depth of field itself,
   * and this one stands aside meanwhile.
   */
  @Property({type: Boolean, value: true})
  declare depthOfField: boolean

  /** Keratin backlit `TT` forward-scattering glow intensity. */
  @Property({type: Number, value: 1.05})
  declare translucency: number

  /** Keratin cuticle `R` & `TRT` specular sheen intensity. */
  @Property({type: Number, value: 1.0})
  declare sheen: number

  /** Minimum screen-space anti-aliased ribbon width in pixels. */
  @Property({type: Number, value: 1.35})
  declare minFiberPixels: number

  @Property({type: Color, value: new Color(REFERENCE_BG_BASE_HEX)})
  declare backdropBase: Color

  @Property({type: Color, value: new Color(REFERENCE_BG_TOP_HEX)})
  declare backdropTop: Color

  @Property({type: Color, value: new Color(REFERENCE_BG_GLOW_HEX)})
  declare backdropGlow: Color

  private readonly camera: PerspectiveCamera
  /**
   * The camera rig: a pivot at the point the camera looks at (the center of the framed feather), turning about the
   * vertical. It carries the camera, the studio backdrop and the studio lights' directions, so the feather turns in the
   * studio's calibrated light, seen from every side.
   */
  private readonly cameraRig: Group
  /** The studio lights' directions in the rig, before its turn. */
  private readonly rigKeyDirection: Vector3
  private readonly rigFillDirection: Vector3
  /** The soundtrack, which makes the timeline as long as itself. */
  private readonly soundtrack: Soundtrack
  private readonly shading: FeatherShadingUniforms
  private readonly physics: FeatherPhysics
  private readonly lightVolume: FeatherVolume
  private readonly backdrop: FeatherBackdrop
  private readonly plumeGroup: Group
  private readonly rachisMesh: RachisMesh
  private readonly barbMesh: BarbMesh
  private readonly barbuleMesh: BarbuleMesh
  private readonly depthAnchorGroup: Group
  private readonly barbDepthMesh: BarbMesh
  private readonly barbuleDepthMesh: BarbuleMesh
  private readonly dofEffect: MacroDepthOfField

  private morphologyDirty = false
  private warmedUp = false
  private pendingDelta = 0
  private lastTime = NaN
  private captureStage: CaptureStage = 'off'
  /** The lens a capture looks through, and the part of its aperture a sample stands for (`FeatherShadingUniforms.lensSpread`). */
  private captureLens: CaptureLensConfig | null = null
  private captureSpread = 0

  private gestureActive = false
  private gesturePressed = false
  private gestureImpulse = 0
  private lastGestureWallMs = 0

  /** Drives smooth interactive gesture decay even while timeline playback is paused. */
  private readonly gestureTicker: ScheduledTicker = {
    document: this,
    tick: () => this.tickInteractiveGesture(),
  }

  constructor(args?: DocumentProps) {
    const dofEffect = new MacroDepthOfField({focusDistance: 5.65, apertureRadius: 0.19, maxBokehPixels: 46})
    const bloomEffect = new Bloom({strength: 0.10, radius: 0.38, threshold: 0.96})
    super({
      toneMapping: NeutralToneMapping,
      toneMappingExposure: 1.0,
      timeline: new Timeline({autoplay: false, duration: DURATION, loop: true, frameRate: 30}),
      effects: [dofEffect, bloomEffect, new TimelineFade({fadeIn: FADE, fadeOut: FADE, color: new Color(1, 1, 1)})],
      ...args,
    })

    this.dofEffect = dofEffect
    this.soundtrack = new Soundtrack(SOUNDTRACK, this)
    this.soundtrack.volume = this.volume

    const camera = new PerspectiveCamera(MACRO_CAMERA_POSE.fov, 2.39, 0.25, 120)
    camera.name = 'Camera'
    this.camera = camera
    this.activeCamera = camera
    this.cameraRig = new Group()
    this.cameraRig.name = 'CameraRig'
    this.cameraRig.add(camera)
    this.scene.add(this.cameraRig)

    this.shading = createFeatherShadingUniforms()
    this.rigKeyDirection = this.shading.keyDirection.value.clone()
    this.rigFillDirection = this.shading.fillDirection.value.clone()

    const morphology = buildFeatherMorphology(this.seed, this.fluffiness, this.barbCurvature)
    const barbulesPerSide = MOBILE ? MOBILE_BARBULES_PER_SIDE : DESKTOP_BARBULES_PER_SIDE
    this.physics = new FeatherPhysics(morphology, barbulesPerSide)
    this.lightVolume = new FeatherVolume(this.physics.capsulesAndTorqueBuffer)
    this.lightVolume.setBounds(morphology.volumeBounds)

    this.backdrop = new FeatherBackdrop(this.shading)
    this.cameraRig.add(this.backdrop)

    this.plumeGroup = new Group()
    this.plumeGroup.name = 'Feather'
    this.rachisMesh = new RachisMesh(this.physics, this.lightVolume, this.shading)
    this.barbMesh = new BarbMesh(this.physics, this.lightVolume, this.shading, false)
    this.barbuleMesh = new BarbuleMesh(this.physics, this.lightVolume, this.shading, false)
    this.plumeGroup.add(this.rachisMesh, this.barbMesh, this.barbuleMesh)
    this.scene.add(this.plumeGroup)

    this.depthAnchorGroup = new Group()
    this.depthAnchorGroup.name = 'DepthAnchors'
    this.depthAnchorGroup.userData.selectable = false
    this.barbDepthMesh = new BarbMesh(this.physics, this.lightVolume, this.shading, true)
    this.barbuleDepthMesh = new BarbuleMesh(this.physics, this.lightVolume, this.shading, true)
    this.depthAnchorGroup.add(this.barbDepthMesh, this.barbuleDepthMesh)
    this.scene.add(this.depthAnchorGroup)

    this.applyCameraPose()
    this.syncParameters()
    this.syncBackdropColors()

    renderScheduler.addTicker(this.gestureTicker)
  }

  override getEditorFrameTarget() {
    return this.plumeGroup
  }

  getCaptureLens(): CaptureLensConfig {
    return {
      focusDistance: this.focusDistance,
      apertureRadius: this.aperture,
      blades: 9,
      roundness: 0.65,
    }
  }

  /**
   * How Feather captures, unless `capture()` is told otherwise. The simulation plays the timeline through in fixed steps,
   * so a frame has nothing to settle, and the loop's last 10 s play first, so frame 0 follows the last frame in motion.
   * 64 lens samples draw the depth of field. The motion is slow enough to need no motion blur.
   */
  getCaptureDefaults(): CaptureOptions {
    return {settle: 0, preroll: 10, samples: 64, shutter: 0}
  }

  /**
   * A capture starts, moves on or ends (`CaptureListener`). At its start the simulation starts over from rest, with no
   * touch left in the air, so that the same capture draws the same frames. While it looks through the lens, the lens
   * draws the depth of field (`syncDepthOfField`). Each lens sample stands for an equal part of the aperture, of
   * diameter `2 r / √samples`, and draws each fiber blurred across as that part would (times `fill`): the images of a
   * short defocused barbule then merge into its bokeh instead of showing as copies.
   */
  captureChanged(stage: CaptureStage, info: CaptureStageInfo) {
    if (this.captureStage === 'off' && stage !== 'off') {
      this.morphologyDirty = true
      this.gestureActive = false
      this.gesturePressed = false
      this.gestureImpulse = 0
      this.physics.gestureStrengthUniform.value = 0
    }
    this.captureStage = stage
    this.captureLens = stage === 'off' ? null : info.lens
    this.captureSpread = this.captureLens ? 2 * this.captureLens.apertureRadius / Math.sqrt(info.samples) * info.fill : 0
    this.syncDepthOfField()
  }

  gestureChanged(gesture: ViewportGesture) {
    this.gestureActive = gesture.active
    this.gesturePressed = gesture.pressed
    if (gesture.active) {
      this.physics.gestureOriginUniform.value.copy(gesture.origin)
      this.physics.gestureDirUniform.value.copy(gesture.direction)
      this.physics.gestureVelUniform.value.copy(gesture.angularVelocity)
      const speed = gesture.angularVelocity.length()
      const baseTouch = gesture.pressed ? 0.85 : 0.18
      const motionBoost = Math.min(speed * (gesture.pressed ? 0.55 : 0.24), gesture.pressed ? 1.35 : 0.42)
      const targetImpulse = (baseTouch + motionBoost) * this.gestureResponse
      this.gestureImpulse = Math.max(this.gestureImpulse, targetImpulse)
      this.physics.gestureRadiusUniform.value = gesture.pressed ? 0.92 : 0.68
      this.lastGestureWallMs = performance.now()
      this.notify({kind: 'other'})
    }
  }

  private tickInteractiveGesture() {
    if (this.captureStage !== 'off') return
    if (!this.gestureActive && this.gestureImpulse <= 0.002) {
      if (this.gestureImpulse !== 0) {
        this.gestureImpulse = 0
        this.physics.gestureStrengthUniform.value = 0
      }
      return
    }
    const now = performance.now()
    const dt = Math.min(Math.max((now - (this.lastGestureWallMs || now)) * 0.001, 1 / 120), 0.05)
    this.lastGestureWallMs = now
    const decay = this.gesturePressed ? 0.94 : Math.exp(-dt * 4.8)
    this.gestureImpulse *= decay
    if (!this.gesturePressed) {
      this.physics.gestureVelUniform.value.multiplyScalar(Math.exp(-dt * 8.0))
    }
    this.physics.gestureStrengthUniform.value = this.gestureImpulse
    // Keep simulation alive while pointer stirs air even if the timeline is paused
    if (this.pendingDelta < 1e-5) this.pendingDelta = dt
    this.notify({kind: 'other'})
  }

  /** The editor started or stopped playing the document (`PlaybackListener`): the soundtrack plays along. */
  playbackChanged(playing: boolean) {
    this.soundtrack.playbackChanged(playing)
  }

  volumeChanged() {
    if (this.soundtrack) this.soundtrack.volume = this.volume
  }

  cameraModeChanged() {
    this.applyCameraPose()
    this.notify({kind: 'transform'})
  }

  orbitTurnsChanged() { this.rigChanged() }
  craneCyclesChanged() { this.rigChanged() }
  craneTopChanged() { this.rigChanged() }
  craneBottomChanged() { this.rigChanged() }

  private rigChanged() {
    if (!this.cameraRig) return
    this.moveRig(this.timeline.currentTime)
    this.notify({kind: 'transform'})
  }

  seedChanged() {
    this.morphologyDirty = true
    this.notify({kind: 'geometry'})
  }

  fluffinessChanged() {
    this.morphologyDirty = true
    this.notify({kind: 'geometry'})
  }

  barbCurvatureChanged() {
    this.morphologyDirty = true
    this.notify({kind: 'geometry'})
  }

  airCurrentChanged() { this.syncParameters() }
  thermalLiftChanged() { this.syncParameters() }
  stemStiffnessChanged() { this.syncParameters() }
  stemDampingChanged() { this.syncParameters() }
  barbuleWaveChanged() { this.syncParameters() }
  barbuleDampingChanged() { this.syncParameters() }
  envelopeScaleChanged() { this.syncParameters() }
  contactStiffnessChanged() { this.syncParameters() }
  contactDampingChanged() { this.syncParameters() }
  contactBounceChanged() { this.syncParameters() }
  restOverlapChanged() { this.syncParameters() }
  translucencyChanged() { this.syncParameters() }
  sheenChanged() { this.syncParameters() }
  minFiberPixelsChanged() { this.syncParameters() }

  focusDistanceChanged() {
    this.camera.focus = this.focusDistance
    this.syncDepthOfField()
  }

  apertureChanged() {
    this.syncDepthOfField()
  }

  depthOfFieldChanged() {
    this.syncDepthOfField()
  }

  /**
   * The real-time depth of field as set (`depthOfField`, `focusDistance`, `aperture`), with the depth anchors it reads.
   * While a capture looks through the lens, the lens draws the depth of field: the effect stands aside (bypassed, as
   * switching it off would rebuild the view's graph) and the fibers widen by the lens samples' spread at their depth.
   */
  private syncDepthOfField() {
    const effect = this.dofEffect
    if (!effect) return
    const lens = this.captureLens
    const anchors = this.depthOfField && !lens
    const shading = this.shading
    shading.lensSpread.value = this.captureSpread
    shading.lensFocus.value = lens?.focusDistance ?? this.focusDistance
    if (effect.enabled === this.depthOfField && effect.bypassed === Boolean(lens) &&
      effect.focusDistance === this.focusDistance && effect.apertureRadius === this.aperture &&
      this.depthAnchorGroup.visible === anchors) return
    effect.enabled = this.depthOfField
    effect.bypassed = Boolean(lens)
    effect.focusDistance = this.focusDistance
    effect.apertureRadius = this.aperture
    this.depthAnchorGroup.visible = anchors
    this.notify({kind: 'effects'})
  }

  backdropBaseChanged() { this.syncBackdropColors() }
  backdropBaseMutated() { this.syncBackdropColors() }
  backdropTopChanged() { this.syncBackdropColors() }
  backdropTopMutated() { this.syncBackdropColors() }
  backdropGlowChanged() { this.syncBackdropColors() }
  backdropGlowMutated() { this.syncBackdropColors() }
  toneMappingExposureChanged() { this.syncBackdropColors() }

  randomizeSeed() {
    this.seed = Math.floor(Math.random() * 1000)
  }

  goFullscreen() {
    this.dispatch('go-fullscreen', {}, true)
  }

  /**
   * Hangs the camera from the rig at the camera mode's pose: the camera where the pose puts it relative to its target,
   * looking at the rig's pivot (`moveRig` places the pivot). The backdrop sits in the rig where it is in the world at
   * the rig's rest angle and the pose's own height.
   */
  private applyCameraPose() {
    const pose = this.cameraMode === 'Macro' ? MACRO_CAMERA_POSE : FULL_FEATHER_CAMERA_POSE
    const camera = this.camera
    this.backdrop.position.copy(pose.target).negate()
    camera.fov = pose.fov
    camera.position.subVectors(pose.position, pose.target)
    camera.quaternion.setFromRotationMatrix(_lookAt.lookAt(camera.position, _origin, camera.up))
    camera.updateProjectionMatrix()
    this.moveRig(this.timeline.currentTime)

    const defaultFocus = this.cameraMode === 'Macro' ? 5.65 : 16.2
    const defaultAperture = this.cameraMode === 'Macro' ? 0.19 : 0.09
    this.focusDistance = defaultFocus
    this.aperture = defaultAperture
  }

  /**
   * Moves the camera rig to `time`, carrying the camera, the backdrop and the studio lights: `orbitTurns` turns about the
   * vertical per loop of the timeline, and in `Macro` `craneCycles` swings from `craneTop` down to `craneBottom` and
   * back (a cosine, so a loop starts and ends at the top). The camera looks level, so the height is the eye's.
   */
  private moveRig(time: number) {
    const progress = time / Math.max(this.timeline.duration, 1e-3)
    const angle = this.orbitTurns * Math.PI * 2 * progress
    const rig = this.cameraRig
    rig.rotation.y = angle
    if (this.cameraMode === 'Macro') {
      const up = 0.5 + 0.5 * Math.cos(this.craneCycles * Math.PI * 2 * progress)
      rig.position.set(MACRO_CAMERA_POSE.target.x, MathUtils.lerp(this.craneBottom, this.craneTop, up), MACRO_CAMERA_POSE.target.z)
    } else {
      rig.position.copy(FULL_FEATHER_CAMERA_POSE.target)
    }
    rig.updateMatrixWorld(true)
    this.shading.keyDirection.value.copy(this.rigKeyDirection).applyAxisAngle(_yAxis, angle)
    this.shading.fillDirection.value.copy(this.rigFillDirection).applyAxisAngle(_yAxis, angle)
    this.lightVolume.keyDirection.value.copy(this.shading.keyDirection.value)
  }

  /** The air's phase at `time`: a whole number of `AIR_PERIOD` cycles per loop of the timeline. */
  private airPhase(time: number) {
    const duration = Math.max(this.timeline.duration, 1e-3)
    return time / duration * Math.max(1, Math.round(duration / AIR_PERIOD)) * Math.PI * 2
  }

  private syncParameters() {
    this.physics.airStrengthUniform.value = this.airCurrent
    this.physics.thermalLiftUniform.value = this.thermalLift
    this.physics.stemStiffnessUniform.value = this.stemStiffness
    this.physics.stemDampingUniform.value = this.stemDamping
    this.physics.barbuleWaveUniform.value = this.barbuleWave
    this.physics.barbuleDampingUniform.value = this.barbuleDamping
    this.physics.envelopeComplianceUniform.value = this.envelopeScale
    this.physics.contactStiffnessUniform.value = this.contactStiffness
    this.physics.contactDampingUniform.value = this.contactDamping
    this.physics.contactBounceUniform.value = this.contactBounce
    this.physics.restOverlapUniform.value = this.restOverlap
    this.shading.translucency.value = this.translucency
    this.shading.sheen.value = this.sheen
    this.shading.minPixelWidth.value = this.minFiberPixels
    this.syncDepthOfField()
    this.notify({kind: 'material'})
  }

  private syncBackdropColors() {
    const exp = Math.max(this.toneMappingExposure, 0.05)

    // Exact inverse NeutralToneMapping so rendered sRGB stops hit #46658f, #4b6993, #4c6c93, and #85a0c2
    _linearTmp.copy(this.backdropBase)
    inverseNeutralToneMappingColor(_linearTmp, exp, _invTmp)
    this.shading.bgBottomLeft.value.set(_invTmp.r, _invTmp.g, _invTmp.b)

    _linearTmp.copy(this.backdropTop)
    inverseNeutralToneMappingColor(_linearTmp, exp, _invTmp)
    this.shading.bgTopLeft.value.set(_invTmp.r, _invTmp.g, _invTmp.b)

    // Subtle top-center cyan-slate lift (#4c6c93 vs #4b6993)
    _linearTmp.copy(this.backdropTop).offsetHSL(-0.004, -0.01, 0.008)
    inverseNeutralToneMappingColor(_linearTmp, exp, _invTmp)
    this.shading.bgTopCenter.value.set(_invTmp.r, _invTmp.g, _invTmp.b)

    _linearTmp.copy(this.backdropGlow)
    inverseNeutralToneMappingColor(_linearTmp, exp, _invTmp)
    this.shading.bgGlowRight.value.set(_invTmp.r, _invTmp.g, _invTmp.b)

    // Lower-right softbox wrap (#7491b6 midway between base slate and glow)
    _linearTmp.copy(this.backdropBase).lerp(this.backdropGlow, 0.68)
    inverseNeutralToneMappingColor(_linearTmp, exp, _invTmp)
    this.shading.bgLowerRight.value.set(_invTmp.r, _invTmp.g, _invTmp.b)

    // Match recessed plumage sky ambient to the backdrop palette so feather shadows sit naturally in the room
    const amb = _linearTmp.copy(this.backdropTop).lerp(this.backdropGlow, 0.48)
    this.shading.skyAmbient.value.set(amb.r * 1.18, amb.g * 1.15, amb.b * 1.12)

    this.notify({kind: 'material'})
  }

  override onAnimate(delta: number, time: number) {
    const wrapped = Number.isFinite(this.lastTime) && Math.abs(time - this.lastTime) > 1.5
    this.lastTime = time

    if (this.captureStage !== 'off') {
      // a capture plays the timeline forward, from a simulation at rest: the simulation follows all of it
      if (delta > 0) this.pendingDelta += delta
    } else if (delta > 0 && !wrapped) {
      this.pendingDelta += Math.min(delta, 0.05)
    } else if (wrapped) {
      this.pendingDelta = 1 / 60
    }
    this.physics.phaseUniform.value = this.airPhase(time)
    this.soundtrack.sync(time)
    this.moveRig(time)
    this.notify({kind: 'time'})
  }

  override onBeforeDraw(renderer: WebGPURenderer, delta: number) {
    if (this.morphologyDirty) {
      const morphology = buildFeatherMorphology(this.seed, this.fluffiness, this.barbCurvature)
      this.physics.applyMorphology(morphology, renderer)
      this.lightVolume.setBounds(morphology.volumeBounds)
      this.morphologyDirty = false
      this.warmedUp = false
    }

    const phase = this.airPhase(this.timeline.currentTime)

    if (!this.warmedUp) {
      // Settle into gentle aerodynamic & steric equilibrium before the very first frame is presented
      const warmupSteps = 28
      for (let i = 0; i < warmupSteps; i++) {
        this.physics.step(renderer, 1 / 75, phase, 2)
      }
      this.warmedUp = true
      this.pendingDelta = 0
    } else if (this.captureStage !== 'off') {
      this.stepCapture(renderer)
    } else {
      const stepDt = this.pendingDelta > 0 ? this.pendingDelta : delta
      if (stepDt > 1e-5) {
        const substeps = MathUtils.clamp(Math.ceil(stepDt * 150), 1, 3)
        this.physics.step(renderer, stepDt, phase, substeps)
        this.pendingDelta = 0
      }
    }

    if (this.activeCamera) {
      this.physics.sortForCamera(renderer, this.activeCamera)
    }
    this.lightVolume.update(renderer)
  }

  /**
   * Steps the simulation through the time a capture has played since it last stepped, in fixed steps (`CAPTURE_STEP`),
   * each in the air of its own time; what is left of a step waits for the next frame. A frame's lens samples, drawn at
   * one time, see one simulation. At most a second is stepped at once, so a stray jump can't stall the page.
   */
  private stepCapture(renderer: WebGPURenderer) {
    const time = this.timeline.currentTime
    this.pendingDelta = Math.min(this.pendingDelta, 1)
    while (this.pendingDelta > CAPTURE_STEP - 1e-9) {
      this.pendingDelta -= CAPTURE_STEP
      this.physics.step(renderer, CAPTURE_STEP, this.airPhase(time - this.pendingDelta), CAPTURE_SUBSTEPS)
    }
  }

  override dispose() {
    renderScheduler.removeTicker(this.gestureTicker)
    this.soundtrack.dispose()
    this.rachisMesh.dispose()
    this.barbMesh.dispose()
    this.barbuleMesh.dispose()
    this.barbDepthMesh.dispose()
    this.barbuleDepthMesh.dispose()
    this.backdrop.dispose()
    this.lightVolume.dispose()
    this.physics.dispose()
    super.dispose()
  }
}

registerEditor(Feather, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, 'Codevember 2026: Feather by @arodic & cogs'),
  widgets: [
    ['cameraMode', ioOptionSelect({model: new Menu({options: [...FEATHER_CAMERA_MODES]})}), {label: 'camera'}],
    ['orbitTurns', ioNumberSlider({min: -8, max: 8, step: 0.1}), {label: 'turns'}],
    ['craneCycles', ioNumberSlider({min: 0, max: 8, step: 0.5}), {label: 'swings'}],
    ['craneTop', ioNumberSlider({min: -5, max: 2.5, step: 0.05}), {label: 'top'}],
    ['craneBottom', ioNumberSlider({min: -5, max: 2.5, step: 0.05}), {label: 'bottom'}],
    ['volume', ioNumberSlider({min: 0, max: 1, step: 0.01})],
    ['seed', ioNumberSlider({min: 0, max: 999, step: 1})],
    ['fluffiness', ioNumberSlider({min: 0.4, max: 1.8, step: 0.01}), {label: 'fluff'}],
    ['barbCurvature', ioNumberSlider({min: 0.2, max: 1.8, step: 0.01}), {label: 'arch'}],
    ['airCurrent', ioNumberSlider({min: 0, max: 2.5, step: 0.01}), {label: 'air'}],
    ['thermalLift', ioNumberSlider({min: 0, max: 1.5, step: 0.01}), {label: 'thermal'}],
    ['stemStiffness', ioNumberSlider({min: 0.3, max: 2.5, step: 0.01}), {label: 'stiffness'}],
    ['stemDamping', ioNumberSlider({min: 0, max: 20, step: 0.1}), {label: 'damping'}],
    ['barbuleWave', ioNumberSlider({min: 0, max: 2.5, step: 0.01}), {label: 'waves'}],
    ['barbuleDamping', ioNumberSlider({min: 0.25, max: 4, step: 0.01}), {label: 'waveDamping'}],
    ['envelopeScale', ioNumberSlider({min: 0.2, max: 1.8, step: 0.01}), {label: 'envelope'}],
    ['contactStiffness', ioNumberSlider({min: 0, max: 0.5, step: 0.005}), {label: 'firmness'}],
    ['contactDamping', ioNumberSlider({min: 0, max: 200, step: 1}), {label: 'velcro'}],
    ['contactBounce', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'bounce'}],
    ['restOverlap', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'restOverlap'}],
    ['gestureResponse', ioNumberSlider({min: 0, max: 2.5, step: 0.01}), {label: 'gesture'}],
    ['focusDistance', ioNumberSlider({min: 2.0, max: 22.0, step: 0.02}), {label: 'focus'}],
    ['aperture', ioNumberSlider({min: 0, max: 0.38, step: 0.002})],
    ['depthOfField', ioSwitch(), {label: 'realTimeDoF'}],
    ['translucency', ioNumberSlider({min: 0, max: 2.5, step: 0.01}), {label: 'backlit'}],
    ['sheen', ioNumberSlider({min: 0, max: 2.5, step: 0.01})],
    ['minFiberPixels', ioNumberSlider({min: 0.9, max: 2.5, step: 0.05}), {label: 'minPx'}],
    ['backdropBase', ioColorRgba(), {label: 'bgLow'}],
    ['backdropTop', ioColorRgba(), {label: 'bgTop'}],
    ['backdropGlow', ioColorRgba(), {label: 'bgGlow'}],
  ],
  groups: {
    Main: ['goFullscreen', 'cameraMode', 'seed', 'randomizeSeed', 'fluffiness', 'barbCurvature', 'volume'],
    Rig: ['orbitTurns', 'craneCycles', 'craneTop', 'craneBottom'],
    Physics: [
      'airCurrent', 'thermalLift', 'stemStiffness', 'stemDamping', 'barbuleWave', 'barbuleDamping', 'gestureResponse',
    ],
    Contacts: ['envelopeScale', 'contactStiffness', 'contactDamping', 'contactBounce', 'restOverlap'],
    Optics: ['focusDistance', 'aperture', 'depthOfField', 'translucency', 'sheen', 'minFiberPixels'],
    Backdrop: ['backdropBase', 'backdropTop', 'backdropGlow'],
    Hidden: [
      'camera', 'cameraRig', 'rigKeyDirection', 'rigFillDirection', 'soundtrack', 'shading', 'physics', 'lightVolume', 'backdrop', 'plumeGroup', 'rachisMesh', 'barbMesh', 'barbuleMesh',
      'depthAnchorGroup', 'barbDepthMesh', 'barbuleDepthMesh', 'dofEffect', 'morphologyDirty',
      'warmedUp', 'pendingDelta', 'lastTime', 'captureStage', 'captureLens', 'captureSpread', 'gestureActive', 'gesturePressed',
      'gestureImpulse', 'lastGestureWallMs', 'gestureTicker',
    ],
  },
})
