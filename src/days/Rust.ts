import { Color, NoToneMapping, PerspectiveCamera, Vector3, WebGPURenderer } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Register, Property, div } from '@io-gui/core'
import { Document, DocumentProps, Timeline } from '@io-gui/three'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { RustClock } from './rust/RustClock.js'
import { DropModel, DropState, MAX_LARGE_DROPS, SaltField, TILE_SIZE, generateSalt } from './rust/RustSalt.js'
import { BakeData, BakeGrid, RustBake } from './rust/RustChemistry.js'
import {
  LIVE_FIELD_VIEWS, RUST_FIELD_VIEWS, RustEvents, RustFieldView, RustSection, RustSurface, SurfaceUniforms,
  createSurfaceUniforms,
} from './rust/RustSurface.js'
import { pearliteShare } from './rust/RustSteel.js'
import { MAX_TICK, RustVolume } from './rust/RustVolume.js'
import { RustSEM } from './rust/RustSEM.js'
import { SECONDS_PER_DAY } from './rust/RustScience.js'

export const RUST_STAGE_MODES = ['Overview', 'Close', 'Surface', 'Top'] as const
export type RustStageMode = typeof RUST_STAGE_MODES[number]

/** Virtual working distance (µm) of the SEM: the camera sits this far from what it looks at, with a field of view to match. */
const WORKING_DISTANCE = 10000
/** Aspect of the frame the stage composes for. */
const FRAME_ASPECT = 16 / 9

/** The periodic tile the bake runs on: 640 µm at 1.25 µm. */
const TILE_GRID: BakeGrid = {size: TILE_SIZE, resolution: 512}

/** The salt and microdroplets of `salt` (all on the tile), packed for the bake. */
function bakeData(salt: SaltField, snapshotCount: number): BakeData {
  const deposits: number[] = []
  for (const d of salt.small) deposits.push(d.x, d.z, d.edge, d.time)
  for (const d of salt.large) deposits.push(d.x, d.z, -d.edge, d.time)
  const micro: number[] = []
  const parents: number[] = []
  for (const m of salt.micro) {
    if (m.parent >= MAX_LARGE_DROPS) continue
    micro.push(m.x, m.z, m.radius, m.distance)
    parents.push(m.parent)
  }
  return {
    deposits: new Float32Array(deposits), micro: new Float32Array(micro), microParent: new Uint32Array(parents), snapshotCount,
  }
}

/** The large drops of a moment as the bake reads them: (x, z, radius, height) and (spread, wet, ·, ·) per slot. */
function packLarge(state: DropState) {
  const out = new Float32Array(MAX_LARGE_DROPS * 8)
  state.large.forEach((drop, k) => {
    out.set([drop.x, drop.z, drop.radius, drop.height], k * 4)
    out.set([drop.spread, drop.wet ? 1 : 0, 0, 0], (k + MAX_LARGE_DROPS) * 4)
  })
  return out
}

/**
 * Codevember day 11, **Rust**: a time-lapse of low-carbon steel rusting under a sea-salt crystal and its neighbours,
 * as an SEM would see it (`1 unit = 1 µm`). Phase 1: the science bake and its field views.
 *
 * The exposure clock maps the timeline onto ~30 days of marine humidity cycles (`exposureDays`, `secondsPerDay`). The
 * salt deliquesces into drops that grow, pin and dry with the humidity; a GPU bake on one periodic 640 µm tile at
 * 1.25 µm (it repeats seamlessly, so the stage can show its neighbours) runs the thin-film electrochemistry ahead of
 * the playhead (see `RustBake`), writing snapshots of the rust and nucleation events. `fieldView` shows the steel,
 * the live fields (the bake then follows the playhead) or the rust from the snapshots on a flat-shaded height field;
 * `Section` is a debug cut through the tile to compare with reference cross-sections.
 */
@Register
export class Rust extends Document {

  @Property({type: String, value: 'Overview'})
  declare stageMode: RustStageMode

  @Property({type: String, value: 'SEM'})
  declare fieldView: RustFieldView

  @Property({type: Number, value: 11})
  declare seed: number

  /** Days of exposure the timeline shows. */
  @Property({type: Number, value: 30})
  declare exposureDays: number

  /** Playback seconds per day of exposure, once the pace has ramped up (changing it rebakes nothing). */
  @Property({type: Number, value: 5})
  declare secondsPerDay: number

  /** Edge (µm) of the hero NaCl crystal. */
  @Property({type: Number, value: 28})
  declare heroCrystal: number

  /** NaCl on the surface at the start (µg/cm²), the large crystals aside. */
  @Property({type: Number, value: 20})
  declare saltLoad: number

  /** Chloride deposited per day (mg/m²/day). */
  @Property({type: Number, value: 60})
  declare chlorideDeposition: number

  /** Carbon in the steel (%), which sets its pearlite. */
  @Property({type: Number, value: 0.1})
  declare carbon: number

  /** MnS inclusion density (1 ≈ one per 2,000 µm²). */
  @Property({type: Number, value: 1})
  declare inclusions: number

  /** Vertical exaggeration of the surface. */
  @Property({type: Number, value: 1})
  declare relief: number

  /** Bake steps per frame (playback waits for the bake when it is behind). */
  @Property({type: Number, value: 2})
  declare bakeSpeed: number

  /** How far the bake has come (0–1 of the exposure). */
  @Property({type: Number, value: 0})
  declare bakeProgress: number

  private readonly camera: PerspectiveCamera
  private clock: RustClock
  private salt: SaltField | null = null
  private drops: DropModel | null = null
  private bake: RustBake | null = null
  /** The rust grown in 3D from the bake, and the SEM view of it. */
  private volume: RustVolume | null = null
  private sem: RustSEM | null = null
  /** The debug map of the tile and its eight neighbours (copies sharing it). */
  private surfaces: RustSurface[] = []
  private events: RustEvents | null = null
  private section: RustSection | null = null
  private readonly surfaceUniforms: SurfaceUniforms = createSurfaceUniforms()
  private readonly steelUniforms = {seed: uniform(11), pearlite: uniform(pearliteShare(0.1)), inclusions: uniform(1)}
  private bakeDirty = true
  private renderer: WebGPURenderer | null = null

  constructor(args?: DocumentProps) {
    const clock = new RustClock({exposureDays: 30, secondsPerDay: 5, seed: 11})
    super({
      toneMapping: NoToneMapping,
      timeline: new Timeline({autoplay: true, duration: clock.duration, loop: true, frameRate: 30}),
      ...args,
    })
    this.clock = new RustClock({exposureDays: this.exposureDays, secondsPerDay: this.secondsPerDay, seed: this.seed})
    this.timeline.duration = this.clock.duration

    const camera = new PerspectiveCamera(4, FRAME_ASPECT, WORKING_DISTANCE - 4000, WORKING_DISTANCE + 4000)
    camera.name = 'Camera'
    this.camera = camera
    this.activeCamera = camera
    this.scene.background = new Color(0.012, 0.012, 0.016)
    this.frameStage()
    this.syncView()
  }

  stageModeChanged() {
    this.frameStage()
    this.notify({kind: 'transform'})
  }

  fieldViewChanged() {
    this.syncView()
    this.frameStage()
    this.notify({kind: 'transform'})
  }

  seedChanged() { this.rebake(true) }
  exposureDaysChanged() { this.rebake(true) }
  heroCrystalChanged() { this.rebake(false) }
  saltLoadChanged() { this.rebake(false) }
  chlorideDepositionChanged() { this.rebake(false) }
  carbonChanged() { this.rebake(false) }
  inclusionsChanged() { this.rebake(false) }

  /** The pace changes how the timeline maps onto the exposure, not the exposure: nothing to rebake. */
  secondsPerDayChanged() {
    this.clock = new RustClock({exposureDays: this.exposureDays, secondsPerDay: this.secondsPerDay, seed: this.seed})
    this.timeline.duration = this.clock.duration
    this.notify({kind: 'time'})
  }

  reliefChanged() {
    this.surfaceUniforms.relief.value = this.relief
    this.notify({kind: 'material'})
  }

  randomizeSeed() {
    this.seed = Math.floor(Math.random() * 1000)
  }

  goFullscreen() {
    this.dispatch('go-fullscreen', {}, true)
  }

  private rebake(newClock: boolean) {
    if (newClock) {
      this.clock = new RustClock({exposureDays: this.exposureDays, secondsPerDay: this.secondsPerDay, seed: this.seed})
      this.timeline.duration = this.clock.duration
    }
    this.bakeDirty = true
    this.notify({kind: 'geometry'})
  }

  /** The SEM stage: a camera `WORKING_DISTANCE` from its target, tilted, with the horizontal field width as its frame. */
  private frameStage() {
    const camera = this.camera
    const section = this.fieldView === 'Section'
    const mode = section ? 'Section' : this.stageMode
    const target = new Vector3(0, 0, 0)
    let width = 480
    let tilt = 35
    let azimuth = 20
    if (mode === 'Close') { width = 110; tilt = 40; azimuth = 35; target.set(62, 2, 18) }
    if (mode === 'Surface') { width = 1150; tilt = 30 }
    if (mode === 'Top') { width = 700; tilt = 0; azimuth = 0 }
    if (mode === 'Section') { width = 700; tilt = 90; azimuth = 0; target.set(0, 120, 0) }
    const t = tilt * Math.PI / 180
    const a = azimuth * Math.PI / 180
    const direction = new Vector3(Math.sin(t) * Math.sin(a), Math.cos(t), Math.sin(t) * Math.cos(a))
    camera.position.copy(target).addScaledVector(direction, WORKING_DISTANCE)
    camera.up.set(0, 1, 0)
    if (tilt < 1) camera.up.set(0, 0, -1)
    camera.lookAt(target)
    camera.aspect = FRAME_ASPECT
    camera.fov = 2 * Math.atan(width / FRAME_ASPECT / 2 / WORKING_DISTANCE) * 180 / Math.PI
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
  }

  private syncView() {
    const view = RUST_FIELD_VIEWS.indexOf(this.fieldView)
    this.surfaceUniforms.view.value = Math.max(view, 0)
    this.surfaceUniforms.relief.value = this.relief
    if (this.events) this.events.visible = this.fieldView === 'Nucleation'
    const sem = this.fieldView === 'SEM'
    if (this.sem) this.sem.visible = sem
    for (const surface of this.surfaces) surface.visible = !sem
    if (this.section) this.section.visible = this.fieldView === 'Section'
    this.notify({kind: 'material'})
  }

  /** Whether the view shows the bake's live state (which then follows the playhead). */
  private get liveView() {
    return LIVE_FIELD_VIEWS.includes(this.fieldView)
  }

  /** The new salt, drops and bake of the current settings, and their meshes, cleared on the GPU. */
  private rebuild(renderer: WebGPURenderer) {
    this.disposeBake()
    const salt = generateSalt({
      seed: this.seed, heroEdge: this.heroCrystal, saltLoad: this.saltLoad, chlorideDeposition: this.chlorideDeposition,
      exposureDays: this.exposureDays,
    })
    this.salt = salt
    this.drops = new DropModel(this.clock, salt)
    const count = this.clock.snapshotTimes.length
    const bake = new RustBake(TILE_GRID, bakeData(salt, count))
    this.bake = bake
    const pearlite = pearliteShare(this.carbon)
    this.steelUniforms.seed.value = this.seed
    this.steelUniforms.pearlite.value = pearlite
    this.steelUniforms.inclusions.value = this.inclusions
    bake.reset(renderer, this.seed, pearlite, this.inclusions)
    this.volume = new RustVolume(bake)
    this.volume.reset(renderer, this.seed)

    const surface = new RustSurface(bake, this.surfaceUniforms, this.steelUniforms)
    this.surfaces = [surface]
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const copy = new RustSurface(bake, this.surfaceUniforms, this.steelUniforms, surface)
        copy.position.set(dx * TILE_SIZE, 0, dz * TILE_SIZE)
        this.surfaces.push(copy)
      }
    }
    this.events = new RustEvents(bake, this.surfaceUniforms)
    this.section = new RustSection(bake, this.surfaceUniforms, 0)
    this.sem = new RustSEM(this.volume, this.steelUniforms)
    this.scene.add(...this.surfaces, this.events, this.section, this.sem)
    this.syncView()
    this.bakeDirty = false
    this.notify({kind: 'structure'})
  }

  private disposeBake() {
    for (const mesh of [...this.surfaces, this.events, this.section, this.sem]) {
      if (!mesh) continue
      mesh.removeFromParent()
      mesh.dispose()
    }
    this.bake?.dispose()
    this.volume?.dispose()
    this.volume = null
    this.surfaces = []
    this.events = this.section = this.sem = null
    this.bake = null
  }

  /** Steps the bake by the clock's next step, with the drops of the moment it reaches. */
  private stepBake(renderer: WebGPURenderer, bake: RustBake) {
    const clock = this.clock
    const dt = clock.stepSize(bake.time)
    if (dt <= 0 || !this.drops) return false
    const time = bake.time + dt
    const drops = this.drops.stateAt(time)
    const layer = clock.snapshotTimes.findIndex(t => Math.abs(t - time) < 1e-6)
    bake.step(renderer, {
      time, dt, rh: clock.humidityAt(time), liquid: drops.liquid, lastDeliquescence: drops.lastDeliquescence,
      smallRadius: drops.smallRadius, smallHeight: drops.smallHeight, microScale: drops.microScale,
      large: packLarge(drops), snapshotLayer: layer,
    })
    // the volume grows what the step made, in the timeline ticks it reached
    this.volume?.grow(renderer, this.tickAt(time))
    return true
  }

  /** The volume's growth tick of exposure time `t`: the timeline cut into `MAX_TICK + 1` ticks. */
  private tickAt(t: number) {
    return this.clock.timelineAt(t) / this.clock.duration * (MAX_TICK + 1)
  }

  /** Bakes up to `target` (exposure s), at most `steps` steps. */
  private advance(renderer: WebGPURenderer, target: number, steps: number) {
    const bake = this.bake
    if (!bake) return
    for (let budget = steps; budget > 0 && bake.time < target; budget--) {
      if (!this.stepBake(renderer, bake)) break
    }
  }

  /** Exposure time (s) the bake has reached. */
  get bakedExposure() {
    return this.bake?.time ?? 0
  }

  override onRendererInitialized(renderer: WebGPURenderer) {
    this.renderer = renderer
  }

  override onAnimate() {
    this.notify({kind: 'time'})
  }

  override onBeforeDraw(renderer: WebGPURenderer) {
    this.renderer = renderer
    if (this.bakeDirty) this.rebuild(renderer)
    if (!this.bake) return
    const playhead = Math.min(this.clock.exposureAt(this.timeline.currentTime), this.clock.totalExposure)
    if (this.liveView && this.bakedExposure > playhead + 1) {
      this.rebuild(renderer)
      return
    }
    const grownTo = this.volume?.tick ?? 0
    this.advance(renderer, this.liveView ? playhead : this.clock.totalExposure, Math.max(1, Math.round(this.bakeSpeed)))
    // playback is not real time: the playhead waits for the bake where it would overtake it
    const frontier = this.clock.timelineAt(this.bakedExposure)
    if (this.bakedExposure < this.clock.totalExposure && this.timeline.currentTime > frontier + 1e-6) {
      this.timeline.currentTime = frontier
    }
    this.updateDisplay(Math.min(this.clock.exposureAt(this.timeline.currentTime), this.clock.totalExposure))
    // the SEM's density follows the playhead, and what the volume grew just past it (growing in already)
    if (this.sem?.visible && this.volume) {
      const grew = this.volume.tick !== grownTo && this.volume.tick < this.sem.tick.value + 4
      this.sem.update(renderer, grew)
    }
  }

  /** The snapshots (and their blend) that show `playhead`, as far as the bake has come. */
  private updateDisplay(playhead: number) {
    const shown = Math.min(playhead, this.bakedExposure)
    const blend = this.clock.snapshotBlend(shown)
    const bake = this.bake
    if (bake) {
      let {a, b, weight} = blend
      if (b >= bake.snapshotsWritten) {
        a = b = Math.max(Math.min(a, bake.snapshotsWritten - 1), 0)
        weight = 0
      }
      const u = this.surfaceUniforms
      u.layerA.value = a
      u.layerB.value = b
      u.weight.value = weight
      u.time.value = shown
      if (this.section) this.section.written.value = Math.min(blend.b + 1, bake.snapshotsWritten)
    }
    if (this.sem) this.sem.tick.value = this.tickAt(shown)
    const progress = this.bakedExposure / this.clock.totalExposure
    if (Math.abs(progress - this.bakeProgress) > 0.002 || (progress === 1 && this.bakeProgress !== 1)) this.bakeProgress = progress
  }

  /** Bakes (synchronously, for headless checks) until the bake reaches `days` days, and waits for the GPU. */
  async bakeUntil(days: number) {
    const renderer = this.renderer
    if (!renderer) throw new Error('Rust: no renderer yet')
    if (this.bakeDirty) this.rebuild(renderer)
    const target = Math.min(days * SECONDS_PER_DAY, this.clock.totalExposure)
    while (this.bakedExposure < target - 1e-6) this.advance(renderer, target, 64)
    if (this.bake) await renderer.getArrayBufferAsync(this.bake.eventCount)
    return this.bakedExposure / SECONDS_PER_DAY
  }

  /** Restarts the bake from bare steel (headless checks: determinism). */
  restartBake() {
    this.bakeDirty = true
  }

  /** The bake's fields, read back (headless checks). */
  async readBake() {
    const bake = this.bake
    if (!bake || !this.renderer) throw new Error('Rust: no bake yet')
    return {grid: bake.grid, time: bake.time, steps: bake.steps, ...await bake.read(this.renderer)}
  }

  /** The volume's voxel counts by kind, its column tops and crystals, read back (headless checks). */
  async readVolume() {
    if (!this.volume || !this.renderer) throw new Error('Rust: no volume yet')
    return {tick: this.volume.tick, ...await this.volume.readCounts(this.renderer)}
  }

  /** A block of the volume's voxels, read back (headless checks). */
  async readVolumeBlock(x0: number, y0: number, size: number) {
    if (!this.volume || !this.renderer) throw new Error('Rust: no volume yet')
    return this.volume.readBlock(this.renderer, x0, y0, size)
  }

  /** The drop model and salt at exposure `t` (headless checks). */
  dropsAt(t: number) {
    return {drops: this.drops?.stateAt(t), large: this.salt?.large}
  }

  override dispose() {
    this.disposeBake()
    super.dispose()
  }
}

registerEditor(Rust, {
  header: div({style: {padding: 'var(--io_spacing2)'}}, 'Codevember 2026: Rust by @arodic & cogs'),
  widgets: [
    ['stageMode', ioOptionSelect({model: new Menu({options: [...RUST_STAGE_MODES]})}), {label: 'stage'}],
    ['fieldView', ioOptionSelect({model: new Menu({options: [...RUST_FIELD_VIEWS]})}), {label: 'field'}],
    ['seed', ioNumberSlider({min: 0, max: 999, step: 1})],
    ['exposureDays', ioNumberSlider({min: 1, max: 90, step: 1}), {label: 'days'}],
    ['secondsPerDay', ioNumberSlider({min: 1, max: 30, step: 0.5}), {label: 's / day'}],
    ['heroCrystal', ioNumberSlider({min: 12, max: 45, step: 1}), {label: 'hero µm'}],
    ['saltLoad', ioNumberSlider({min: 0, max: 80, step: 1}), {label: 'salt µg/cm²'}],
    ['chlorideDeposition', ioNumberSlider({min: 0, max: 300, step: 5}), {label: 'Cl mg/m²/d'}],
    ['carbon', ioNumberSlider({min: 0.02, max: 0.6, step: 0.01}), {label: 'carbon %'}],
    ['inclusions', ioNumberSlider({min: 0, max: 3, step: 0.05}), {label: 'MnS'}],
    ['relief', ioNumberSlider({min: 0, max: 10, step: 0.1})],
    ['bakeSpeed', ioNumberSlider({min: 1, max: 12, step: 1}), {label: 'bake steps'}],
    ['bakeProgress', ioNumberSlider({min: 0, max: 1, step: 0.001}), {label: 'baked'}],
  ],
  groups: {
    Main: ['goFullscreen', 'stageMode', 'fieldView', 'seed', 'randomizeSeed', 'relief', 'bakeProgress'],
    Exposure: ['exposureDays', 'secondsPerDay'],
    Specimen: ['heroCrystal', 'saltLoad', 'chlorideDeposition', 'carbon', 'inclusions'],
    Bake: ['bakeSpeed'],
    Hidden: [
      'camera', 'clock', 'salt', 'drops', 'bake', 'volume', 'sem', 'surfaces', 'events', 'section', 'surfaceUniforms', 'steelUniforms',
      'bakeDirty', 'renderer',
    ],
  },
})
