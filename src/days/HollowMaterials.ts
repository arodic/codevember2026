import {
  ACESFilmicToneMapping, BufferGeometry, Color, DirectionalLight, Group, HemisphereLight, Light, LightShadow, Mesh, MeshPhysicalNodeMaterial, Node, Object3D,
  PerspectiveCamera, PMREMGenerator, PointLight, SRGBColorSpace, SpotLight, Texture, UniformNode, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {attribute, dot, exp, float, max, normalize, positionWorld, select, smoothstep, uniform, vec3} from 'three/tsl'
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js'
import {Register, Property, div} from '@io-gui/core'
import {Document, DocumentProps, Timeline} from '@io-gui/three'
import {registerEditor} from '@io-gui/editors'
import {ioNumberSlider} from '@io-gui/sliders'
import {ioOptionSelect, Menu} from '@io-gui/menus'
import {HOLLOW_SPECIMENS, floorGeometry, meshSpecimensOnWorkers, swatchGeometry} from './hollow/HollowSpecimens.js'
import {applyHollowSurface, createHollowSurfaceControls, type HollowSurfaceControls} from './hollow/HollowSurface.js'

const DURATION = 24

export const HOLLOW_MATERIALS_LIGHTING = ['Headlamp', 'Lantern', 'Skylight', 'Show Cave', 'Raking', 'Studio'] as const
export type HollowMaterialsLighting = typeof HOLLOW_MATERIALS_LIGHTING[number]

export const HOLLOW_MATERIALS_SUBJECTS = [
  'Overview', 'Wall', 'Stalactites', 'Drapery', 'Flowstone', 'Stalagmite', 'Rimstone', 'Boulder', 'Swatches',
] as const
export type HollowMaterialsSubject = typeof HOLLOW_MATERIALS_SUBJECTS[number]

export const HOLLOW_MATERIALS_DISPLAYS = ['Shaded', 'Layers'] as const
export type HollowMaterialsDisplay = typeof HOLLOW_MATERIALS_DISPLAYS[number]

/** Camera distance (`m`) at which the headlamp has its base intensity. */
const HEADLAMP_DISTANCE = 2.6
/** Spacing (`m`) of the specimens along `x`. */
const SPACING = 2.3
/** The swatches' row (`z`), radius and spacing (`m`). */
const SWATCH_ROW = 1.75
const SWATCH_RADIUS = 0.2
/** The swatches' zones (`aZone`: beds, calcite, rimstone, wetness). */
const SWATCHES: readonly [string, readonly [number, number, number, number]][] = [
  ['Bedrock', [0.6, 0, 0, 0]],
  ['Bedrock, Wet', [0.6, 0, 0, 0.9]],
  ['Flowstone', [0.1, 0.85, 0, 0.3]],
  ['Dripstone, Wet', [0.1, 0.95, 0, 0.85]],
  ['Rimstone', [0.05, 0.6, 0.9, 0.75]],
]

/** Absorption `σa` (`1/m`) of the draperies' iron-tinted calcite (as `HollowMaterial`'s). */
const CALCITE_ABSORPTION = vec3(9, 22, 48)
/** Fraction of the light entering one face of a calcite sheet that leaves the other. */
const CALCITE_DIFFUSE_TRANSMISSION = 0.5

/** Linear RGB of a black body at `kelvin` (Helland's fit, in sRGB). */
function blackBody(kelvin: number) {
  const t = kelvin / 100
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const c = (v: number) => Math.min(1, Math.max(0, v / 255))
  return new Color().setRGB(c(r), c(g), c(b), SRGBColorSpace)
}

interface Pose {
  target: Vector3
  /** Camera distance (`m`) and height above the target (degrees). */
  distance: number
  elevation: number
  /** Scale of the light rig around the target. */
  scale: number
  /** Half width (`m`) the sun's and the raking light's shadows cover. */
  shadowRadius: number
}

/**
 * Material prototype for Hollow's cave surface (`applyHollowSurface`): the cave's key formations in miniature, sculpted
 * and meshed as the cave is (`HollowSpecimens`), with swatches of single surface types, under the lights a cave is
 * seen by: a caver's headlamp, a lantern, a skylight's sun, a show cave's floods, a raking light to read the relief,
 * and a neutral studio. The camera sways about the subject so the wet highlights move.
 */
@Register
export class HollowMaterials extends Document {

  /** The lighting condition. */
  @Property({type: String, value: 'Headlamp'})
  declare condition: HollowMaterialsLighting

  @Property({type: String, value: 'Overview'})
  declare subject: HollowMaterialsSubject

  @Property({type: String, value: 'Shaded'})
  declare display: HollowMaterialsDisplay

  /** Sway (degrees) of the camera about the subject over the loop. */
  @Property({type: Number, value: 15})
  declare orbit: number

  /** Camera distance as a fraction of the subject's framing distance: under `1` for close-ups. */
  @Property({type: Number, value: 1})
  declare zoom: number

  /** Added to the field's wetness everywhere. */
  @Property({type: Number, value: 0})
  declare wetness: number

  @Property({type: Number, value: 1})
  declare iron: number

  @Property({type: Number, value: 1})
  declare sediment: number

  @Property({type: Number, value: 1})
  declare crust: number

  @Property({type: Number, value: 1})
  declare relief: number

  declare private camera: PerspectiveCamera
  declare private controls: HollowSurfaceControls
  declare private surface: MeshPhysicalNodeMaterial
  declare private subjects: Map<HollowMaterialsSubject, Object3D>
  declare private poses: Map<HollowMaterialsSubject, Pose>
  declare private specimenGroup: Group
  /** Lights placed around the subject: moved and scaled with it. */
  declare private rig: Group
  declare private aim: Object3D
  declare private headlamp: SpotLight
  declare private lantern: PointLight
  declare private sun: DirectionalLight
  declare private skyFill: HemisphereLight
  declare private floodFront: SpotLight
  declare private floodBack: SpotLight
  declare private floodCool: SpotLight
  declare private raking: DirectionalLight
  declare private studioKey: DirectionalLight
  declare private studioRim: DirectionalLight
  declare private caveFill: HemisphereLight
  /** Each light's intensity at rig scale `1`. */
  declare private baseIntensity: Map<Light, number>
  declare private studioEnvironment: Texture | null
  /** Stops the workers meshing the specimens. */
  declare private stopMeshing: () => void
  /** The light whose far-side irradiance the drapery transmits: position (or direction, to it), color × intensity. */
  declare private backLight: {
    position: UniformNode<'vec3', Vector3>
    color: UniformNode<'vec3', Vector3>
    directional: UniformNode<'float', number>
  }

  constructor(args?: DocumentProps) {
    super({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1,
      timeline: new Timeline({autoplay: true, duration: DURATION, loop: true}),
      ...args,
    })

    this.camera = new PerspectiveCamera(35, 2.39, 0.05, 80)
    this.camera.name = 'Camera'
    this.activeCamera = this.camera
    this.scene.add(this.camera)
    this.scene.background = new Color(0x000000)
    this.studioEnvironment = null

    this.controls = createHollowSurfaceControls()
    this.backLight = {
      position: uniform(new Vector3()),
      color: uniform(new Vector3()),
      directional: uniform(0),
    }
    this.surface = new MeshPhysicalNodeMaterial()
    this.surface.name = 'Hollow Surface'
    applyHollowSurface(this.surface, this.controls, {transmission: n => this.transmission(n)})
    this.syncControls()

    this.subjects = new Map()
    this.poses = new Map()
    this.specimenGroup = new Group()
    this.specimenGroup.name = 'Specimens'
    this.scene.add(this.specimenGroup)
    // Meshed on workers: each shows when it arrives
    const meshes = HOLLOW_SPECIMENS.map((specimen, i) => {
      const mesh = new Mesh(new BufferGeometry(), this.surface)
      mesh.name = specimen.name
      mesh.visible = false
      mesh.position.set((i - (HOLLOW_SPECIMENS.length - 1) / 2) * SPACING, 0, 0)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.specimenGroup.add(mesh)
      this.subjects.set(specimen.name as HollowMaterialsSubject, mesh)
      this.poses.set(specimen.name as HollowMaterialsSubject, {
        target: specimen.focus.clone().add(mesh.position),
        distance: specimen.radius * 2.7,
        elevation: specimen.hanging ? -6 : specimen.name === 'Wall' ? 6 : 20,
        scale: specimen.radius,
        shadowRadius: specimen.radius * 1.5,
      })
      return mesh
    })
    this.stopMeshing = meshSpecimensOnWorkers((i, geometry) => {
      meshes[i].geometry.dispose()
      meshes[i].geometry = geometry
      meshes[i].visible = true
      this.notify({kind: 'geometry'})
    })

    const swatches = new Group()
    swatches.name = 'Swatches'
    SWATCHES.forEach(([name, zone], i) => {
      const mesh = new Mesh(swatchGeometry(SWATCH_RADIUS, zone), this.surface)
      mesh.name = name
      mesh.position.set((i - (SWATCHES.length - 1) / 2) * 1.0, SWATCH_RADIUS - 0.05, SWATCH_ROW)
      mesh.castShadow = true
      mesh.receiveShadow = true
      swatches.add(mesh)
    })
    this.specimenGroup.add(swatches)
    this.subjects.set('Swatches', swatches)
    this.poses.set('Swatches', {
      target: new Vector3(0, 0.15, SWATCH_ROW), distance: 3.6, elevation: 14, scale: 1.1, shadowRadius: 2.8,
    })

    const floor = new Mesh(floorGeometry(SPACING * HOLLOW_SPECIMENS.length + 2, 7), this.surface)
    floor.name = 'Floor'
    floor.position.z = 0.6
    floor.receiveShadow = true
    this.specimenGroup.add(floor)
    this.subjects.set('Overview', this.specimenGroup)
    this.poses.set('Overview', {
      target: new Vector3(0, 0.8, 0.6), distance: 11.5, elevation: 13, scale: 3.5, shadowRadius: 9,
    })

    this.rig = new Group()
    this.rig.name = 'Light Rig'
    this.aim = new Object3D()
    this.aim.name = 'Aim'
    this.rig.add(this.aim)
    this.scene.add(this.rig)
    this.baseIntensity = new Map()
    const add = <L extends Light>(light: L, name: string, intensity: number, at: [number, number, number] | null, shadow = 0) => {
      light.name = name
      light.intensity = intensity
      this.baseIntensity.set(light, intensity)
      if (at) {
        light.position.set(...at)
        this.rig.add(light)
      }
      if ('target' in light) (light as unknown as {target: Object3D}).target = this.aim
      if (shadow) {
        light.castShadow = true
        const s = (light as unknown as {shadow: LightShadow}).shadow
        s.mapSize.set(shadow, shadow)
        s.bias = -0.0004
        s.normalBias = 0.02
        const camera = s.camera as PerspectiveCamera
        camera.near = 0.05
        camera.far = 40
      }
      return light
    }

    // A caver's headlamp, a little above the lens: flat light, hard highlights on every wet surface
    this.headlamp = add(new SpotLight(blackBody(4300), 1, 0, 0.55, 0.75, 2), 'Headlamp', 20, null, 2048)
    this.headlamp.position.set(0, 0.09, 0.02)
    const headlampAim = new Object3D()
    headlampAim.position.set(0, 0, -1)
    this.camera.add(this.headlamp, headlampAim)
    this.headlamp.target = headlampAim
    // A lantern held low to the left: warm, flickering
    this.lantern = add(new PointLight(blackBody(1900), 1, 0, 2), 'Lantern', 6, [-0.9, 0.1, 0.9], 1024)
    this.lantern.shadow.bias = -0.003
    this.lantern.shadow.camera.far = 12
    // The sun down a skylight, the sky's cool fill
    this.sun = add(new DirectionalLight(blackBody(5600), 1), 'Sun', 4.5, [0.6, 4, -1.2], 2048)
    this.skyFill = add(new HemisphereLight(new Color(0.55, 0.65, 0.85), new Color(0.12, 0.1, 0.08), 1), 'Sky', 0.35, null)
    // A show cave's floods: warm from below in front, warmer behind (through the draperies), a cool accent
    this.floodFront = add(new SpotLight(blackBody(2700), 1, 0, 0.6, 0.6, 2), 'Flood Front', 9, [-1.1, -0.5, 1.0], 2048)
    this.floodBack = add(new SpotLight(blackBody(3200), 1, 0, 0.6, 0.6, 2), 'Flood Back', 7, [0.9, 0.2, -1.1], 1024)
    this.floodCool = add(new SpotLight(blackBody(4800), 1, 0, 0.5, 0.7, 2), 'Flood Cool', 2.5, [1.3, 1.0, 1.0], 0)
    // Grazing light from the left: the relief
    this.raking = add(new DirectionalLight(blackBody(5000), 1), 'Raking', 3.5, [-3, 0.45, 0.8], 2048)
    // A neutral studio: room environment, key and rim
    this.studioKey = add(new DirectionalLight(blackBody(5500), 1), 'Studio Key', 2.2, [2, 3, 2.5], 2048)
    this.studioRim = add(new DirectionalLight(blackBody(6500), 1), 'Studio Rim', 1.2, [-1.5, 1.5, -3], 0)
    // What little light a cave returns
    this.caveFill = add(new HemisphereLight(new Color(0.5, 0.45, 0.4), new Color(0.2, 0.15, 0.1), 1), 'Cave Fill', 0.04, null)
    this.scene.add(this.skyFill, this.caveFill)

    this.applyLighting()
    this.applySubject()
  }

  override getEditorFrameTarget() {
    return this.subjects.get(this.subject) ?? this.specimenGroup
  }

  override onRendererInitialized(renderer: WebGPURenderer) {
    const pmrem = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    this.studioEnvironment = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    this.applyLighting()
  }

  conditionChanged() { this.applyLighting() }
  subjectChanged() { this.applySubject() }
  orbitChanged() { this.updateCamera(this.timeline.currentTime) }
  zoomChanged() { this.applySubject() }
  displayChanged() { this.syncControls() }
  wetnessChanged() { this.syncControls() }
  ironChanged() { this.syncControls() }
  sedimentChanged() { this.syncControls() }
  crustChanged() { this.syncControls() }
  reliefChanged() { this.syncControls() }

  private syncControls() {
    if (!this.controls) return
    this.controls.wetness.value = this.wetness
    this.controls.iron.value = this.iron
    this.controls.sediment.value = this.sediment
    this.controls.crust.value = this.crust
    this.controls.relief.value = this.relief
    this.controls.debug.value = this.display === 'Layers' ? 1 : 0
    this.notify({kind: 'material'})
  }

  private get pose(): Pose {
    return this.poses.get(this.subject) ?? this.poses.get('Overview')!
  }

  /** Lights of the chosen condition on, the rest off; the studio's environment only in the studio. */
  private applyLighting() {
    if (!this.rig) return
    const on: Record<HollowMaterialsLighting, Light[]> = {
      'Headlamp': [this.headlamp, this.caveFill],
      'Lantern': [this.lantern, this.caveFill],
      'Skylight': [this.sun, this.skyFill],
      'Show Cave': [this.floodFront, this.floodBack, this.floodCool, this.caveFill],
      'Raking': [this.raking, this.caveFill],
      'Studio': [this.studioKey, this.studioRim],
    }
    const lit = new Set(on[this.condition])
    for (const light of this.baseIntensity.keys()) light.visible = lit.has(light)
    const studio = this.condition === 'Studio'
    this.scene.environment = studio ? this.studioEnvironment : null
    this.scene.environmentIntensity = 0.6
    this.scene.background = studio ? new Color(0.02, 0.02, 0.022) : new Color(0x000000)
    this.applySubject()
  }

  /** The rig around the subject: scaled with it (intensities kept, so the light on it stays), shadows fitted. */
  private applySubject() {
    if (!this.rig) return
    const pose = this.pose
    this.rig.position.copy(pose.target)
    this.rig.scale.setScalar(pose.scale)
    this.rig.updateMatrixWorld(true)
    for (const [light, intensity] of this.baseIntensity) {
      const local = light instanceof PointLight || (light instanceof SpotLight && light !== this.headlamp)
      light.intensity = local ? intensity * pose.scale * pose.scale : intensity
    }
    // The headlamp lights the subject alike from any distance
    this.headlamp.intensity = (this.baseIntensity.get(this.headlamp) ?? 0) * (this.cameraDistance / HEADLAMP_DISTANCE) ** 2
    for (const light of [this.sun, this.raking, this.studioKey]) {
      const c = light.shadow.camera
      c.left = c.bottom = -pose.shadowRadius
      c.right = c.top = pose.shadowRadius
      c.far = 12 * pose.scale
      c.updateProjectionMatrix()
    }
    this.updateCamera(this.timeline.currentTime)
  }

  private get cameraDistance() {
    return this.pose.distance * this.zoom
  }

  private updateCamera(time: number) {
    if (!this.camera) return
    const pose = this.pose
    const distance = this.cameraDistance
    const azimuth = (this.orbit * Math.sin((2 * Math.PI * time) / this.timeline.duration) * Math.PI) / 180
    const elevation = (pose.elevation * Math.PI) / 180
    this.camera.position.set(
      pose.target.x + distance * Math.cos(elevation) * Math.sin(azimuth),
      pose.target.y + distance * Math.sin(elevation),
      pose.target.z + distance * Math.cos(elevation) * Math.cos(azimuth),
    )
    this.camera.lookAt(pose.target)
    this.camera.updateMatrixWorld(true)
    this.updateBackLight()
    this.notify({kind: 'other'})
  }

  /** The drapery transmits the condition's main light: the one most likely to reach its far side. */
  private updateBackLight() {
    const light: Light = {
      'Headlamp': this.headlamp,
      'Lantern': this.lantern,
      'Skylight': this.sun,
      'Show Cave': this.floodBack,
      'Raking': this.raking,
      'Studio': this.studioKey,
    }[this.condition]
    const {position, color, directional} = this.backLight
    const world = light.getWorldPosition(new Vector3())
    if (light instanceof DirectionalLight) {
      position.value.copy(world).sub(light.target.getWorldPosition(new Vector3())).normalize()
      directional.value = 1
    } else {
      position.value.copy(world)
      directional.value = 0
    }
    color.value.set(light.color.r, light.color.g, light.color.b).multiplyScalar(light.intensity)
  }

  /**
   * Light leaving a drapery through its front (`aSheet` thinner than half a metre): the irradiance on its far side from
   * the main light, unshadowed, through the slab's diffuse transmittance `t_d · exp(−σa · thickness)` (a simple
   * stand-in for Hollow's `calciteTransmission`).
   */
  private transmission(n: Node<'vec3'>) {
    const {position, color, directional} = this.backLight
    const thickness = attribute('aSheet', 'vec2').x
    const behind = n.negate()
    const far = positionWorld.add(behind.mul(thickness))
    const toLight = position.sub(far)
    const isDirectional = directional.greaterThan(0.5)
    const direction = select(isDirectional, normalize(position), normalize(toLight))
    const falloff = select(isDirectional, float(1), float(1).div(dot(toLight, toLight).max(0.04)))
    const irradiance = color.mul(max(dot(behind, direction), 0).mul(falloff))
    const transmittance = exp(CALCITE_ABSORPTION.mul(thickness).negate()).mul(CALCITE_DIFFUSE_TRANSMISSION)
    return irradiance.mul(transmittance).mul(smoothstep(0.5, 0.3, thickness)).div(Math.PI)
  }

  override onAnimate(_delta: number, time: number) {
    const u = (2 * Math.PI * time) / this.timeline.duration
    const flicker = 0.85 + 0.09 * Math.sin(41 * u) + 0.06 * Math.sin(97 * u + 1.3)
    this.lantern.intensity = (this.baseIntensity.get(this.lantern) ?? 0) * this.pose.scale ** 2 * flicker
    this.updateCamera(time)
  }

  override dispose() {
    this.stopMeshing()
    this.specimenGroup.traverse(object => {
      if (object instanceof Mesh) object.geometry.dispose()
    })
    this.surface.dispose()
    this.studioEnvironment?.dispose()
    super.dispose()
  }
}

registerEditor(HollowMaterials, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, 'Codevember 2026: Hollow materials by @arodic & cogs'),
  widgets: [
    ['condition', ioOptionSelect({model: new Menu({options: [...HOLLOW_MATERIALS_LIGHTING]})}), {label: 'lighting'}],
    ['subject', ioOptionSelect({model: new Menu({options: [...HOLLOW_MATERIALS_SUBJECTS]})})],
    ['display', ioOptionSelect({model: new Menu({options: [...HOLLOW_MATERIALS_DISPLAYS]})})],
    ['orbit', ioNumberSlider({min: 0, max: 60, step: 1})],
    ['zoom', ioNumberSlider({min: 0.15, max: 1.5, step: 0.01})],
    ['wetness', ioNumberSlider({min: -1, max: 1, step: 0.01})],
    ['iron', ioNumberSlider({min: 0, max: 2, step: 0.01})],
    ['sediment', ioNumberSlider({min: 0, max: 2, step: 0.01})],
    ['crust', ioNumberSlider({min: 0, max: 2, step: 0.01})],
    ['relief', ioNumberSlider({min: 0, max: 2, step: 0.01})],
  ],
  groups: {
    Main: ['condition', 'subject', 'display', 'orbit', 'zoom'],
    Surface: ['wetness', 'iron', 'sediment', 'crust', 'relief'],
    Hidden: [
      'camera', 'controls', 'surface', 'subjects', 'poses', 'specimenGroup', 'rig', 'aim', 'headlamp', 'lantern', 'sun',
      'skyFill', 'floodFront', 'floodBack', 'floodCool', 'raking', 'studioKey', 'studioRim', 'caveFill', 'baseIntensity',
      'studioEnvironment', 'stopMeshing', 'backLight',
    ],
  },
})
