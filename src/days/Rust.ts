import { Color, NoToneMapping, PerspectiveCamera, Vector3, WebGPURenderer } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Register, Property, div } from '@io-gui/core'
import { Document, DocumentProps, Timeline } from '@io-gui/three'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { RustClock } from './rust/RustClock.js'
import { CORE_SIZE, DropModel, DropState, MAX_LARGE_DROPS, SURROUND_SIZE, SaltField, generateSalt } from './rust/RustSalt.js'
import { BakeData, BakeGrid, RustBake } from './rust/RustChemistry.js'
import {
  LIVE_FIELD_VIEWS, RUST_FIELD_VIEWS, RustEvents, RustFieldView, RustSection, RustSurface, SurfaceUniforms,
  createSurfaceUniforms,
} from './rust/RustSurface.js'
import { pearliteShare } from './rust/RustSteel.js'
import { SECONDS_PER_DAY } from './rust/RustScience.js'

export const RUST_STAGE_MODES = ['Overview', 'Surface', 'Top'] as const
export type RustStageMode = typeof RUST_STAGE_MODES[number]

/** Virtual working distance (µm) of the SEM: the camera sits this far from what it looks at, with a field of view to match. */
const WORKING_DISTANCE = 10000
/** Aspect of the frame the stage composes for. */
const FRAME_ASPECT = 16 / 9

const CORE_GRID: BakeGrid = {
  name: 'core', size: CORE_SIZE, resolution: 512, centerX: 0, centerZ: 0, snapshotDownsample: 1, stepScale: 1,
}
const SURROUND_GRID: BakeGrid = {
  name: 'surround', size: SURROUND_SIZE, resolution: 512, centerX: 0, centerZ: 0, snapshotDownsample: 2, stepScale: 2,
}

/** The salt and microdroplets of `salt` that lie inside `grid`, packed for its bake. */
function bakeData(salt: SaltField, grid: BakeGrid, snapshotCount: number): BakeData {
  const half = grid.size / 2
  const inside = (x: number, z: number, margin: number) =>
    Math.abs(x - grid.centerX) < half - margin && Math.abs(z - grid.centerZ) < half - margin
  const deposits: number[] = []
  for (const d of salt.small) if (inside(d.x, d.z, d.edge)) deposits.push(d.x, d.z, d.edge, d.time)
  salt.large.forEach(d => {
    if (inside(d.x, d.z, d.edge)) deposits.push(d.x, d.z, -d.edge, d.time)
  })
  const micro: number[] = []
  const parents: number[] = []
  for (const m of salt.micro) {
    if (m.parent >= MAX_LARGE_DROPS || !inside(m.x, m.z, m.radius * 3)) continue
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
 * salt deliquesces into drops that grow, pin and dry with the humidity; a GPU bake on two grids (a 640 µm core at
 * 1.25 µm, a 2.56 mm surround at 5 µm) runs the thin-film electrochemistry ahead of the playhead (see `RustBake`),
 * writing snapshots of the rust and nucleation events. `fieldView` shows the steel, the live fields (the bake then
 * follows the playhead) or the rust from the snapshots on a flat-shaded height field; `Section` is a debug cut
 * through the core to compare with reference cross-sections.
 */
@Register
export class Rust extends Document {

  @Property({type: String, value: 'Overview'})
  declare stageMode: RustStageMode

  @Property({type: String, value: 'Surface'})
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

  /** Bake steps per grid per frame. */
  @Property({type: Number, value: 1})
  declare bakeSpeed: number

  /** How far the bake has come (0–1 of the exposure). */
  @Property({type: Number, value: 0})
  declare bakeProgress: number

  private readonly camera: PerspectiveCamera
  private clock: RustClock
  private salt: SaltField | null = null
  private drops: DropModel | null = null
  private core: RustBake | null = null
  private surround: RustBake | null = null
  private coreSurface: RustSurface | null = null
  private surroundSurface: RustSurface | null = null
  private coreEvents: RustEvents | null = null
  private surroundEvents: RustEvents | null = null
  private section: RustSection | null = null
  private readonly coreUniforms: SurfaceUniforms = createSurfaceUniforms()
  private readonly surroundUniforms: SurfaceUniforms = createSurfaceUniforms()
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
    this.coreUniforms.relief.value = this.relief
    this.surroundUniforms.relief.value = this.relief
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
    let width = 760
    let tilt = 35
    let azimuth = 20
    if (mode === 'Surface') { width = 2700; tilt = 30 }
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
    for (const u of [this.coreUniforms, this.surroundUniforms]) {
      u.view.value = Math.max(view, 0)
      u.relief.value = this.relief
    }
    const nucleation = this.fieldView === 'Nucleation'
    if (this.coreEvents) this.coreEvents.visible = nucleation
    if (this.surroundEvents) this.surroundEvents.visible = nucleation
    if (this.section) this.section.visible = this.fieldView === 'Section'
    this.notify({kind: 'material'})
  }

  /** Whether the view shows the bake's live state (which then follows the playhead). */
  private get liveView() {
    return LIVE_FIELD_VIEWS.includes(this.fieldView)
  }

  /** The new salt, drops and bake grids of the current settings, and their meshes, cleared on the GPU. */
  private rebuild(renderer: WebGPURenderer) {
    this.disposeBake()
    const salt = generateSalt({
      seed: this.seed, heroEdge: this.heroCrystal, saltLoad: this.saltLoad, chlorideDeposition: this.chlorideDeposition,
      exposureDays: this.exposureDays,
    })
    this.salt = salt
    this.drops = new DropModel(this.clock, salt)
    const count = this.clock.snapshotTimes.length
    this.core = new RustBake(CORE_GRID, bakeData(salt, CORE_GRID, count))
    this.surround = new RustBake(SURROUND_GRID, bakeData(salt, SURROUND_GRID, count))
    const pearlite = pearliteShare(this.carbon)
    this.steelUniforms.seed.value = this.seed
    this.steelUniforms.pearlite.value = pearlite
    this.steelUniforms.inclusions.value = this.inclusions
    for (const bake of [this.core, this.surround]) bake.reset(renderer, this.seed, pearlite, this.inclusions)

    this.coreSurface = new RustSurface(this.core, this.coreUniforms, this.steelUniforms)
    this.surroundSurface = new RustSurface(this.surround, this.surroundUniforms, this.steelUniforms)
    this.surroundSurface.clipHalf.value = CORE_SIZE / 2
    this.coreEvents = new RustEvents(this.core, this.coreUniforms)
    this.surroundEvents = new RustEvents(this.surround, this.surroundUniforms)
    this.section = new RustSection(this.core, this.coreUniforms, 0)
    this.scene.add(this.surroundSurface, this.coreSurface, this.coreEvents, this.surroundEvents, this.section)
    this.syncView()
    this.bakeDirty = false
    this.notify({kind: 'structure'})
  }

  private disposeBake() {
    for (const mesh of [this.coreSurface, this.surroundSurface, this.coreEvents, this.surroundEvents, this.section]) {
      if (!mesh) continue
      mesh.removeFromParent()
      mesh.dispose()
    }
    this.core?.dispose()
    this.surround?.dispose()
    this.coreSurface = this.surroundSurface = this.coreEvents = this.surroundEvents = this.section = null
    this.core = this.surround = null
  }

  /** Steps one grid by the clock's next step, with the drops of the moment it reaches. */
  private stepGrid(renderer: WebGPURenderer, bake: RustBake) {
    const clock = this.clock
    const dt = clock.stepSize(bake.time, bake.grid.stepScale)
    if (dt <= 0 || !this.drops) return false
    const time = bake.time + dt
    const drops = this.drops.stateAt(time)
    const layer = clock.snapshotTimes.findIndex(t => Math.abs(t - time) < 1e-6)
    bake.step(renderer, {
      time, dt, rh: clock.humidityAt(time), liquid: drops.liquid, lastDeliquescence: drops.lastDeliquescence,
      smallRadius: drops.smallRadius, smallHeight: drops.smallHeight, microScale: drops.microScale,
      large: packLarge(drops), snapshotLayer: layer,
    })
    return true
  }

  /** Bakes up to `target` (exposure s), at most `steps` steps per grid, stepping whichever grid is behind. */
  private advance(renderer: WebGPURenderer, target: number, steps: number) {
    const core = this.core
    const surround = this.surround
    if (!core || !surround) return
    let budget = steps * 2
    while (budget-- > 0) {
      const bake = core.time <= surround.time ? core : surround
      if (bake.time >= target) break
      if (!this.stepGrid(renderer, bake)) break
    }
  }

  /** Exposure time (s) both grids have reached. */
  get bakedExposure() {
    return Math.min(this.core?.time ?? 0, this.surround?.time ?? 0)
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
    const core = this.core
    const surround = this.surround
    if (!core || !surround) return
    const playhead = Math.min(this.clock.exposureAt(this.timeline.currentTime), this.clock.totalExposure)
    if (this.liveView && this.bakedExposure > playhead + 1) {
      this.rebuild(renderer)
      return
    }
    this.advance(renderer, this.liveView ? playhead : this.clock.totalExposure, Math.max(1, Math.round(this.bakeSpeed)))
    this.updateDisplay(playhead)
  }

  /** The snapshots (and their blend) that show `playhead`, as far as the bake has come. */
  private updateDisplay(playhead: number) {
    const shown = Math.min(playhead, this.bakedExposure)
    const blend = this.clock.snapshotBlend(shown)
    const grids: [RustBake | null, SurfaceUniforms][] = [[this.core, this.coreUniforms], [this.surround, this.surroundUniforms]]
    for (const [bake, u] of grids) {
      if (!bake) continue
      let {a, b, weight} = blend
      if (b >= bake.snapshotsWritten) {
        a = b = Math.max(Math.min(a, bake.snapshotsWritten - 1), 0)
        weight = 0
      }
      u.layerA.value = a
      u.layerB.value = b
      u.weight.value = weight
      u.time.value = shown
    }
    if (this.section && this.core) this.section.written.value = Math.min(blend.b + 1, this.core.snapshotsWritten)
    const progress = this.bakedExposure / this.clock.totalExposure
    if (Math.abs(progress - this.bakeProgress) > 0.002 || (progress === 1 && this.bakeProgress !== 1)) this.bakeProgress = progress
  }

  /** Bakes (synchronously, for headless checks) until both grids reach `days` days, and waits for the GPU. */
  async bakeUntil(days: number) {
    const renderer = this.renderer
    if (!renderer) throw new Error('Rust: no renderer yet')
    if (this.bakeDirty) this.rebuild(renderer)
    const target = Math.min(days * SECONDS_PER_DAY, this.clock.totalExposure)
    while (this.bakedExposure < target - 1e-6) this.advance(renderer, target, 64)
    if (this.core) await renderer.getArrayBufferAsync(this.core.eventCount)
    return this.bakedExposure / SECONDS_PER_DAY
  }

  /** Restarts the bake from bare steel (headless checks: determinism). */
  restartBake() {
    this.bakeDirty = true
  }

  /** The fields of a grid, read back (headless checks). */
  async readBake(grid: 'core' | 'surround') {
    const bake = grid === 'core' ? this.core : this.surround
    if (!bake || !this.renderer) throw new Error('Rust: no bake yet')
    return {grid: bake.grid, time: bake.time, steps: bake.steps, ...await bake.read(this.renderer)}
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
      'camera', 'clock', 'salt', 'drops', 'core', 'surround', 'coreSurface', 'surroundSurface', 'coreEvents',
      'surroundEvents', 'section', 'coreUniforms', 'surroundUniforms', 'steelUniforms', 'bakeDirty', 'renderer',
    ],
  },
})
