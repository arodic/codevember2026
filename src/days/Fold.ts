import {
  ACESFilmicToneMapping, Color, CubeRenderTarget, DirectionalLight, MathUtils, Matrix3, PMREMGenerator,
  PerspectiveCamera, Scene, Vector3, WebGPURenderer,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Register, Property, div, br, span } from '@io-gui/core'
import { Bloom, Document, DocumentProps, Timeline } from '@io-gui/three'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { ioSwitch } from '@io-gui/inputs'
import { ioColorRgba } from '@io-gui/colors'
import {
  EQUATORIAL_TO_GALACTIC, FULL_MOON_LUX, MOON_ECLIPTIC_LATITUDE, OBSERVER_LATITUDE, SUN_ECLIPTIC_LONGITUDE, SUN_LUX,
  airMass, createRandom, eclipticDirection, equatorialToLocal, localSiderealTime, moonBrightness, rightAscensionOf,
} from './fold/celestial.js'
import { DEFAULT_PALETTE, FOLD_PALETTES, FoldPalette, randomPalette } from './fold/palettes.js'
import { FoldSky, SUN_INTENSITY, SkyRadianceMap, createSkyUniforms } from './fold/FoldSky.js'
import { StarField } from './fold/StarField.js'
import { Meteors } from './fold/Meteors.js'
import { NightVision } from './fold/NightVision.js'
import { ColorGrade } from './fold/ColorGrade.js'
import { TimelineFade } from '../TimelineFade.js'
import { Soundtrack } from '../Soundtrack.js'
import { CanyonPath } from './fold/CanyonPath.js'
import { FoldTerrain, TERRAIN_SIZE, createGeologyUniforms } from './fold/FoldTerrain.js'
import type { PlaybackListener } from '../IoCodevember.js'
import type { CaptureListener, CaptureStage } from '../Capture.js'

/** The soundtrack, which plays with the timeline. */
const SOUNDTRACK = new URL('./fold/CanyonHum.mp3', import.meta.url).href
/**
 * Seconds of playback, the soundtrack's length (the track's own replaces it once it has loaded): one day, or the whole
 * tectonic history, and one flight around the canyon.
 */
const DURATION = 163.92
/** The diurnal cycle opens in the late afternoon. */
const DAY_START = 16
/** Days that pass while the belt folds, in `Combined`. */
const COMBINED_DAYS = 3

/** A phone or tablet (touch first: a coarse pointer, no hover), whose GPU goes without the global illumination by default. */
const MOBILE = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

export const ANIMATION_MODES = ['Tectonic Evolution', 'Diurnal Cycle', 'Combined'] as const
export type FoldAnimation = typeof ANIMATION_MODES[number]

export const CAMERA_MODES = ['Canyon', 'Overview'] as const
export type FoldCamera = typeof CAMERA_MODES[number]

/** Ground illuminance the exposure is anchored to (a desert noon), and the exposure there. */
const NOON_LUX = 120000
const NOON_EXPOSURE = 0.15
/** How far the eye adapts: 1 would show night as bright as noon. */
const ADAPTATION = 0.86
/** How much of the adaptation is applied to the light itself (pre-exposure), keeping night in half-float range. */
const PRE_EXPOSURE = 0.8

/** Decades of illuminance below 10 lux over which vision goes over to the rods, and how far it goes. */
const SCOTOPIC_RANGE = 2.5
const SCOTOPIC_LIMIT = 0.6

/** Zenith extinction per channel, per air mass: the sun reddens and dims toward the horizon. */
const EXTINCTION = new Vector3(0.05, 0.11, 0.25)
/** Dip of the horizon from the cloud deck (some 3 km up): it keeps the sun about 1.7° after the ground loses it. */
const CLOUD_DIP = 0.03
/** Extinction of the haze near the ground per air mass, per channel, for light low over the land to the cloud deck. */
const HAZE = new Vector3(0.08, 0.1, 0.12)

/**
 * Updates the global illumination's running average spans: while the light changes (about a second of playback), right
 * after the landscape changed (the walls moved: the old light fades fast), and once everything is still, when it keeps
 * refining until it has converged. While playing it updates every `LIGHTING_INTERVAL` draws; when paused, every draw.
 */
const LIGHTING_HISTORY = 24
const LIGHTING_RESHAPED_HISTORY = 6
const LIGHTING_STILL_HISTORY = 240
const LIGHTING_INTERVAL = 2
/**
 * How far the level of the light may drift (natural log) over the span of the running average: through dawn and dusk
 * the span shortens, so the light it remembers changes as fast as the light does; a jump starts it over.
 */
const LIGHTING_DRIFT = 0.4
/** Draws a draft landscape waits before the next draft, and before it is refined once the folding stops. */
const DRAFT_INTERVAL = 2
const DRAFT_SETTLE = 8

/**
 * The canyon flight: where on the loop it starts (a fraction of its length), its height over the floor, and how far
 * ahead along the canyon it looks.
 */
const FLIGHT_START = 0.125
const FLIGHT_HEIGHT = 3.6
const LOOK_AHEAD = 18
/** Exposure added inside the canyon while the sun lights the land: its walls hide most of the sunlit ground. */
const CANYON_EXPOSURE = 1

/** The block framed from its north rim, the evening sun from the right, the galactic core over it. */
const OVERVIEW = {position: new Vector3(30, 58, -205), target: new Vector3(0, 14, 20), fov: 50}

/** A renderer's GPU work for the document: the landscape it computed, its sky environment and its lighting. */
interface RendererState {
  /** Draws so far, and the draw the landscape was last computed at (as a draft or not). */
  draw: number
  /** The animation tick the last draw saw: when it moves, the timeline is playing. */
  tick: number
  terrainDraw: number
  terrainDraft: boolean
  terrainVersion: number
  /** The canyon shape its distance field was computed for. */
  canyonVersion: number
  pmremGenerator: PMREMGenerator
  environment: CubeRenderTarget | null
  environmentVersion: number
  environmentLevel: number
  /**
   * The lighting tick its global illumination last saw, the updates its running average spans (0 starts over), and
   * the level of the light at its last update.
   */
  lightingTick: number
  lightingHistory: number
  lightingLevel: number
}

/**
 * Codevember day 1, **Fold**: an arid fold-and-thrust belt as a diorama block. Flat-lying desert strata shorten
 * into a train of plunging, en-échelon folds along an S-curved axial trace (or, with `irregularity`, into wandering
 * ridges, domes and basins), a thrust ramps its hanging wall up over the footwall, and erosion bevels the crests into
 * hogbacks, ledges and a breached core, while wind-blown sand fills the synclines. An entrenched river winds through
 * it all in a deep canyon that loops back on itself in horseshoe bends. Steep faces weather back into alcoves and
 * undercuts that overhang (`overhang`). Each point is colored from where it sits in
 * the deformed column, so cross-bedded laminae swirl over the surface and line the canyon walls, and the folds show in
 * section on the block's cut faces. Above it turns the sky over Coyote Buttes in August: Preetham daylight, twilight
 * with the Belt of Venus, cumulus racing as in a time-lapse and coming and going with the weather, a full moon, airglow, the Milky Way, Perseid shooting stars and
 * 150,000 flicker-free stars (arodic/milkyway's minimum-footprint, energy-conserving point sprites) with the Yale
 * Bright Star Catalogue's naked-eye stars in their places. Exposure adapts to the light the sky as drawn sends down;
 * light is pre-exposed so a moonless night stays in half-float range. Light bounces between the walls with the color of
 * the rock: rays marched over the height field gather the light of the surfaces they hit and of the sky (a radiance
 * map drawn from the sky's model), denoised and averaged over the updates into an irradiance that changes smoothly
 * and converges once still; with cavity and horizon occlusion from the computed fields, shadows marched toward the
 * sun or moon and a sky-only PMREM environment for reflections. A grade saturates the colors and splits warm lights
 * from cool shades. The camera flies the canyon once per playback (`cameraMode`), always below the rim. The
 * soundtrack (CanyonHum) plays with the timeline, which is as long as it, fading in from and out to black. `animationMode` maps the timeline to deep time, a day, or both; `seed` and
 * `randomizePalette` make another belt. Plays when opened.
 */
@Register
export class Fold extends Document implements PlaybackListener, CaptureListener {

  @Property({type: String, value: 'Canyon'})
  declare cameraMode: FoldCamera

  @Property({type: String, value: 'Combined'})
  declare animationMode: FoldAnimation

  /** Local solar time in hours. */
  @Property({type: Number, value: 17.6})
  declare timeOfDay: number

  /** Tectonic progress: 0 flat-lying beds, 1 the folded and eroded belt. */
  @Property({type: Number, value: 1})
  declare tectonicAge: number

  /** The belt's shape (strike, folds, thrust, beds, the canyon's loop); a new one each time the timeline loops back. */
  @Property({type: Number, value: 998})
  declare seed: number

  @Property({type: Number, value: 0.35})
  declare shortening: number

  @Property({type: Number, value: 17})
  declare foldAmplitude: number

  @Property({type: Number, value: 72})
  declare foldWavelength: number

  /** -1 box folds, 0 concentric, 1 chevron. */
  @Property({type: Number, value: 0.35})
  declare foldSharpness: number

  @Property({type: Number, value: 0.45})
  declare vergence: number

  @Property({type: Number, value: 9})
  declare axialCurvature: number

  /** 0 parallel fold trains, 1 ridges and basins wandering at random. */
  @Property({type: Number, value: 0.4})
  declare irregularity: number

  @Property({type: Number, value: 6})
  declare thrustSlip: number

  @Property({type: Number, value: 0.58})
  declare erosion: number

  @Property({type: Number, value: 2})
  declare sandFill: number

  /** Blur of the height field in texels: keeps ledges and cliffs several texels wide (no stair-stepping). */
  @Property({type: Number, value: 2.5})
  declare smoothing: number

  /**
   * How far steep faces weather back under their lips, in units: weak beds undercut beneath resistant ones, alcoves
   * along the walls, the river's notch at their foot. 0 leaves a pure height field.
   */
  @Property({type: Number, value: 4})
  declare overhang: number

  /** How deep the river cuts: 0 a shallow wash, 1 a slot canyon, 2 down near the base of the block. */
  @Property({type: Number, value: 0.75})
  declare canyonDepth: number

  /** Lobes the loop swells into, with a bend back between each two: 2 is a figure eight that never crosses. */
  @Property({type: Number, value: 2})
  declare canyonLobes: number

  @Property({type: Number, value: 40})
  declare canyonRadius: number

  /** Width of the canyon floor. */
  @Property({type: Number, value: 14})
  declare canyonWidth: number

  @Property({type: String, value: DEFAULT_PALETTE})
  declare palette: string

  /** Deep core ironstone / vermilion redbed. */
  @Property({type: Color, init: null})
  declare layerColor1: Color

  /** Canyon terracotta sandstone. */
  @Property({type: Color, init: null})
  declare layerColor2: Color

  /** Ochre / golden siltstone. */
  @Property({type: Color, init: null})
  declare layerColor3: Color

  /** Desert sage / bentonite shale. */
  @Property({type: Color, init: null})
  declare layerColor4: Color

  /** Pale buff / travertine caprock. */
  @Property({type: Color, init: null})
  declare layerColor5: Color

  /** Aeolian dune and alluvial apron sand. */
  @Property({type: Color, init: null})
  declare sandColor: Color

  /** How cloudy the weather gets: the cover swells and clears around it over the timeline (more in the afternoon). */
  @Property({type: Number, value: 0.3})
  declare cloudCoverage: number

  /** How thick the clouds are, varying with the weather too. */
  @Property({type: Number, value: 0.5})
  declare cloudDensity: number

  /** How fast the clouds race and billow: 1 a time-lapse's, 0 still. */
  @Property({type: Number, value: 1})
  declare cloudSpeed: number

  /** Volume of the soundtrack. */
  @Property({type: Number, value: 0.8})
  declare volume: number

  @Property({type: Number, value: 2.5})
  declare turbidity: number

  /** 0 new, 0.25 first quarter, 0.5 full: up all night, lighting the canyon. */
  @Property({type: Number, value: 0.5})
  declare moonPhase: number

  @Property({type: Number, value: 8})
  declare milkyWay: number

  @Property({type: Number, value: 18})
  declare starBrightness: number

  /** Half-width of the smallest footprint of a star (no smaller than a pixel) and of a meteor's width, in pixels. */
  @Property({type: Number, value: 0.5})
  declare minStarSize: number

  /** Share of the possible Perseids (2048 a loop of the timeline) that fall while the radiant is high: a shower. */
  @Property({type: Number, value: 1})
  declare shootingStars: number

  @Property({type: Boolean, value: true})
  declare autoExposure: boolean

  /** Stops above or below the adapted exposure. */
  @Property({type: Number, value: 0})
  declare exposureCompensation: number

  /** Global illumination: the light the land bounces onto itself. Off by default on phones and tablets (`MOBILE`). */
  @Property({type: Boolean, value: !MOBILE})
  declare gi: boolean

  /** Strength of the indirect light (bounced off rock and sand, and the sky's) against the sun's. */
  @Property({type: Number, value: 4})
  declare bounce: number

  /** Saturation of the indirect light (1 as gathered). */
  @Property({type: Number, value: 1.2})
  declare bounceSaturation: number

  public terrain!: FoldTerrain
  public skyDome!: FoldSky
  public stars!: StarField
  public meteors!: Meteors
  public keyLight!: DirectionalLight
  public camera!: PerspectiveCamera
  private canyon = new CanyonPath(TERRAIN_SIZE)
  private geology = createGeologyUniforms()
  private skyUniforms = createSkyUniforms(this.timeline.timeNode)
  private skyMap = new SkyRadianceMap()
  /** The key light's color times intensity (pre-exposed), for the global illumination. */
  private keyRadiance = uniform(new Vector3())
  /** The light on level ground from the sky and the key light (pre-exposed), the global illumination's unit. */
  private lightLevel = uniform(1)
  private giStrength = uniform(1)
  private bounceStrength = uniform(1)
  private bounceSaturationNode = uniform(1.2)
  private environmentScene = new Scene()
  private environmentSky!: FoldSky
  private celestialFrame = new Matrix3()
  private sunDirection = new Vector3()
  private moonDirection = new Vector3()
  private cameraTarget = new Vector3()
  /** The camera's angle around the canyon loop. */
  private flightAngle = 0
  /** The light the environment sees now: the pre-exposed illuminance of the ground. */
  private indirectLevel = 1
  /** Bumped by every change of the light or the land (the global illumination updates); and when it must start over. */
  private lightingTick = 0
  /** Bumped when the landscape must be computed again. */
  private terrainVersion = 0
  /** Whether the timeline is folding the belt (the landscape is computed as drafts meanwhile). */
  private animating = false
  /** The timeline time the clouds' clock last moved for. */
  private cloudsAt = 0
  /** The timeline time `onAnimate` last ran for: a jump back to the start while playing is the loop's wrap. */
  private animatedAt = 0
  /** The soundtrack, which makes the timeline as long as itself; whether the editor plays the document. */
  private soundtrack = new Soundtrack(SOUNDTRACK, this)
  private playing = false
  /**
   * What a frame capture does (`CaptureListener`): while it captures the landscape is computed in full at once (no
   * drafts, every frame is a still); through a frame's subframes the global illumination goes on refining (its
   * running average is not shortened by the light and land moving the fraction of a frame between them).
   */
  private captureStage: CaptureStage = 'off'
  /** Counts `onAnimate` calls. */
  private animationTick = 0
  private terrainDraft = false
  /** Bumped when the sky environment must be captured again. */
  private environmentVersion = 0
  /** Bumped when the environment must be captured again. */
  private lightingVersion = 0
  /** Key direction and pre-exposure the last lighting version was made for. */
  private litDirection = new Vector3()
  private litPreExposure = 1
  private renderers = new WeakMap<WebGPURenderer, RendererState>()

  constructor(args?: DocumentProps) {
    super({
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: NOON_EXPOSURE,
      effects: [new Bloom({strength: 0.04, radius: 0.2, threshold: 0}), new ColorGrade(), new NightVision(), new TimelineFade()],
      timeline: new Timeline({autoplay: false, duration: DURATION}),
      ...args,
    })

    this.soundtrack.volume = this.volume

    this.camera = new PerspectiveCamera(58, 2.39 / 1, 0.2, 20000)
    this.camera.name = 'Camera'
    this.activeCamera = this.camera

    this.skyDome = new FoldSky(this.skyUniforms)
    this.scene.add(this.skyDome)

    this.environmentSky = new FoldSky(this.skyUniforms)
    this.environmentSky.showDiscs.value = 0
    this.environmentScene.add(this.environmentSky)

    this.stars = new StarField(this.skyUniforms)
    this.meteors = new Meteors(this.skyUniforms, this.stars.minSize)
    this.scene.add(this.stars, this.meteors)

    this.terrain = new FoldTerrain(this.geology, this.skyUniforms, this.canyon, {
      skyMap: this.skyMap.texture,
      keyRadiance: this.keyRadiance,
      level: this.lightLevel,
      gi: this.giStrength,
      bounce: this.bounceStrength,
      saturation: this.bounceSaturationNode,
    })
    this.scene.add(this.terrain.surface, this.terrain.sides)

    // the key light: the sun by day, the moon by night. Nothing casts into its shadow map; the strata receive the
    // shadows they march over the height field
    this.keyLight = new DirectionalLight()
    this.keyLight.name = 'Key Light'
    this.keyLight.castShadow = true
    this.keyLight.shadow.mapSize.set(64, 64)
    this.scene.add(this.keyLight)

    this.applyPalette(FOLD_PALETTES[this.palette])
    this.applySeed()
    this.applySkySettings()
    this.giChanged()
    this.bounceChanged()
    this.bounceSaturationChanged()
    this.updateCamera()
  }

  /** The sky and the stars dwarf the block. */
  override getEditorFrameTarget() {
    return this.terrain ? this.terrain.surface : null
  }

  randomizeSeed = () => {
    this.seed = Math.floor(Math.random() * 1000)
  }

  randomizePalette = () => {
    this.applyPalette(randomPalette(createRandom(Math.floor(Math.random() * 2 ** 31))))
    this.palette = 'Random'
  }

  override onAnimate(_delta: number, time: number) {
    const progress = time / this.timeline.duration
    const loopedBack = this.playing && time < this.animatedAt - this.timeline.duration / 2
    this.animatedAt = time
    this.animationTick++
    this.animating = true
    try {
      // each loop of the timeline (behind its fade to black) shows another belt
      if (loopedBack) this.randomizeSeed()
      if (this.animationMode !== 'Diurnal Cycle') this.tectonicAge = Math.min(progress * 1.2, 1)
      if (this.animationMode === 'Diurnal Cycle') this.timeOfDay = (DAY_START + 24 * progress) % 24
      if (this.animationMode === 'Combined') this.timeOfDay = (DAY_START + 24 * COMBINED_DAYS * progress) % 24
    } finally {
      this.animating = false
    }
    this.meteors.loop.value = this.timeline.duration
    this.soundtrack.sync(time)
    this.advanceClouds(time)
    this.applyWeather()
    this.updateCamera()
  }

  /** A frame capture started, stopped or moved through a frame (`CaptureListener`). */
  captureChanged(stage: CaptureStage) {
    this.captureStage = stage
  }

  /** The editor started or stopped playing the document (`PlaybackListener`): the soundtrack plays along. */
  playbackChanged(playing: boolean) {
    this.playing = playing
    this.soundtrack.playbackChanged(playing)
  }

  volumeChanged() {
    if (this.soundtrack) this.soundtrack.volume = this.volume
  }

  /**
   * Moves the clouds' clock by the playback time since the last call at `cloudSpeed` (across the loop's wrap it keeps
   * going), so changing the speed changes how they move from here on and never makes them jump.
   */
  private advanceClouds(time: number) {
    let delta = time - this.cloudsAt
    if (delta < -this.timeline.duration / 2) delta += this.timeline.duration
    this.cloudsAt = time
    this.skyUniforms.cloudTime.value += delta * this.cloudSpeed
  }

  cameraModeChanged() {
    this.updateCamera()
    this.updateSky()
  }
  seedChanged() { this.applySeed() }
  canyonLobesChanged() { this.applySeed() }
  tectonicAgeChanged() { this.applyGeology() }
  shorteningChanged() { this.applyGeology() }
  foldAmplitudeChanged() { this.applyGeology() }
  foldWavelengthChanged() { this.applyGeology() }
  foldSharpnessChanged() { this.applyGeology() }
  vergenceChanged() { this.applyGeology() }
  axialCurvatureChanged() { this.applyGeology() }
  irregularityChanged() { this.applyGeology() }
  thrustSlipChanged() { this.applyGeology() }
  erosionChanged() { this.applyGeology() }
  sandFillChanged() { this.applyGeology() }
  smoothingChanged() { this.applyGeology() }
  overhangChanged() { this.applyGeology() }
  canyonDepthChanged() { this.applyGeology() }
  canyonRadiusChanged() { this.applyGeology() }
  canyonWidthChanged() { this.applyGeology() }

  paletteChanged() {
    if (this.palette === 'Random') return
    const palette = FOLD_PALETTES[this.palette]
    if (palette) this.applyPalette(palette)
  }

  layerColor1Changed() { this.layerColor1Mutated() }
  layerColor2Changed() { this.layerColor2Mutated() }
  layerColor3Changed() { this.layerColor3Mutated() }
  layerColor4Changed() { this.layerColor4Mutated() }
  layerColor5Changed() { this.layerColor5Mutated() }
  sandColorChanged() { this.sandColorMutated() }

  /** The color editors change the colors in place. */
  layerColor1Mutated() { this.copyColor(this.geology.layer1.value, this.layerColor1) }
  layerColor2Mutated() { this.copyColor(this.geology.layer2.value, this.layerColor2) }
  layerColor3Mutated() { this.copyColor(this.geology.layer3.value, this.layerColor3) }
  layerColor4Mutated() { this.copyColor(this.geology.layer4.value, this.layerColor4) }
  layerColor5Mutated() { this.copyColor(this.geology.layer5.value, this.layerColor5) }
  sandColorMutated() { this.copyColor(this.geology.sand.value, this.sandColor) }

  timeOfDayChanged() {
    this.applyWeather()
    this.updateSky()
  }
  moonPhaseChanged() { this.updateSky() }
  autoExposureChanged() { this.updateSky() }
  exposureCompensationChanged() { this.updateSky() }
  cloudCoverageChanged() { this.applySkySettings() }
  cloudDensityChanged() { this.applySkySettings() }
  turbidityChanged() { this.applySkySettings() }
  milkyWayChanged() { this.applySkySettings() }
  starBrightnessChanged() { this.applySkySettings() }
  minStarSizeChanged() { this.applySkySettings() }
  shootingStarsChanged() { this.applySkySettings() }

  giChanged() {
    this.giStrength.value = this.gi ? 1 : 0
    this.updateSky()
  }

  bounceChanged() {
    this.bounceStrength.value = this.bounce
    this.updateSky()
  }

  bounceSaturationChanged() {
    this.bounceSaturationNode.value = this.bounceSaturation
  }

  private applyPalette(palette: FoldPalette) {
    if (!this.layerColor1) return
    const colors = [this.layerColor1, this.layerColor2, this.layerColor3, this.layerColor4, this.layerColor5, this.sandColor]
    colors.forEach((color, i) => color.set(palette[i]))
    colors.forEach(color => this.dispatchMutation(color))
  }

  private copyColor(target: Color, source: Color) {
    target.copy(source)
    this.lightingTick++
  }

  /**
   * The belt's shape from the seed: strike, axial bends, plunge, cross folds, irregular warp, thrust trace, bed
   * sequence and the canyon's loop.
   */
  private applySeed() {
    if (!this.terrain) return
    const random = createRandom(this.seed)
    const g = this.geology
    const strike = 0.35 + (random() - 0.5) * 0.9
    g.strike.value.set(Math.cos(strike), Math.sin(strike))
    g.curve.value.set(0.012 + random() * 0.02, random() * Math.PI * 2, 1.8 + random(), random() * Math.PI * 2)
    g.plunge.value.set(0.015 + random() * 0.02, random() * Math.PI * 2, 0.3 + random() * 0.6)
    g.foldPhase.value = Math.PI / 2 + (random() - 0.5) * 0.8
    const ramp = MathUtils.degToRad(25 + random() * 15)
    g.thrust.value.set(14 + random() * 22, Math.tan(ramp), Math.sin(ramp), random() < 0.5 ? -1 : 1)
    g.noiseOffset.value.set(random() * 100, random() * 100, random() * 100)
    g.bedSeed.value = Math.floor(random() * 1000)
    const cross = strike + Math.PI / 2 + (random() - 0.5) * 0.9
    g.crossStrike.value.set(Math.cos(cross), Math.sin(cross), random() * Math.PI * 2)
    g.warpSeed.value.set(random() * 100, random() * 100, random() * 100, random() * 100)
    this.canyon.randomize(random, MathUtils.clamp(Math.round(this.canyonLobes), 2, 5))
    this.applyGeology()
  }

  private applyGeology() {
    if (!this.terrain) return
    const g = this.geology
    g.age.value = this.tectonicAge
    g.shortening.value = this.shortening
    g.amplitude.value = this.foldAmplitude
    g.wavelength.value = this.foldWavelength
    g.sharpness.value = this.foldSharpness
    g.vergence.value = this.vergence
    g.axialCurvature.value = this.axialCurvature
    g.irregularity.value = this.irregularity
    g.thrustSlip.value = this.thrustSlip
    g.erosion.value = this.erosion
    g.sandFill.value = this.sandFill
    g.smoothing.value = this.smoothing
    g.overhang.value = this.overhang

    // the river keeps pace with the uplift: its floor sinks as the belt rises, independent of the folds under it
    const age = MathUtils.clamp(this.tectonicAge, 0, 1)
    const incision = 0.15 + 0.85 * age * age * (3 - 2 * age)
    const canyon = this.canyon
    canyon.radius = this.canyonRadius
    canyon.halfWidth = this.canyonWidth / 2
    canyon.floor = -(6 + 16 * this.canyonDepth) * incision
    canyon.sync()

    this.terrainDraft = this.animating && this.captureStage === 'off'
    this.terrainVersion++
    this.lightingTick++
    this.updateCamera()
  }

  /**
   * The weather at the timeline's time: the cloud cover swells and clears over the loop (a few looping harmonics, as
   * over days) and cumulus build through the afternoon and die away by night; `cloudCoverage` and `cloudDensity` set
   * how much of it there is.
   */
  private applyWeather() {
    if (!this.terrain) return
    const progress = this.timeline.currentTime / this.timeline.duration
    const swell = 0.5 + 0.3 * Math.sin(Math.PI * 2 * 2 * progress + 0.7) + 0.2 * Math.sin(Math.PI * 2 * 5 * progress + 2.1)
    const afternoon = Math.max(0, Math.sin((this.timeOfDay - 9) / 14 * Math.PI))
    const weather = MathUtils.clamp(swell * (0.55 + 0.45 * afternoon), 0, 1)
    const sky = this.skyUniforms
    sky.cloudCoverage.value = MathUtils.clamp(this.cloudCoverage * (0.2 + 1.6 * weather), 0, 1)
    sky.cloudDensity.value = this.cloudDensity * (0.7 + 0.6 * weather)
  }

  private applySkySettings() {
    if (!this.terrain) return
    const sky = this.skyUniforms
    this.applyWeather()
    sky.turbidity.value = this.turbidity
    sky.milkyWay.value = this.milkyWay
    this.stars.brightness.value = this.starBrightness
    this.stars.minSize.value = this.minStarSize
    this.meteors.rate.value = this.shootingStars
    this.updateSky()
    this.environmentVersion++
    this.lightingVersion++
  }

  /**
   * The camera: in `Canyon` it flies the loop once per playback at an even speed, a few units over the floor,
   * weaving gently and looking ahead and up the walls, so the rim always hides the horizon; in `Overview` it frames
   * the block.
   */
  private updateCamera() {
    if (!this.camera) return
    const camera = this.camera
    if (this.cameraMode === 'Overview') {
      camera.position.copy(OVERVIEW.position)
      camera.lookAt(OVERVIEW.target)
      if (camera.fov !== OVERVIEW.fov) camera.fov = OVERVIEW.fov
    } else {
      const canyon = this.canyon
      const fraction = FLIGHT_START - this.timeline.currentTime / this.timeline.duration
      const turn = fraction * Math.PI * 2
      this.flightAngle = canyon.angleAt(fraction)
      const height = canyon.floor + FLIGHT_HEIGHT + Math.sin(turn * 5 + 1.3) * 0.8
      canyon.pointAt(this.flightAngle, height, camera.position, Math.sin(turn * 7 + 0.6) * 0.7)
      const ahead = fraction - LOOK_AHEAD / canyon.length
      const lookUp = 0.5 + 0.5 * Math.sin(turn * 3 + 0.4)
      const aheadHeight = canyon.floor + FLIGHT_HEIGHT + 0.5 + lookUp * 5
      canyon.pointAt(canyon.angleAt(ahead), aheadHeight, this.cameraTarget, Math.sin(ahead * Math.PI * 14 + 0.6) * 0.6)
      camera.lookAt(this.cameraTarget)
      if (camera.fov !== 58) camera.fov = 58
    }
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }

  /**
   * Turns the sky to the time of day and places the sun and the moon in it, adapts the exposure to the light on the
   * ground (the sky as drawn, integrated, and the sun or moon), and aims the key light (the brighter of the two).
   */
  private updateSky() {
    if (!this.terrain) return
    const sky = this.skyUniforms

    const sunEquatorial = eclipticDirection(SUN_ECLIPTIC_LONGITUDE, new Vector3())
    const siderealTime = localSiderealTime(this.timeOfDay, rightAscensionOf(sunEquatorial))
    const frame = equatorialToLocal(siderealTime, OBSERVER_LATITUDE, this.celestialFrame)
    sky.celestialFrame.value.copy(frame)
    sky.galacticFrame.value.multiplyMatrices(EQUATORIAL_TO_GALACTIC, frame.clone().transpose())

    const sun = this.sunDirection.copy(sunEquatorial).applyMatrix3(frame).normalize()
    const moonLongitude = SUN_ECLIPTIC_LONGITUDE + this.moonPhase * Math.PI * 2
    const moon = eclipticDirection(moonLongitude, this.moonDirection, MOON_ECLIPTIC_LATITUDE).applyMatrix3(frame).normalize()
    sky.sunDirection.value.copy(sun)
    sky.moonDirection.value.copy(moon)
    sky.moonLight.value = FULL_MOON_LUX / SUN_LUX * moonBrightness(this.moonPhase)

    const sunAltitude = Math.asin(sun.y)
    const moonAltitude = Math.asin(moon.y)
    const sunColor = transmittance(sunAltitude, new Color())
    const sunIntensity = SUN_INTENSITY * colorLuminance(sunColor) * MathUtils.smoothstep(sunAltitude, -0.015, 0.02)
    const moonColor = transmittance(moonAltitude, new Color()).multiply(new Color(0.78, 0.86, 1.0))
    const moonIntensity = SUN_INTENSITY * sky.moonLight.value * colorLuminance(moonColor) * MathUtils.smoothstep(moonAltitude, -0.015, 0.02)
    // the cloud deck sees the sun and the moon a little longer than the ground does, low through the most air and
    // the haze of the air near the ground
    const deckSun = transmittance(sunAltitude + CLOUD_DIP, new Color()).multiply(haze(sunAltitude + CLOUD_DIP))
    sky.sunIrradiance.value.set(deckSun.r, deckSun.g, deckSun.b).multiplyScalar(SUN_INTENSITY * MathUtils.smoothstep(sunAltitude + CLOUD_DIP, -0.01, 0.01))
    const deckMoon = transmittance(moonAltitude + CLOUD_DIP, new Color()).multiply(haze(moonAltitude + CLOUD_DIP)).multiply(new Color(0.78, 0.86, 1.0))
    sky.moonIrradiance.value.set(deckMoon.r, deckMoon.g, deckMoon.b)
      .multiplyScalar(SUN_INTENSITY * sky.moonLight.value * MathUtils.smoothstep(moonAltitude + CLOUD_DIP, -0.01, 0.01))

    // the light on level ground: the sky as drawn (at the strength the indirect light passes it on), and the sun and the moon
    // through the clouds' shadows
    const cloudShade = 1 - 0.5 * sky.cloudCoverage.value * Math.min(sky.cloudDensity.value * 2, 1)
    const direct = (sunIntensity * Math.max(sun.y, 0) + moonIntensity * Math.max(moon.y, 0)) * cloudShade
    this.skyMap.update(sky)
    const ground = this.skyMap.irradiance * (this.gi ? this.bounce : 1) + direct
    const illuminance = ground * SUN_LUX / SUN_INTENSITY
    const adaptation = NOON_LUX / illuminance
    const preExposure = this.autoExposure ? Math.pow(adaptation, PRE_EXPOSURE) : 1
    sky.preExposure.value = preExposure
    this.indirectLevel = ground * preExposure
    this.lightLevel.value = Math.max((this.skyMap.irradiance + direct) * preExposure, 1e-9)
    if (this.autoExposure) {
      const shade = this.cameraMode === 'Canyon' ? CANYON_EXPOSURE * direct / ground : 0
      const stops = this.exposureCompensation + shade
      this.toneMappingExposure = NOON_EXPOSURE * Math.pow(2, stops) * Math.pow(adaptation, ADAPTATION) / preExposure
    }
    const nightVision = this.effects.find(effect => effect instanceof NightVision)
    if (nightVision) nightVision.scotopic = this.autoExposure ? MathUtils.clamp((1 - Math.log10(illuminance)) / SCOTOPIC_RANGE, 0, 1) * SCOTOPIC_LIMIT : 0
    const grade = this.effects.find(effect => effect instanceof ColorGrade)
    const sunDegrees = MathUtils.radToDeg(sunAltitude)
    if (grade) grade.goldenHour = MathUtils.smoothstep(sunDegrees, -12, -2) * (1 - MathUtils.smoothstep(sunDegrees, 8, 18))

    const useSun = sunIntensity >= moonIntensity
    const key = useSun ? sun : moon
    const keyLight = this.keyLight
    keyLight.color.copy(useSun ? sunColor : moonColor).multiplyScalar(1 / Math.max(colorLuminance(useSun ? sunColor : moonColor), 1e-6))
    keyLight.intensity = (useSun ? sunIntensity : moonIntensity) * preExposure
    keyLight.position.copy(key).multiplyScalar(400)
    this.geology.keyDirection.value.copy(key)
    this.keyRadiance.value.set(keyLight.color.r, keyLight.color.g, keyLight.color.b).multiplyScalar(keyLight.intensity)
    this.lightingTick++

    this.stars.visible = this.meteors.visible = sunAltitude < MathUtils.degToRad(6)

    if (key.angleTo(this.litDirection) > MathUtils.degToRad(1.5) || Math.abs(Math.log(preExposure / this.litPreExposure)) > 0.1) {
      this.litDirection.copy(key)
      this.litPreExposure = preExposure
      this.environmentVersion++
      this.lightingVersion++
    }
  }

  /** The environment keeps the light it was captured in until captured again: scale it to the light now. */
  private updateEnvironmentIntensity(state: RendererState) {
    this.scene.environmentIntensity = (this.gi ? 0.2 : 1) * this.indirectLevel / state.environmentLevel
  }

  /**
   * One update of the global illumination: a new estimate folded into its running average (relative to the level of
   * the light). The average spans the last `LIGHTING_HISTORY` updates while the light changes, so the light follows
   * the sun within a second, and fewer while the level of the light drifts fast (`LIGHTING_DRIFT`); once nothing
   * changes it keeps growing, refining the light (when paused, every draw) until it spans `LIGHTING_STILL_HISTORY`
   * and has converged. Through a capture's subframes it keeps growing whatever changes (the fraction of a frame).
   */
  private updateLighting(renderer: WebGPURenderer, state: RendererState, playing: boolean) {
    const held = this.captureStage === 'subframes'
    const changing = !held && (playing || state.lightingTick !== this.lightingTick)
    state.lightingTick = this.lightingTick
    if (changing) state.lightingHistory = Math.min(state.lightingHistory, LIGHTING_HISTORY)
    else if (state.lightingHistory >= LIGHTING_STILL_HISTORY && !held) return
    if (playing && !held && state.draw % LIGHTING_INTERVAL !== 0) return
    const level = this.lightLevel.value
    const drift = Math.abs(Math.log(level / state.lightingLevel))
    if (drift > 0 && !held) state.lightingHistory = Math.min(state.lightingHistory, Math.floor(LIGHTING_DRIFT / drift))
    state.lightingHistory++
    state.lightingLevel = level
    this.terrain.updateLighting(renderer, 1 / state.lightingHistory, state.draw)
    this.notify({kind: 'other'})
  }

  /**
   * Computes the landscape after a change of the geology (while the timeline folds the belt, as drafts every few
   * draws, refined once it stops), captures the sky environment after the sky changed, and updates the global
   * illumination. Each renderer keeps its own copies.
   */
  override onBeforeDraw(renderer: WebGPURenderer) {
    let state = this.renderers.get(renderer)
    if (!state) {
      state = {
        draw: 0, tick: this.animationTick, terrainDraw: -Infinity, terrainDraft: false, terrainVersion: -1, canyonVersion: -1,
        pmremGenerator: new PMREMGenerator(renderer), environment: null, environmentVersion: -1, environmentLevel: 1,
        lightingTick: -1, lightingHistory: 0, lightingLevel: this.lightLevel.value,
      }
      this.renderers.set(renderer, state)
    }
    state.draw++
    const playing = state.tick !== this.animationTick
    state.tick = this.animationTick

    const sinceTerrain = state.draw - state.terrainDraw
    if (state.terrainVersion !== this.terrainVersion && (!this.terrainDraft || sinceTerrain >= DRAFT_INTERVAL)) {
      if (state.canyonVersion !== this.canyon.shapeVersion) {
        this.canyon.update(renderer)
        state.canyonVersion = this.canyon.shapeVersion
      }
      this.terrain.update(renderer, this.terrainDraft)
      state.terrainVersion = this.terrainVersion
      state.terrainDraft = this.terrainDraft
      state.terrainDraw = state.draw
      if (this.captureStage !== 'subframes') state.lightingHistory = Math.min(state.lightingHistory, LIGHTING_RESHAPED_HISTORY)
    } else if (state.terrainVersion === this.terrainVersion && state.terrainDraft && sinceTerrain >= DRAFT_SETTLE) {
      this.terrain.update(renderer, false)
      state.terrainDraft = false
      state.terrainDraw = state.draw
      if (this.captureStage !== 'subframes') state.lightingHistory = Math.min(state.lightingHistory, LIGHTING_RESHAPED_HISTORY)
    }
    if (state.terrainVersion !== this.terrainVersion || state.terrainDraft) this.notify({kind: 'other'})

    if (state.environmentVersion !== this.environmentVersion) {
      // one render target keeps the texture's identity: a new texture would recompile every material
      state.environment = state.pmremGenerator.fromScene(this.environmentScene, 0, 0.1, 100, {renderTarget: state.environment})
      this.scene.environment = state.environment.texture
      state.environmentVersion = this.environmentVersion
      state.environmentLevel = this.indirectLevel
    }

    // switched off, it starts over when switched back on
    if (this.gi) this.updateLighting(renderer, state, playing)
    else state.lightingHistory = 0
    this.updateEnvironmentIntensity(state)
  }

  goFullscreen() {
    this.dispatch('go-fullscreen', {}, true)
  }

  override dispose() {
    this.playing = false
    this.soundtrack.dispose()
    this.terrain.dispose()
    this.skyDome.dispose()
    this.environmentSky.dispose()
    this.stars.dispose()
    this.meteors.dispose()
    this.skyMap.dispose()
    super.dispose()
  }
}

/** Sunlight (or moonlight) through the air toward an altitude, per channel; its luminance is the dimming. */
function transmittance(altitude: number, target: Color) {
  const mass = airMass(altitude)
  return target.setRGB(Math.exp(-EXTINCTION.x * mass), Math.exp(-EXTINCTION.y * mass), Math.exp(-EXTINCTION.z * mass))
}

/** Haze of the boundary layer a low light reaches the cloud deck through, per channel. */
function haze(altitude: number) {
  const mass = airMass(altitude)
  return new Color(Math.exp(-HAZE.x * mass), Math.exp(-HAZE.y * mass), Math.exp(-HAZE.z * mass))
}

function colorLuminance(color: Color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

registerEditor(Fold, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, [
    'Codevember 2026: Fold by @arodic & cogs', br(),
    span({class: 'keymap'}, 'esc: debug'),
  ]),
  widgets: [
    ['cameraMode', ioOptionSelect({model: new Menu({options: [...CAMERA_MODES]})}), {label: 'camera'}],
    ['animationMode', ioOptionSelect({model: new Menu({options: [...ANIMATION_MODES]})}), {label: 'animate'}],
    ['timeOfDay', ioNumberSlider({min: 0, max: 24, step: 0.05})],
    ['tectonicAge', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'age'}],
    ['seed', ioNumberSlider({min: 0, max: 999, step: 1})],
    ['palette', ioOptionSelect({model: new Menu({options: [...Object.keys(FOLD_PALETTES), 'Random']})})],
    ['shortening', ioNumberSlider({min: 0, max: 0.6, step: 0.01}), {label: 'shorten'}],
    ['foldAmplitude', ioNumberSlider({min: 0, max: 30, step: 0.1}), {label: 'amplitude'}],
    ['foldWavelength', ioNumberSlider({min: 30, max: 140, step: 1}), {label: 'spacing'}],
    ['foldSharpness', ioNumberSlider({min: -1, max: 1, step: 0.01}), {label: 'sharpness'}],
    ['vergence', ioNumberSlider({min: -0.9, max: 0.9, step: 0.01})],
    ['axialCurvature', ioNumberSlider({min: 0, max: 30, step: 0.1}), {label: 'curvature'}],
    ['irregularity', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'irregular'}],
    ['thrustSlip', ioNumberSlider({min: 0, max: 20, step: 0.1}), {label: 'thrust'}],
    ['erosion', ioNumberSlider({min: 0, max: 1, step: 0.01})],
    ['sandFill', ioNumberSlider({min: 0, max: 12, step: 0.1}), {label: 'sand'}],
    ['smoothing', ioNumberSlider({min: 0, max: 4, step: 0.05})],
    ['overhang', ioNumberSlider({min: 0, max: 4, step: 0.01})],
    ['canyonDepth', ioNumberSlider({min: 0, max: 2, step: 0.01}), {label: 'depth'}],
    ['canyonLobes', ioNumberSlider({min: 2, max: 5, step: 1}), {label: 'lobes'}],
    ['canyonRadius', ioNumberSlider({min: 24, max: 44, step: 0.5}), {label: 'radius'}],
    ['canyonWidth', ioNumberSlider({min: 6, max: 24, step: 0.1}), {label: 'width'}],
    ['layerColor1', ioColorRgba(), {label: 'redbed'}],
    ['layerColor2', ioColorRgba(), {label: 'sandstone'}],
    ['layerColor3', ioColorRgba(), {label: 'siltstone'}],
    ['layerColor4', ioColorRgba(), {label: 'shale'}],
    ['layerColor5', ioColorRgba(), {label: 'caprock'}],
    ['sandColor', ioColorRgba(), {label: 'sand'}],
    ['cloudCoverage', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'clouds'}],
    ['cloudDensity', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'density'}],
    ['cloudSpeed', ioNumberSlider({min: 0, max: 4, step: 0.01}), {label: 'cloudSpeed'}],
    ['volume', ioNumberSlider({min: 0, max: 1, step: 0.01})],
    ['turbidity', ioNumberSlider({min: 1, max: 10, step: 0.1})],
    ['moonPhase', ioNumberSlider({min: 0, max: 1, step: 0.01})],
    ['milkyWay', ioNumberSlider({min: 0, max: 3, step: 0.01})],
    ['starBrightness', ioNumberSlider({min: 0, max: 4, step: 0.01}), {label: 'stars'}],
    ['minStarSize', ioNumberSlider({min: 0.5, max: 4, step: 0.05}), {label: 'starSize'}],
    ['shootingStars', ioNumberSlider({min: 0, max: 1, step: 0.01}), {label: 'meteors'}],
    ['autoExposure', ioSwitch(), {label: 'adapt'}],
    ['exposureCompensation', ioNumberSlider({min: -4, max: 4, step: 0.1}), {label: 'exposure'}],
    ['bounce', ioNumberSlider({min: 0, max: 4, step: 0.05})],
    ['bounceSaturation', ioNumberSlider({min: 0, max: 2.5, step: 0.05}), {label: 'saturate'}],
  ],
  groups: {
    Main: ['goFullscreen', 'cameraMode', 'animationMode', 'timeOfDay', 'tectonicAge', 'seed', 'randomizeSeed', 'palette', 'randomizePalette', 'volume'],
    Geology: [
      'shortening', 'foldAmplitude', 'foldWavelength', 'foldSharpness', 'vergence', 'axialCurvature', 'irregularity',
      'thrustSlip', 'erosion', 'sandFill', 'smoothing', 'overhang',
    ],
    Canyon: ['canyonDepth', 'canyonLobes', 'canyonRadius', 'canyonWidth'],
    Palette: ['layerColor1', 'layerColor2', 'layerColor3', 'layerColor4', 'layerColor5', 'sandColor'],
    Sky: ['cloudCoverage', 'cloudDensity', 'cloudSpeed', 'turbidity', 'moonPhase', 'milkyWay', 'starBrightness', 'minStarSize', 'shootingStars'],
    Lighting: ['autoExposure', 'exposureCompensation', 'gi', 'bounce', 'bounceSaturation'],
    Hidden: [
      'terrain', 'skyDome', 'stars', 'meteors', 'keyLight', 'camera', 'canyon', 'geology', 'skyUniforms', 'skyMap',
      'keyRadiance', 'lightLevel', 'giStrength', 'bounceStrength', 'bounceSaturationNode', 'environmentScene', 'environmentSky',
      'celestialFrame', 'sunDirection', 'moonDirection', 'cameraTarget', 'flightAngle', 'indirectLevel', 'lightingTick',
      'terrainVersion', 'animating', 'animationTick', 'terrainDraft', 'environmentVersion',
      'lightingVersion', 'litDirection', 'litPreExposure', 'renderers', 'cloudsAt', 'animatedAt', 'soundtrack', 'playing',
      'captureStage',
    ],
  },
})
