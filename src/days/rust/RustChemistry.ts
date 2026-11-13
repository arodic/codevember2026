import { ComputeNode, StorageBufferAttribute, WebGPURenderer } from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import {
  Fn, If, Loop, abs, atomicAdd, atomicLoad, atomicMax, atomicStore, clamp, exp, float, floatBitsToUint, floor, hash,
  instanceIndex, int, localId, log, max, min, packHalf2x16, select, smoothstep, sqrt, storage, uint,
  uintBitsToFloat, uniform, uvec2, vec2, vec4, workgroupArray, workgroupBarrier, workgroupId,
} from 'three/tsl'
import { Diffusivity, Multigrid } from './RustMultigrid.js'
import {
  ALKALINITY_PER_CATHODIC, FARADAY, FERROUS_HYDROLYSIS, FERROUS_PER_ANODIC, IRON_LOSS_RATE,
  IRON_UM_PER_MOLAR_UM, NACL_DENSITY, NACL_MOLAR_MASS, OXYGEN_DIFFUSIVITY, OXYGEN_SALTING, OXYGEN_SOLUBILITY,
  RUST_PHASES, RUST_REDUCTION_RATE, SECONDS_PER_DAY, STUMM_LEE_K, brineMolarity, layerPerIron, naclMolality,
  DELIQUESCENCE_RH,
} from './RustScience.js'
import { steelCell } from './RustSteel.js'
import { MAX_LARGE_DROPS, MICRO_ANGLE } from './RustSalt.js'

/** Largest number of crystal nucleation events a grid records. */
export const EVENT_CAPACITY = 1 << 17
/** Film (µm) below which a cell is dry: an adsorbed layer of a few water molecules, no chemistry. */
export const WET_FILM = 0.02
/** Thickness (µm) of the secondary-spreading film between a drop and its microdroplets. */
export const SPREAD_FILM = 0.15
/** Phase codes of the nucleation events (`events.w` = code + 1 + size; 0 is empty). */
export const EVENT_PHASES = ['greenRust', 'lepidocrocite', 'goethite', 'akaganeite', 'magnetite'] as const

/** Fixed-point scale of the salt-deposit accumulator (per M·µm). */
const SALT_FIXED = 1000
/** Anodic and cathodic kinetics: currents (A/m²) at the reference potential and natural-log Tafel slopes (V). */
const ANODIC_EXCHANGE = 1.0
const ANODIC_TAFEL = 0.026
const CATHODIC_EXCHANGE = 1.5
const CATHODIC_TAFEL = 0.052
/** Electrolyte potential (V, metal at 0) at which the electrode sits at the reference potential, its start. */
const REFERENCE_POTENTIAL = 0.45
/** The potential's window (V about the reference): iron neither below its active range nor above oxygen's. */
const POTENTIAL_LOW = REFERENCE_POTENTIAL - 0.6
const POTENTIAL_HIGH = REFERENCE_POTENTIAL + 0.45
/** Dissolution current (A/m²) of passive iron, and where active dissolution saturates (a salt film, as in pits). */
const PASSIVE_CURRENT = 1e-3
const ANODIC_LIMIT = 20
/** Fe²⁺ (M) past which a film precipitates ferrous salts (FeCl₂ is soluble to ~4–5 M). */
const MAX_FERROUS = 4
/** Alkalinity (M) atmospheric CO₂ buffers a film back to (pH ~10.5), and how fast (s). */
const CARBONATED_ALKALINITY = 3e-4
const CARBONATION_TIME = 3600
/** Lepidocrocite reduction current (A/m², Stratmann) with plenty of it to reduce. */
const RUST_REDUCTION = 0.5
/** Share of the ionic current Cl⁻ carries in NaCl brine. */
const CHLORIDE_TRANSFERENCE = 0.6
/** Concentration (M) a drop's NaCl can reach supersaturated, while the climate keeps it liquid. */
const MAX_LIQUID = 10
/** A/m² of O₂-limited current per (mol/m³ of O₂ / µm of film): 4FD/1e-6. */
const OXYGEN_LIMIT = 4 * FARADAY * OXYGEN_DIFFUSIVITY * 1e6
/**
 * Diffusivities (µm²/s) of Fe²⁺, Cl⁻ and the alkalinity. Fe²⁺ and the alkalinity diffuse alike (OH⁻ is slowed by the
 * brine's electroneutrality), so `Fe²⁺ − alkalinity/2`, which neither precipitation nor oxygenation changes, is
 * transported exactly: the fast-reaction limit that puts the precipitate on the front where they meet.
 */
const SPECIES_DIFFUSIVITY: Diffusivity = [1500, 2030, 1500, 0]
const POTENTIAL_DIFFUSIVITY: Diffusivity = [1, 1, 1, 1]
/** Clusters nucleated per µm² per µm of iron precipitated, by `EVENT_PHASES`. */
const NUCLEATION = [0.03, 0.008, 0.004, 0.02, 0.05]
/**
 * Patch labels: `k + 1` (1–8) is large drop `k`'s own brine (the drop and the brine-wet rust around it), `k + 9`
 * (9–16) its secondary-spreading film and microdroplets, 0 neither. A drop and its film are one electrical patch (the
 * potential and the species couple them, `(label − 1) mod 8`), but the film is a passive cathode: condensed water made
 * alkaline by the drop's cathodic current, not the drop's corroding brine (Frontiers in Chemistry 2021).
 */
const TILE = 256
const DROPS = MAX_LARGE_DROPS
const LABELS = MAX_LARGE_DROPS * 2

const LN10 = Math.log(10)
const LP = {
  greenRust: layerPerIron(RUST_PHASES.greenRust), ferrihydrite: layerPerIron(RUST_PHASES.ferrihydrite),
  lepidocrocite: layerPerIron(RUST_PHASES.lepidocrocite), goethite: layerPerIron(RUST_PHASES.goethite),
  akaganeite: layerPerIron(RUST_PHASES.akaganeite), magnetite: layerPerIron(RUST_PHASES.magnetite),
}

/** A grid the bake runs on. */
export interface BakeGrid {
  name: string
  /** Side (µm). */
  size: number
  /** Cells per side (a power of two). */
  resolution: number
  centerX: number
  centerZ: number
  /** Snapshot texels per side = resolution / this. */
  snapshotDownsample: number
  /** Multiplies the clock's step: a coarser grid steps longer. */
  stepScale: number
}

/** What a grid is given once per bake: its salt, microdroplets and how many snapshots it keeps. */
export interface BakeData {
  /** vec4 per deposit: (x, z, edge (negative = a large deposit: salt only, its drop is in `largeDrops`), time). */
  deposits: Float32Array
  /** vec4 per microdroplet: (x, z, radius at 90% RH, distance past its parent's edge). */
  micro: Float32Array
  /** Parent slot of each microdroplet. */
  microParent: Uint32Array
  snapshotCount: number
}

/** The state of one step, from the clock and the drop model. */
export interface StepInput {
  time: number
  dt: number
  rh: number
  liquid: boolean
  lastDeliquescence: number
  smallRadius: number
  smallHeight: number
  microScale: number
  /** vec4 × 2 per slot: (x, z, radius, height), (spread, wet, patch half-width, ·). */
  large: Float32Array
  snapshotLayer: number
}

type AtomicBuffer = StorageBufferNode<'uint'>

/** Integer and unsigned max/min (TSL's `max`/`min` are typed for floats). */
function maxInt(a: Node<'int'>, b: Node<'int'> | number) {
  const other = typeof b === 'number' ? int(b) : b
  return select(a.greaterThan(other), a, other)
}

function minInt(a: Node<'int'>, b: Node<'int'> | number) {
  const other = typeof b === 'number' ? int(b) : b
  return select(a.lessThan(other), a, other)
}

function maxUint(a: Node<'uint'>, b: Node<'uint'>) {
  return select(a.greaterThan(b), a, b)
}

/** The electrical patch (1–8, 0 = none) of a label: a drop and its film are one. */
function patchOf(label: Node<'float'>) {
  const l = int(label)
  return select(l.greaterThan(0), l.sub(1).mod(MAX_LARGE_DROPS).add(1), int(0))
}

/** A workgroup array whose elements take TSL index nodes. */
function sharedArray<T extends string>(type: T, count: number) {
  return workgroupArray(type, count) as unknown as {element(index: Node<'int'>): Node<T>}
}

function log10(x: Node<'float'>) {
  return log(x).div(LN10)
}

function harmonic(a: Node<'float'>, b: Node<'float'>) {
  return a.mul(b).mul(2).div(a.add(b).add(1e-30))
}

/** pH from the alkalinity (M of OH⁻ less H⁺) and Fe²⁺ (M; its hydrolysis adds acid), in float32 without cancellation. */
function filmPH(alkalinity: Node<'float'>, ferrous: Node<'float'>) {
  const effective = alkalinity.sub(sqrt(max(ferrous, 0).mul(FERROUS_HYDROLYSIS)))
  const root = sqrt(effective.mul(effective).add(4e-14))
  const hydroxide = select(effective.greaterThanEqual(0), effective.add(root).mul(0.5), float(2e-14).div(root.sub(effective)))
  return log10(max(hydroxide, 1e-14)).add(14)
}

/** Height (µm) of a spherical cap of base `radius` and height `height` at `r` from its axis. */
function capProfile(radius: Node<'float'>, height: Node<'float'>, r: Node<'float'>) {
  const sphere = radius.mul(radius).add(height.mul(height)).div(height.mul(2).max(1e-6))
  return max(sqrt(max(sphere.mul(sphere).sub(r.mul(r)), 0)).sub(sphere.sub(height)), 0)
}

/**
 * The corrosion bake on one grid: a reduced thin-film electrochemistry, stepped on the GPU in exposure time.
 *
 * Per cell: the electrolyte film `h` (drops as spherical caps, the secondary-spreading film, adsorbed water, brine
 * held in rust), its potential `φ` (metal at 0) and the currents; Fe²⁺, Cl⁻ and alkalinity per area, solid salt; the
 * rust by phase (as the µm of iron it holds) and the iron lost. A step:
 *
 * 1. Salt lands; drops, microdroplets and films are drawn into the film by atomic max; cells covered by a large drop,
 *    its film or its microdroplets get its label, which spreads through brine-wet rust next to them.
 * 2. Kinetics (Tafel): anodic dissolution scaled by chloride, pH (passive above ~9.3, more so with less chloride,
 *    faster in acid), MnS trenches, the steel and cover by dense rust; O₂ reduction limited by diffusion through the
 *    film and rust (`4FDC/h`); lepidocrocite reduced on wetting (Stratmann).
 * 3. The potential: `−∇·(κh∇φ) = i_a − i_c` within each labelled patch (Newton, two iterations), unlabelled wet cells
 *    balancing on their own. Multigrid, then each patch's mean set exactly (its charge balance).
 * 4. Transport: backward-Euler diffusion of the species within patches with the electrode sources and Cl⁻ migrating
 *    toward the anodes with its share of the current; multigrid, each patch's amounts conserved exactly.
 * 5. Reactions: Fe(OH)₂/green rust past Ksp, Stumm–Lee oxygenation, the phase by local conditions, green rust and
 *    lepidocrocite turning to magnetite without O₂, aging, rust's Fe(II) re-oxidizing, Faraday's iron loss;
 *    nucleation events for the crystals.
 *
 * Snapshots (iron lost, crust, phase mix) are written at the clock's snapshot times. Deterministic: hashes, fixed
 * steps, order-free atomics (max of positive floats, integer sums).
 */
export class RustBake {

  readonly grid: BakeGrid
  readonly cell: number
  readonly cells: number
  readonly originX: number
  readonly originZ: number
  readonly snapshotSize: number
  readonly snapshotCount: number
  readonly depositCount: number
  readonly microCount: number

  /** (h µm, φ V, i_a A/m², i_c A/m²) */
  readonly electro: StorageBufferAttribute
  /** (Fe²⁺, Cl⁻, alkalinity, solid NaCl) in M·µm */
  readonly species: StorageBufferAttribute
  /** (green rust, ferrihydrite, lepidocrocite, goethite) in µm of iron */
  readonly solidA: StorageBufferAttribute
  /** (akaganeite, magnetite, Fe(II) in rust (µm of iron), iron lost (µm)) */
  readonly solidB: StorageBufferAttribute
  /** (κh S/m·µm, crust µm, cover, patch label) */
  readonly aux: StorageBufferAttribute
  /** (pH, O₂ left, rust-reduction current, unreduced lepidocrocite) */
  readonly chem: StorageBufferAttribute
  /** (anodic multiplier, MnS, trench, cementite) */
  readonly steel: StorageBufferAttribute
  /** Per cell: film height bits, label, salt landed (fixed point), spare. */
  readonly accum: StorageBufferAttribute
  readonly labelNext: StorageBufferAttribute
  /** (x, z, time, phase + size) per nucleation event. */
  readonly events: StorageBufferAttribute
  readonly eventCount: StorageBufferAttribute
  /** Per snapshot texel: (iron lost, crust) as halves, phase mix (LP, GT, AK, MG) as bytes. */
  readonly snapshots: StorageBufferAttribute
  readonly deposits: StorageBufferAttribute
  readonly micro: StorageBufferAttribute
  readonly microParent: StorageBufferAttribute
  readonly largeDrops: StorageBufferAttribute
  readonly partials: StorageBufferAttribute
  readonly patches: StorageBufferAttribute
  /** Per patch label: (Σ net current i_a − i_c, wet cells, ·, ·), for chloride migration that conserves it. */
  readonly patchCurrents: StorageBufferAttribute
  readonly multigrid: Multigrid

  readonly uniforms = {
    time: uniform(0),
    from: uniform(-1e30),
    dt: uniform(0),
    rh: uniform(0.4),
    liquid: uniform(0),
    lastDeliquescence: uniform(-1e30),
    smallRadius: uniform(0),
    smallHeight: uniform(0),
    microScale: uniform(0),
    step: uniform(0, 'uint'),
    snapshotLayer: uniform(-1, 'int'),
    soluteMolarity: uniform(4),
    seed: uniform(0),
    pearlite: uniform(0.107),
    inclusions: uniform(1),
  }

  /** Exposure time (s) the bake has reached, and steps taken. */
  time = 0
  steps = 0
  /** Snapshot layers written (0 = the start). */
  snapshotsWritten = 0

  private readonly resetNodes: ComputeNode[]
  private readonly stepNodes: ComputeNode[]
  private readonly snapshotNode: ComputeNode

  constructor(grid: BakeGrid, data: BakeData) {
    this.grid = grid
    const n = grid.resolution
    this.cell = grid.size / n
    this.cells = n * n
    this.originX = grid.centerX - grid.size / 2
    this.originZ = grid.centerZ - grid.size / 2
    this.snapshotSize = n / grid.snapshotDownsample
    this.snapshotCount = data.snapshotCount
    this.depositCount = Math.max(data.deposits.length / 4, 1)
    this.microCount = Math.max(data.micro.length / 4, 1)

    const vec4Buffer = (count: number) => new StorageBufferAttribute(new Float32Array(count * 4), 4)
    this.electro = vec4Buffer(this.cells)
    this.species = vec4Buffer(this.cells)
    this.solidA = vec4Buffer(this.cells)
    this.solidB = vec4Buffer(this.cells)
    this.aux = vec4Buffer(this.cells)
    this.chem = vec4Buffer(this.cells)
    this.steel = vec4Buffer(this.cells)
    this.accum = new StorageBufferAttribute(new Uint32Array(this.cells * 4), 1)
    this.labelNext = new StorageBufferAttribute(new Uint32Array(this.cells), 1)
    this.events = vec4Buffer(EVENT_CAPACITY)
    this.eventCount = new StorageBufferAttribute(new Uint32Array(4), 1)
    const snapshotTexels = this.snapshotCount * this.snapshotSize * this.snapshotSize
    this.snapshots = new StorageBufferAttribute(new Uint32Array(snapshotTexels * 2), 2)
    const padded = (array: Float32Array, count: number) => {
      const out = new Float32Array(count * 4)
      out.set(array.subarray(0, Math.min(array.length, out.length)))
      return out
    }
    this.deposits = new StorageBufferAttribute(padded(data.deposits, this.depositCount), 4)
    this.micro = new StorageBufferAttribute(padded(data.micro, this.microCount), 4)
    const parents = new Uint32Array(this.microCount)
    parents.set(data.microParent.subarray(0, parents.length))
    this.microParent = new StorageBufferAttribute(parents, 1)
    this.largeDrops = vec4Buffer(MAX_LARGE_DROPS * 2)
    const tiles = this.cells / TILE
    this.partials = vec4Buffer(tiles * LABELS * 2)
    this.patches = vec4Buffer(LABELS * 2)
    this.patchCurrents = vec4Buffer(LABELS * 2)
    this.multigrid = new Multigrid(n)

    this.resetNodes = this.buildReset()
    this.snapshotNode = this.buildSnapshot()
    this.stepNodes = this.buildStep()
  }

  /** Clears the grid back to bare, dry steel at exposure 0 (steel computed for the seed) and writes snapshot 0. */
  reset(renderer: WebGPURenderer, seed: number, pearlite: number, inclusions: number) {
    this.uniforms.seed.value = seed
    this.uniforms.pearlite.value = pearlite
    this.uniforms.inclusions.value = inclusions
    this.uniforms.snapshotLayer.value = 0
    this.time = 0
    this.steps = 0
    void renderer.compute([...this.resetNodes, this.snapshotNode])
    this.snapshotsWritten = 1
  }

  /** Steps the grid by `input.dt` to `input.time`. */
  step(renderer: WebGPURenderer, input: StepInput) {
    const u = this.uniforms
    u.from.value = this.steps === 0 ? -1e30 : this.time
    u.time.value = input.time
    u.dt.value = input.dt
    u.rh.value = input.rh
    u.liquid.value = input.liquid ? 1 : 0
    u.lastDeliquescence.value = Number.isFinite(input.lastDeliquescence) ? input.lastDeliquescence : -1e30
    u.smallRadius.value = input.smallRadius
    u.smallHeight.value = input.smallHeight
    u.microScale.value = input.microScale
    u.soluteMolarity.value = brineMolarity(naclMolality(input.rh))
    u.step.value = this.steps
    u.snapshotLayer.value = input.snapshotLayer
    ;(this.largeDrops.array as Float32Array).set(input.large)
    this.largeDrops.needsUpdate = true
    void renderer.compute([...this.stepNodes, this.snapshotNode])
    this.time = input.time
    this.steps++
    if (input.snapshotLayer >= 0) this.snapshotsWritten = input.snapshotLayer + 1
  }

  /** Reads the fields back (for tests and the headless checks). */
  async read(renderer: WebGPURenderer) {
    const get = async (attribute: StorageBufferAttribute) => new Float32Array(await renderer.getArrayBufferAsync(attribute))
    return {
      electro: await get(this.electro), species: await get(this.species), solidA: await get(this.solidA),
      solidB: await get(this.solidB), aux: await get(this.aux), chem: await get(this.chem), steel: await get(this.steel),
      events: await get(this.events),
      eventCount: new Uint32Array(await renderer.getArrayBufferAsync(this.eventCount))[0],
      snapshots: new Uint32Array(await renderer.getArrayBufferAsync(this.snapshots)),
    }
  }

  dispose() {
    for (const node of [...this.resetNodes, ...this.stepNodes, this.snapshotNode]) node.dispose()
  }

  /** Cell `(x, y)` and its centre `(X, Z)` (µm) for a thread index. */
  private cellOf(index: Node<'int'>) {
    const n = this.grid.resolution
    const x = index.mod(n)
    const y = index.div(n)
    const world = vec2(float(x).add(0.5).mul(this.cell).add(this.originX), float(y).add(0.5).mul(this.cell).add(this.originZ))
    return {x, y, world}
  }

  /** Cell index range `[lo, hi]` along one axis covering world `[a, b]`, clamped to the grid. */
  private span(a: Node<'float'>, b: Node<'float'>, origin: number) {
    const n = this.grid.resolution
    const lo = maxInt(int(floor(a.sub(origin).div(this.cell))), 0)
    const hi = minInt(int(floor(b.sub(origin).div(this.cell))), n - 1)
    return {lo, hi}
  }

  private buildReset(): ComputeNode[] {
    const {electro, species, solidA, solidB, aux, chem} = this.nodes()
    const steel = storage(this.steel, 'vec4', this.cells)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const eventCount = storage(this.eventCount, 'uint', 4).toAtomic()
    const u = this.uniforms
    const fields = Fn(() => {
      const i = int(instanceIndex)
      electro.element(i).assign(vec4(0, REFERENCE_POTENTIAL, 0, 0))
      species.element(i).assign(vec4(0))
      solidA.element(i).assign(vec4(0))
      solidB.element(i).assign(vec4(0))
      aux.element(i).assign(vec4(0, 0, 1, 0))
      chem.element(i).assign(vec4(7, 1, 0, 0))
    })().compute(this.cells) as ComputeNode
    const rest = Fn(() => {
      const i = int(instanceIndex)
      const {world} = this.cellOf(i)
      steel.element(i).assign(steelCell(world, this.cell, u.seed, u.pearlite, u.inclusions))
      for (let k = 0; k < 4; k++) atomicStore(accum.element(i.mul(4).add(k)), uint(0))
      If(i.lessThan(4), () => {
        atomicStore(eventCount.element(i), uint(0))
      })
    })().compute(this.cells) as ComputeNode
    return [fields, rest]
  }

  private nodes() {
    return {
      electro: storage(this.electro, 'vec4', this.cells),
      species: storage(this.species, 'vec4', this.cells),
      solidA: storage(this.solidA, 'vec4', this.cells),
      solidB: storage(this.solidB, 'vec4', this.cells),
      aux: storage(this.aux, 'vec4', this.cells),
      chem: storage(this.chem, 'vec4', this.cells),
    }
  }

  private buildStep(): ComputeNode[] {
    const mg = this.multigrid
    const list: ComputeNode[] = [this.buildDeposit(), this.buildSmallCaps(), this.buildLargeCaps(), this.buildMicroCaps()]
    list.push(this.buildFilm(), this.buildLabelCopy())
    const kinetics = this.buildKinetics()
    const potentialOut = this.buildPotentialOut()
    const [patchTiles, patchTotals] = this.buildPatchSums(POTENTIAL_DIFFUSIVITY, true)
    const potentialShift = this.buildPatchShift(true)
    for (let newton = 0; newton < 2; newton++) {
      list.push(kinetics, ...mg.coefficientNodes, ...mg.vCycle(POTENTIAL_DIFFUSIVITY))
      list.push(patchTiles, patchTotals, potentialShift, potentialOut)
    }
    const [speciesTiles, speciesTotals] = this.buildPatchSums(SPECIES_DIFFUSIVITY, true)
    const speciesShift = this.buildPatchShift(true)
    list.push(this.buildCurrents(), ...this.buildCurrentSums())
    list.push(this.buildTransportSetup(), ...mg.coefficientNodes)
    for (let cycle = 0; cycle < 3; cycle++) list.push(...mg.vCycle(SPECIES_DIFFUSIVITY))
    list.push(speciesTiles, speciesTotals, speciesShift, this.buildSpeciesOut(), this.buildPrecipitate())
    list.push(...this.buildPrecipitateSums(), this.buildPrecipitateScale(), this.buildReact(), this.buildEvents())
    return list
  }

  /** Salt landing this step, spread over each crystal's footprint (fixed point, summed). */
  private buildDeposit() {
    const deposits = storage(this.deposits, 'vec4', this.depositCount)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const u = this.uniforms
    const n = this.grid.resolution
    return Fn(() => {
      const d = deposits.element(instanceIndex)
      If(d.w.greaterThan(u.from).and(d.w.lessThanEqual(u.time)).and(abs(d.z).greaterThan(0)), () => {
        const edge = abs(d.z)
        const xs = this.span(d.x.sub(edge.mul(0.5)), d.x.add(edge.mul(0.5)), this.originX)
        const zs = this.span(d.y.sub(edge.mul(0.5)), d.y.add(edge.mul(0.5)), this.originZ)
        const count = float(xs.hi.sub(xs.lo).add(1).mul(zs.hi.sub(zs.lo).add(1))).max(1)
        const moles = edge.mul(edge).mul(edge).mul(NACL_DENSITY * 1e-12 / NACL_MOLAR_MASS)
        const perCell = moles.mul(1e15).div(count.mul(this.cell * this.cell))
        const fixed = uint(perCell.mul(SALT_FIXED).add(0.5))
        Loop({start: zs.lo, end: zs.hi, type: 'int', condition: '<='}, {start: xs.lo, end: xs.hi, type: 'int', condition: '<='}, ({i, j}) => {
          atomicAdd(accum.element(i.mul(n).add(j).mul(4).add(2)), fixed)
        })
      })
    })().compute(this.depositCount) as ComputeNode
  }

  /** Writes a cap (`radius`, `height` at `(cx, cz)`) into the film by atomic max, with `label` (0 = none). */
  private capLoop(accum: AtomicBuffer, cx: Node<'float'>, cz: Node<'float'>, radius: Node<'float'>, height: Node<'float'>, label: Node<'uint'> | null) {
    const n = this.grid.resolution
    const reach = max(radius, this.cell * 0.5)
    const xs = this.span(cx.sub(reach), cx.add(reach), this.originX)
    const zs = this.span(cz.sub(reach), cz.add(reach), this.originZ)
    const small = radius.lessThan(this.cell * 0.75)
    const average = height.mul(0.5).mul(radius.mul(radius).mul(Math.PI)).div(this.cell * this.cell)
    Loop({start: zs.lo, end: zs.hi, type: 'int', condition: '<='}, {start: xs.lo, end: xs.hi, type: 'int', condition: '<='}, ({i, j}) => {
      const X = float(j).add(0.5).mul(this.cell).add(this.originX)
      const Z = float(i).add(0.5).mul(this.cell).add(this.originZ)
      const r = vec2(X.sub(cx), Z.sub(cz)).length()
      const h = select(small, select(r.lessThan(this.cell * 0.71), min(average, height), float(0)), capProfile(radius, height, r))
      If(h.greaterThan(0), () => {
        const cell = i.mul(n).add(j).mul(4)
        atomicMax(accum.element(cell), floatBitsToUint(h))
        if (label) atomicMax(accum.element(cell.add(1)), label)
      })
    })
  }

  /** Small drops (sub-critical), all scaled from the unit drop by their crystal's edge. */
  private buildSmallCaps() {
    const deposits = storage(this.deposits, 'vec4', this.depositCount)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const u = this.uniforms
    return Fn(() => {
      const d = deposits.element(instanceIndex)
      const drop = u.liquid.greaterThan(0.5).and(d.z.greaterThan(0)).and(d.w.lessThanEqual(u.lastDeliquescence))
      If(drop, () => {
        this.capLoop(accum, d.x, d.y, d.z.mul(u.smallRadius), d.z.mul(u.smallHeight), null)
      })
    })().compute(this.depositCount) as ComputeNode
  }

  /** The large drops, a workgroup each, its lanes striding over the drop's footprint. */
  private buildLargeCaps() {
    const large = storage(this.largeDrops, 'vec4', MAX_LARGE_DROPS * 2)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const n = this.grid.resolution
    const node = Fn(() => {
      const k = int(workgroupId.x)
      const drop = large.element(k)
      const radius = drop.z
      If(radius.greaterThan(0), () => {
        const xs = this.span(drop.x.sub(radius), drop.x.add(radius), this.originX)
        const zs = this.span(drop.y.sub(radius), drop.y.add(radius), this.originZ)
        const width = maxInt(xs.hi.sub(xs.lo).add(1), 1)
        const total = width.mul(maxInt(zs.hi.sub(zs.lo).add(1), 0))
        Loop({start: int(localId.x), end: total, type: 'int', condition: '<', update: 64}, ({i}) => {
          const cx = xs.lo.add(i.mod(width))
          const cz = zs.lo.add(i.div(width))
          const X = float(cx).add(0.5).mul(this.cell).add(this.originX)
          const Z = float(cz).add(0.5).mul(this.cell).add(this.originZ)
          const h = capProfile(radius, drop.w, vec2(X.sub(drop.x), Z.sub(drop.y)).length())
          If(h.greaterThan(0), () => {
            const cell = cz.mul(n).add(cx).mul(4)
            atomicMax(accum.element(cell), floatBitsToUint(h))
            atomicMax(accum.element(cell.add(1)), uint(k.add(1)))
          })
        })
      })
    })().computeKernel([64]) as ComputeNode
    node.dispatchSize = [MAX_LARGE_DROPS, 1, 1]
    return node
  }

  /** Microdroplets, wet once their parent's spreading film has reached them. */
  private buildMicroCaps() {
    const micro = storage(this.micro, 'vec4', this.microCount)
    const parent = storage(this.microParent, 'uint', this.microCount)
    const large = storage(this.largeDrops, 'vec4', MAX_LARGE_DROPS * 2)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const u = this.uniforms
    const tan = Math.tan(MICRO_ANGLE / 2)
    return Fn(() => {
      const m = micro.element(instanceIndex)
      const p = int(parent.element(instanceIndex))
      const film = large.element(p.add(MAX_LARGE_DROPS))
      If(film.y.greaterThan(0.5).and(m.w.lessThan(film.x)).and(m.z.greaterThan(0)), () => {
        const radius = m.z.mul(u.microScale)
        this.capLoop(accum, m.x, m.y, radius, radius.mul(tan), uint(p.add(DROPS + 1)))
      })
    })().compute(this.microCount) as ComputeNode
  }

  /**
   * The electrolyte film of each cell: the largest of the caps drawn, the spreading film around wet large drops,
   * adsorbed water and the brine held in rust. Salt that landed is added; wet cells dissolve their solid salt (up to
   * a supersaturated drop's concentration), dry ones crystallize what they held. The conductance `κh` for the
   * potential, and the patch label: a large drop's, else a wet neighbour's (brine-wet rust carries it on), else none.
   */
  private buildFilm() {
    const {electro, species, aux} = this.nodes()
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const labelNext = storage(this.labelNext, 'uint', this.cells)
    const large = storage(this.largeDrops, 'vec4', MAX_LARGE_DROPS * 2)
    const u = this.uniforms
    const n = this.grid.resolution
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y, world} = this.cellOf(i)
      const caps = uintBitsToFloat(atomicLoad(accum.element(i.mul(4))))
      const capLabel = atomicLoad(accum.element(i.mul(4).add(1)))
      const landed = float(atomicLoad(accum.element(i.mul(4).add(2)))).div(SALT_FIXED)
      atomicStore(accum.element(i.mul(4)), uint(0))
      atomicStore(accum.element(i.mul(4).add(1)), uint(0))
      atomicStore(accum.element(i.mul(4).add(2)), uint(0))

      const sp = species.element(i).toVar()
      sp.assign(vec4(sp.x, sp.y, sp.z, sp.w.add(landed)))
      const a = aux.element(i).toVar()
      const spread = float(0).toVar()
      const spreadLabel = uint(0).toVar()
      for (let k = 0; k < MAX_LARGE_DROPS; k++) {
        const drop = large.element(k)
        const film = large.element(k + MAX_LARGE_DROPS)
        const r = world.sub(drop.xy).length()
        const inside = film.y.greaterThan(0.5).and(r.greaterThan(drop.z)).and(r.lessThan(drop.z.add(film.x)))
        If(inside, () => {
          spread.assign(max(spread, smoothstep(drop.z.add(film.x), drop.z.add(film.x.mul(0.85)), r).mul(SPREAD_FILM)))
          spreadLabel.assign(maxUint(spreadLabel, uint(k + DROPS + 1)))
        })
      }
      const adsorbed = smoothstep(0.6, 0.95, u.rh).mul(4).add(1).mul(0.003)
      const salty = smoothstep(0, 5, sp.y.add(sp.w))
      const rustWater = min(a.y.mul(0.25), 4).mul(smoothstep(0.55, 0.9, u.rh)).mul(salty.mul(0.65).add(0.35))
      // dissolved salt and alkali hold as much water as the humidity lets them (and salt crust re-deliquesces)
      const solute = sp.y.add(max(sp.z, 0)).add(select(u.rh.greaterThanEqual(DELIQUESCENCE_RH), sp.w, float(0)))
      const hygroscopic = min(solute.div(max(u.soluteMolarity, 0.5)), 20)
      const cap = caps as unknown as Node<'float'>
      // a drop's cap is its shape (its thin edge as thick as its solute keeps it); outside drops, films are as thick as
      // their solute keeps them
      const h = select(cap.greaterThan(WET_FILM), max(max(cap, adsorbed), hygroscopic),
        max(max(spread, adsorbed), max(rustWater, hygroscopic))).toVar()
      const wet = h.greaterThan(WET_FILM).toVar()

      If(wet, () => {
        const dissolve = min(sp.w, max(h.mul(MAX_LIQUID).sub(sp.y), 0)).toVar()
        sp.assign(vec4(sp.x, sp.y.add(dissolve), sp.z, sp.w.sub(dissolve)))
      }).Else(() => {
        sp.assign(vec4(sp.x, 0, 0, sp.w.add(sp.y)))
      })
      species.element(i).assign(sp)

      const ionic = sp.y.add(max(sp.z, 0)).add(sp.x.mul(2)).div(max(h, 1e-6)).toVar()
      const kappa = max(float(8.5).mul(ionic).div(ionic.mul(0.15).add(1)), select(spread.greaterThan(0), float(0.5), float(0)))
      const kappaH = select(wet, kappa.mul(h), float(0)).toVar()

      // a cap's label, else the spreading film's, else (brine-wet rust) a neighbour's drop patch, or its own
      const label = select(uint(capLabel).greaterThan(0), uint(capLabel), spreadLabel).toVar()
      If(label.equal(uint(0)).and(wet), () => {
        const own = (value: Node<'float'>) => {
          const l = uint(value)
          return select(l.greaterThan(0), l.sub(1).mod(DROPS).add(1), uint(0))
        }
        const neighbour = (di: Node<'int'>, ok: Node<'bool'>) => select(ok, own(aux.element(select(ok, di, i)).w), uint(0))
        label.assign(maxUint(maxUint(neighbour(i.add(1), x.lessThan(n - 1)), neighbour(i.sub(1), x.greaterThan(0))),
          maxUint(neighbour(i.add(n), y.lessThan(n - 1)), neighbour(i.sub(n), y.greaterThan(0)))))
        label.assign(maxUint(label, own(a.w)))
      })
      labelNext.element(i).assign(select(wet, label, uint(0)))
      const e = electro.element(i).toVar()
      electro.element(i).assign(vec4(h, e.y, e.z, e.w))
      aux.element(i).assign(vec4(kappaH, a.y, a.z, a.w))
    })().compute(this.cells) as ComputeNode
  }

  private buildLabelCopy() {
    const {aux} = this.nodes()
    const labelNext = storage(this.labelNext, 'uint', this.cells)
    return Fn(() => {
      const i = int(instanceIndex)
      const a = aux.element(i).toVar()
      aux.element(i).assign(vec4(a.x, a.y, a.z, float(labelNext.element(i))))
    })().compute(this.cells) as ComputeNode
  }

  /**
   * Local electrode kinetics of a cell at potential `phi`: the anodic and cathodic currents (A/m²), the sensitivity
   * `g = −∂(i_a − i_c)/∂φ` and what they depend on.
   */
  private kinetics(h: Node<'float'>, phi: Node<'float'>, sp: Node<'vec4'>, a: Node<'vec4'>, st: Node<'vec4'>, lpFree: Node<'float'>) {
    const label = a.w
    const wet = a.x.greaterThan(1e-9)
    const film = max(h, 1e-6)
    const ferrous = max(sp.x, 0).div(film)
    const chloride = max(sp.y, 0).div(film)
    const alkalinity = sp.z.div(film)
    const pH = filmPH(alkalinity, ferrous)
    const activity = smoothstep(0.005, 0.05, chloride.add(max(alkalinity, 0)).add(ferrous.mul(2)))
    const over = float(REFERENCE_POTENTIAL).sub(phi)
    // passive only where OH- outweighs Cl- (Hausmann: Cl-/OH- < ~0.6) and the film is alkaline; brine keeps iron active
    const hydroxide = min(exp(pH.sub(14).mul(LN10)), 1)
    const activeness = max(smoothstep(10.5, 9.5, pH), smoothstep(0.3, 1.2, chloride.div(max(hydroxide, 1e-12))))
    const pitting = smoothstep(0.02, 0.3, chloride).mul(st.y.add(st.z.mul(0.6)))
    // a drop's film is a passive cathode; a sub-critical drop stays passive but at MnS (Li & Hihara)
    const breakdown = clamp(pitting.mul(4), 0, 1)
    const active = select(label.greaterThan(DROPS + 0.5), float(0),
      select(label.lessThan(0.5), breakdown, max(activeness, breakdown))).toVar()
    // FeCl2 near saturation: a salt film, the dissolution limited by diffusion away from it
    const saltFilm = smoothstep(MAX_FERROUS, MAX_FERROUS * 0.7, ferrous).mul(0.95).add(0.05)
    const dissolving = st.x
      .mul(saltFilm)
      .mul(chloride.div(chloride.add(0.2)).mul(0.75).add(0.25))
      .mul(smoothstep(6.5, 4.0, pH).mul(4).add(1))
      .mul(a.z)
      .mul(pitting.mul(6).add(1))
    const tafel = dissolving.mul(ANODIC_EXCHANGE).mul(exp(clamp(over.div(ANODIC_TAFEL), -30, 30))).mul(active).toVar()
    const raw = tafel.add(float(1).sub(active).mul(PASSIVE_CURRENT)).toVar()
    const saturation = float(1).div(raw.div(ANODIC_LIMIT).add(1)).toVar()
    const anodic = raw.mul(saturation).mul(activity).toVar()
    const oxygen = exp(chloride.add(max(alkalinity, 0)).mul(-OXYGEN_SALTING * LN10)).mul(OXYGEN_SOLUBILITY)
    const limit = oxygen.mul(OXYGEN_LIMIT).div(h.add(a.y.mul(4)).max(1e-3))
    const kinetic = exp(clamp(over.negate().div(CATHODIC_TAFEL), -30, 30)).mul(CATHODIC_EXCHANGE)
    const share = limit.div(kinetic.add(limit))
    const reducing = lpFree.div(lpFree.add(0.3)).mul(RUST_REDUCTION).mul(exp(clamp(over.negate().div(CATHODIC_TAFEL), -30, 30)))
    const reductionSaturation = float(1).div(reducing.div(RUST_REDUCTION * 4).add(1))
    const reduction = reducing.mul(reductionSaturation).toVar()
    const cathodic = kinetic.mul(share).add(reduction).mul(activity)
    const g = tafel.mul(saturation).mul(saturation).mul(activity).div(ANODIC_TAFEL)
      .add(kinetic.mul(share).mul(share).add(reduction.mul(reductionSaturation)).mul(activity).div(CATHODIC_TAFEL)).add(1e-6)
    return {
      wet, pH, ferrous, chloride, alkalinity, limit, reduction: select(wet, reduction.mul(activity), float(0)),
      anodic: select(wet, anodic, float(0)), cathodic: select(wet, cathodic, float(0)), g,
    }
  }

  /**
   * Face coefficients `(east, north)` of cell `i` coupling it to neighbours of its patch: electrically (a drop with
   * its film) or chemically (the same label).
   */
  private couplings(aux: ReturnType<RustBake['nodes']>['aux'], i: Node<'int'>, x: Node<'int'>, y: Node<'int'>,
    value: (j: Node<'int'>) => Node<'float'>, electrical: boolean) {
    const n = this.grid.resolution
    const patch = (l: Node<'float'>) => electrical ? patchOf(l) : int(l)
    const label = patch(aux.element(i).w)
    const east = select(x.lessThan(n - 1), i.add(1), i)
    const north = select(y.lessThan(n - 1), i.add(n), i)
    const coupled = (j: Node<'int'>, ok: Node<'bool'>) => ok.and(label.greaterThan(0)).and(patch(aux.element(j).w).equal(label))
    const aE = select(coupled(east, x.lessThan(n - 1)), harmonic(value(i), value(east)), float(0))
    const aN = select(coupled(north, y.lessThan(n - 1)), harmonic(value(i), value(north)), float(0))
    return {aE, aN}
  }

  /** Linearizes the kinetics at the current potential into the multigrid problem for the next. */
  private buildKinetics() {
    const {electro, species, aux, chem} = this.nodes()
    const steel = storage(this.steel, 'vec4', this.cells)
    const {u, f, k} = this.multigrid.nodes
    const scale = this.cell * this.cell * 1e-6
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y} = this.cellOf(i)
      const e = electro.element(i).toVar()
      const a = aux.element(i).toVar()
      const kin = this.kinetics(e.x, e.y, species.element(i), a, steel.element(i), chem.element(i).w)
      const {aE, aN} = this.couplings(aux, i, x, y, j => aux.element(j).x, true)
      const B = select(kin.wet, kin.g.mul(scale), float(1e-12))
      const F = select(kin.wet, kin.anodic.sub(kin.cathodic).add(kin.g.mul(e.y)).mul(scale), e.y.mul(1e-12))
      k.element(i).assign(vec4(aE, aN, B, 0))
      f.element(i).assign(vec4(F, 0, 0, 0))
      u.element(i).assign(vec4(e.y, 0, 0, 0))
      electro.element(i).assign(vec4(e.x, e.y, kin.anodic, kin.cathodic))
    })().compute(this.cells) as ComputeNode
  }

  /** The new potential, its Newton step capped at ±150 mV, within the potential's window. */
  private buildPotentialOut() {
    const {electro, aux} = this.nodes()
    const {u} = this.multigrid.nodes
    return Fn(() => {
      const i = int(instanceIndex)
      const e = electro.element(i).toVar()
      const wet = aux.element(i).x.greaterThan(1e-9)
      const phi = select(wet, clamp(e.y.add(clamp(u.element(i).x.sub(e.y), -0.15, 0.15)), POTENTIAL_LOW, POTENTIAL_HIGH), e.y)
      electro.element(i).assign(vec4(e.x, phi, e.z, e.w))
    })().compute(this.cells) as ComputeNode
  }

  /**
   * Sums `value` (a vec4 and a scalar per cell) over each patch label of the grid in two passes: tiles of `TILE` cells
   * into partial sums per label, then each label's partials, into `out` as `(Σ vector, (Σ scalar, ·, ·, ·))` per label.
   */
  private buildLabelSums(value: (i: Node<'int'>, x: Node<'int'>, y: Node<'int'>) => {v: Node<'vec4'>; b: Node<'float'>},
    out: StorageBufferAttribute, electrical: boolean): [ComputeNode, ComputeNode] {
    const slots = electrical ? DROPS : LABELS
    const {aux} = this.nodes()
    const partials = storage(this.partials, 'vec4', (this.cells / TILE) * LABELS * 2)
    const totals = storage(out, 'vec4', LABELS * 2)
    const n = this.grid.resolution
    const tiles = this.cells / TILE
    const tile = Fn(() => {
      const vShared = sharedArray('vec4', TILE)
      const bShared = sharedArray('float', TILE)
      const lane = int(localId.x)
      const i = int(workgroupId.x).mul(TILE).add(lane)
      const label = electrical ? patchOf(aux.element(i).w) : int(aux.element(i).w)
      const sample = value(i, i.mod(n), i.div(n))
      const v = sample.v.toVar()
      const b = sample.b.toVar()
      for (let l = 1; l <= slots; l++) {
        const mine = label.equal(l)
        vShared.element(lane).assign(select(mine, v, vec4(0)))
        bShared.element(lane).assign(select(mine, b, float(0)))
        workgroupBarrier()
        for (let stride = TILE / 2; stride >= 1; stride /= 2) {
          If(lane.lessThan(stride), () => {
            vShared.element(lane).addAssign(vShared.element(lane.add(stride)))
            bShared.element(lane).addAssign(bShared.element(lane.add(stride)))
          })
          workgroupBarrier()
        }
        If(lane.equal(0), () => {
          const slot = int(workgroupId.x).mul(LABELS).add(l - 1)
          partials.element(slot.mul(2)).assign(vShared.element(int(0)))
          partials.element(slot.mul(2).add(1)).assign(vec4(bShared.element(int(0)), 0, 0, 0))
        })
        workgroupBarrier()
      }
    })().computeKernel([TILE]) as ComputeNode
    tile.dispatchSize = [tiles, 1, 1]
    const total = Fn(() => {
      const vShared = sharedArray('vec4', TILE)
      const bShared = sharedArray('float', TILE)
      const lane = int(localId.x)
      const l = int(workgroupId.x)
      const v = vec4(0).toVar()
      const b = float(0).toVar()
      Loop({start: lane, end: int(tiles), type: 'int', condition: '<', update: TILE}, ({i}) => {
        const slot = i.mul(LABELS).add(l)
        v.addAssign(partials.element(slot.mul(2)))
        b.addAssign(partials.element(slot.mul(2).add(1)).x)
      })
      vShared.element(lane).assign(v)
      bShared.element(lane).assign(b)
      workgroupBarrier()
      for (let stride = TILE / 2; stride >= 1; stride /= 2) {
        If(lane.lessThan(stride), () => {
          vShared.element(lane).addAssign(vShared.element(lane.add(stride)))
          bShared.element(lane).addAssign(bShared.element(lane.add(stride)))
        })
        workgroupBarrier()
      }
      If(lane.equal(0), () => {
        totals.element(l.mul(2)).assign(vShared.element(int(0)))
        totals.element(l.mul(2).add(1)).assign(vec4(bShared.element(int(0)), 0, 0, 0))
      })
    })().computeKernel([TILE]) as ComputeNode
    total.dispatchSize = [slots, 1, 1]
    return [tile, total]
  }

  /** Each patch's residual `F − A u` and `B`, for the exact correction of its mean. */
  private buildPatchSums(d: Diffusivity, electrical: boolean): [ComputeNode, ComputeNode] {
    const mg = this.multigrid
    const level = mg.levels[0]
    return this.buildLabelSums((i, x, y) => ({
      v: mg.nodes.f.element(i).sub(mg.apply(i, x, y, level, d)),
      b: mg.nodes.k.element(i).z,
    }), this.patches, electrical)
  }

  /**
   * Each patch's chloride migration: what its anodic cells ask for, and what its cathodic cells can give (no more than
   * nine tenths of what they hold), so that what moves is the smaller of the two, conserved.
   */
  private buildCurrentSums(): [ComputeNode, ComputeNode] {
    const {electro, species} = this.nodes()
    return this.buildLabelSums(i => {
      const e = electro.element(i)
      const sp = species.element(i)
      const wet = float(e.x.greaterThan(WET_FILM))
      const asked = this.migration(e, sp)
      const given = min(max(asked, max(sp.y, 0).mul(-0.9)), 0)
      return {v: vec4(max(asked, 0), given, 0, 0).mul(wet), b: float(0)}
    }, this.patchCurrents, true)
  }

  /**
   * Chloride (M·µm) a cell draws in over the step by migration: the current leaving its electrolyte is its net electrode
   * current (`∇·J = i_a − i_c`), and Cl⁻ carries its share, `t = 0.6 c_Cl / (c_Cl + c_OH + 2 c_Fe)` (as it runs low,
   * OH⁻ and the cations carry the current instead), so it gains `t (i_a − i_c) dt / F`.
   */
  private migration(e: Node<'vec4'>, sp: Node<'vec4'>) {
    const chloride = max(sp.y, 0)
    const share = chloride.div(chloride.add(max(sp.z, 0)).add(max(sp.x, 0).mul(2)).add(1e-6)).mul(CHLORIDE_TRANSFERENCE)
    return share.mul(e.z.sub(e.w)).mul(1e3 / FARADAY).mul(this.uniforms.dt)
  }

  /** Shifts each labelled patch's solution by its summed residual over its summed `B`: its mean becomes exact. */
  private buildPatchShift(electrical: boolean) {
    const {aux} = this.nodes()
    const {u} = this.multigrid.nodes
    const patches = storage(this.patches, 'vec4', LABELS * 2)
    return Fn(() => {
      const i = int(instanceIndex)
      const label = electrical ? patchOf(aux.element(i).w) : int(aux.element(i).w)
      If(label.greaterThan(0), () => {
        const slot = label.sub(1).mul(2)
        const b = patches.element(slot.add(1)).x
        If(b.greaterThan(1e-30), () => {
          u.element(i).addAssign(patches.element(slot).div(b))
        })
      })
    })().compute(this.cells) as ComputeNode
  }

  /** The currents at the solved potential (and the rust-reduction current for the reactions). */
  private buildCurrents() {
    const {electro, species, aux, chem} = this.nodes()
    const steel = storage(this.steel, 'vec4', this.cells)
    return Fn(() => {
      const i = int(instanceIndex)
      const e = electro.element(i).toVar()
      const c = chem.element(i).toVar()
      const kin = this.kinetics(e.x, e.y, species.element(i), aux.element(i), steel.element(i), c.w)
      electro.element(i).assign(vec4(e.x, e.y, kin.anodic, kin.cathodic))
      chem.element(i).assign(vec4(c.x, c.y, kin.reduction, c.w))
    })().compute(this.cells) as ComputeNode
  }

  /**
   * The species problem: backward-Euler diffusion within patches (`a = dt D h`, `B = h dx²`), Fe²⁺ from the anodes,
   * alkalinity from the cathodes, and chloride migrating toward the anodes. The migration needs no potential
   * gradients: the current leaving a cell's electrolyte is its net electrode current (`∇·J = i_a − i_c`), of which
   * Cl⁻ carries its share, so each cell gains `t(i_a − i_c)/F` of chloride, less its patch's mean (exact conservation).
   */
  private buildTransportSetup() {
    const {electro, species, aux} = this.nodes()
    const {u, f, k} = this.multigrid.nodes
    const currents = storage(this.patchCurrents, 'vec4', LABELS * 2)
    const u0 = this.uniforms
    const area = this.cell * this.cell
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y} = this.cellOf(i)
      const e = electro.element(i).toVar()
      const sp = species.element(i).toVar()
      const label = int(aux.element(i).w)
      const h = e.x
      const wet = h.greaterThan(WET_FILM)
      // anodic cells gain, cathodic ones give, each scaled so that the patch's gains and losses match
      const patch = currents.element(maxInt(patchOf(aux.element(i).w).sub(1), 0).mul(2))
      const asked = this.migration(e, sp)
      const gain = min(patch.y.negate().div(max(patch.x, 1e-12)), 1)
      const loss = min(patch.x.div(max(patch.y.negate(), 1e-12)), 1)
      const moved = select(asked.greaterThan(0), asked.mul(gain), max(asked, max(sp.y, 0).mul(-0.9)).mul(loss))
      const drawn = select(label.greaterThan(0).and(wet), moved, float(0))
      const {aE, aN} = this.couplings(aux, i, x, y, j => electro.element(j).x, true)
      const old = vec4(max(sp.x, 0), max(sp.y, 0), sp.z, 0)
      const sources = vec4(
        e.z.mul(FERROUS_PER_ANODIC).mul(u0.dt),
        drawn,
        e.w.mul(ALKALINITY_PER_CATHODIC).mul(u0.dt),
        0,
      )
      k.element(i).assign(vec4(aE.mul(u0.dt), aN.mul(u0.dt), select(wet, h.mul(area), float(1e-6)), 0))
      f.element(i).assign(select(wet, old.add(sources).mul(area), vec4(0)))
      u.element(i).assign(select(wet, old.div(max(h, 1e-6)), vec4(0)))
    })().compute(this.cells) as ComputeNode
  }

  /** Concentrations back to amounts, in wet cells. */
  private buildSpeciesOut() {
    const {electro, species} = this.nodes()
    const {u} = this.multigrid.nodes
    return Fn(() => {
      const i = int(instanceIndex)
      const h = electro.element(i).x
      If(h.greaterThan(WET_FILM), () => {
        const c = u.element(i)
        const sp = species.element(i).toVar()
        species.element(i).assign(vec4(max(c.x, 0).mul(h), max(c.y, 0).mul(h), c.z.mul(h), sp.w))
      })
    })().compute(this.cells) as ComputeNode
  }

  /**
   * Fe(OH)₂ precipitation in the fast-reaction limit. Fe²⁺ and OH⁻ cannot coexist, and a step (minutes) is long
   * against diffusion across a drop (seconds): precipitating where the transport mixed them would spread the rust over
   * the whole drop. Each cell's own mix precipitates `m = min(Fe²⁺, max(alkalinity, 0)/2)` (acid precipitates nothing),
   * which leaves its solution as the limit does; but where that happened is the source whose backward-Euler image is
   * `m`: `P = (B + L)·m`, `B + L` the transport's operator. That is at the anodes in an alkaline drop, at the cathodes
   * in an Fe²⁺-rich one, and on the front between (the Evans ring). Exactly solved it is never negative; the solver's
   * residuals make it so in places, which are clamped, and `buildPrecipitateScale` scales each patch's precipitate to
   * the Fe²⁺ that left its solution. The amount (M·µm) goes to the reactions in `u.w`.
   */
  private buildPrecipitate() {
    const {electro, species} = this.nodes()
    const {u, k} = this.multigrid.nodes
    const n = this.grid.resolution
    const area = this.cell * this.cell
    const D = SPECIES_DIFFUSIVITY[0]
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y} = this.cellOf(i)
      // from the transported concentrations (`u`, whose xyz this pass leaves as they are): no cell reads what another writes
      const mixed = (j: Node<'int'>) => {
        const c = u.element(j)
        return select(electro.element(j).x.greaterThan(WET_FILM), min(max(c.x, 0), max(c.z, 0).mul(0.5)), float(0))
      }
      const h = electro.element(i).x
      If(h.greaterThan(WET_FILM), () => {
        const film = max(h, 1e-6)
        const sp = species.element(i).toVar()
        const c = u.element(i).toVar()
        const own = min(max(c.x, 0), max(c.z, 0).mul(0.5)).toVar()
        const kc = k.element(i)
        const hasW = x.greaterThan(0)
        const hasS = y.greaterThan(0)
        const faces: [Node<'int'>, Node<'float'>][] = [
          [select(x.lessThan(n - 1), i.add(1), i), kc.x],
          [select(hasW, i.sub(1), i), select(hasW, k.element(select(hasW, i.sub(1), i)).x, float(0))],
          [select(y.lessThan(n - 1), i.add(n), i), kc.y],
          [select(hasS, i.sub(n), i), select(hasS, k.element(select(hasS, i.sub(n), i)).y, float(0))],
        ]
        let flow = float(0) as Node<'float'>
        for (const [j, coefficient] of faces) flow = flow.add(own.sub(mixed(j)).mul(coefficient))
        const precipitated = own.mul(film).add(flow.mul(D / area))
        species.element(i).assign(vec4(max(c.x, 0).sub(own).mul(film), sp.y, c.z.sub(own.mul(2)).mul(film), sp.w))
        u.element(i).assign(vec4(c.xyz, max(precipitated, 0)))
      })
    })().compute(this.cells) as ComputeNode
  }

  /** Each patch's precipitate as computed, and the Fe²⁺ that actually left its solution, for `buildPrecipitateScale`. */
  private buildPrecipitateSums(): [ComputeNode, ComputeNode] {
    const {electro, species} = this.nodes()
    const {u} = this.multigrid.nodes
    return this.buildLabelSums(i => {
      const h = electro.element(i).x
      const c = u.element(i)
      const wet = float(h.greaterThan(WET_FILM))
      const left = max(c.x, 0).mul(h).sub(max(species.element(i).x, 0))
      return {v: vec4(c.w, left, 0, 0).mul(wet), b: float(0)}
    }, this.patches, true)
  }

  /**
   * Scales each patch's precipitate to the Fe²⁺ that left its solution: the settled state is only as exact as the
   * transport's solve, and a residual would otherwise make or lose iron. The front-weighted shape stays.
   */
  private buildPrecipitateScale() {
    const {aux} = this.nodes()
    const {u} = this.multigrid.nodes
    const patches = storage(this.patches, 'vec4', LABELS * 2)
    return Fn(() => {
      const i = int(instanceIndex)
      const patch = patchOf(aux.element(i).w)
      If(patch.greaterThan(0), () => {
        const sums = patches.element(patch.sub(1).mul(2))
        const scale = select(sums.x.greaterThan(1e-12), max(sums.y, 0).div(sums.x), float(1))
        const c = u.element(i).toVar()
        u.element(i).assign(vec4(c.xyz, c.w.mul(scale)))
      })
    })().compute(this.cells) as ComputeNode
  }

  /**
   * The reactions of a step: the precipitated Fe(OH)₂ (from `buildPrecipitate`) becomes green rust, ferrihydrite or
   * lepidocrocite by local conditions, dissolved Fe²⁺ oxygenates (Stumm–Lee) into the phase its pH and chloride
   * select, green rust and lepidocrocite turn to magnetite without O₂, the young phases age, rust's Fe(II) reduced on
   * wetting re-oxidizes, the iron is lost (Faraday). What each phase grew goes to `buildEvents` in `f`. Every
   * intermediate is a variable: TSL re-emits expressions where they are used, which would read species after they changed.
   */
  private buildReact() {
    const {electro, species, aux, solidA, solidB, chem} = this.nodes()
    const {u: solution, f: grownOut} = this.multigrid.nodes
    const u = this.uniforms
    return Fn(() => {
      const i = int(instanceIndex)
      const e = electro.element(i).toVar()
      const sp = species.element(i).toVar()
      const a = aux.element(i).toVar()
      const sA = solidA.element(i).toVar()
      const sB = solidB.element(i).toVar()
      const c = chem.element(i).toVar()
      const dt = u.dt
      const h = e.x
      const wet = h.greaterThan(WET_FILM)
      const grown = vec4(0).toVar()

      If(wet, () => {
        const film = max(h, 1e-6).toVar()
        const toIron = film.mul(IRON_UM_PER_MOLAR_UM).toVar()
        const ferrous0 = max(sp.x, 0).div(film).toVar()
        const chloride0 = max(sp.y, 0).div(film).toVar()
        const alkalinity0 = sp.z.div(film).toVar()
        const pH = filmPH(alkalinity0, ferrous0).toVar()
        const hydroxide = min(exp(pH.sub(14).mul(LN10)), 1).toVar()
        const salting = exp(chloride0.add(max(alkalinity0, 0)).mul(-OXYGEN_SALTING * LN10)).toVar()
        const limit = salting.mul(OXYGEN_SOLUBILITY * OXYGEN_LIMIT).div(h.add(a.y.mul(4)).max(1e-3))
        const oxygen = clamp(float(1).sub(e.w.div(limit.add(1e-9))), 0, 1).toVar()

        // the precipitated Fe(OH)2 (and ferrous salt past its solubility): green rust where O2 is short, else oxidized
        const salted = max(ferrous0.sub(MAX_FERROUS), 0).toVar()
        const precipitated = solution.element(i).w.div(film).add(salted).toVar()
        const toGreen = smoothstep(0.6, 0.2, oxygen).mul(smoothstep(0.02, 0.2, chloride0)).toVar()
        const toFerrihydrite = smoothstep(0.02, 0.2, precipitated).mul(float(1).sub(toGreen)).toVar()
        const ferrous1 = ferrous0.sub(salted).toVar()

        // Stumm-Lee oxygenation of what stays dissolved; its phase by local conditions
        const rate = hydroxide.mul(hydroxide).mul(oxygen.mul(0.21).mul(salting)).mul(STUMM_LEE_K)
        const oxidized = ferrous1.mul(float(1).sub(exp(rate.mul(dt).negate()))).toVar()
        const wAkaganeite = smoothstep(0.3, 1.5, chloride0).mul(smoothstep(6.0, 4.5, pH)).toVar()
        const wGoethite = smoothstep(6.8, 5.2, pH).mul(float(1).sub(wAkaganeite)).toVar()
        const wFerrihydrite = smoothstep(0.02, 0.2, ferrous1).mul(smoothstep(7.2, 8.2, pH))
          .mul(max(float(1).sub(wAkaganeite).sub(wGoethite), 0)).toVar()
        const wLepidocrocite = max(float(1).sub(wAkaganeite).sub(wGoethite).sub(wFerrihydrite), 0).toVar()
        const ferrous2 = ferrous1.sub(oxidized).toVar()

        const green = precipitated.mul(toGreen).mul(toIron).toVar()
        const ferrihydrite = precipitated.mul(float(1).sub(toGreen)).mul(toFerrihydrite).add(oxidized.mul(wFerrihydrite)).mul(toIron).toVar()
        const lepidocrocite = precipitated.mul(float(1).sub(toGreen)).mul(float(1).sub(toFerrihydrite))
          .add(oxidized.mul(wLepidocrocite)).mul(toIron).toVar()
        const goethite = oxidized.mul(wGoethite).mul(toIron).toVar()
        const akaganeite = oxidized.mul(wAkaganeite).mul(toIron).toVar()

        // green rust oxidizes to lepidocrocite with O2, to magnetite without
        const greenToLepidocrocite = sA.x.mul(float(1).sub(exp(dt.mul(oxygen).div(-600)))).toVar()
        const greenToMagnetite = sA.x.sub(greenToLepidocrocite).mul(float(1).sub(exp(dt.mul(float(1).sub(oxygen)).div(-21600)))).toVar()
        // 2 FeOOH + Fe2+ -> Fe3O4 where O2 has run out (the inner layer, pits)
        const starving = float(1).sub(oxygen)
        const toMagnetite = min(max(sA.z.sub(sB.z), 0).mul(0.5), ferrous2.mul(toIron))
          .mul(float(1).sub(exp(dt.mul(starving).mul(starving).div(-7200)))).toVar()
        const ferrous3 = ferrous2.sub(toMagnetite.div(toIron)).toVar()
        // green rust takes a Cl- per four iron for an OH- (Fe(OH)2 to [Fe(II)3Fe(III)(OH)8]Cl) and gives both back as it
        // converts; oxygenation and magnetite formation release two H+ per Fe2+ (the anode acidifies, Fe2+ stays dissolved)
        const greenFormed = precipitated.mul(toGreen).toVar()
        const greenConverted = greenToLepidocrocite.add(greenToMagnetite).div(toIron).toVar()
        const alkalinity1 = alkalinity0.sub(oxidized.add(toMagnetite.div(toIron)).mul(2))
          .add(greenFormed.sub(greenConverted).mul(0.25)).toVar()
        const carbonated = select(alkalinity1.greaterThan(CARBONATED_ALKALINITY),
          alkalinity1.sub(CARBONATED_ALKALINITY).mul(exp(dt.div(-CARBONATION_TIME))).add(CARBONATED_ALKALINITY), alkalinity1).toVar()
        const chloride1 = chloride0.sub(greenFormed.sub(greenConverted).mul(0.25)).toVar()
        const crystallized = max(chloride1.sub(MAX_LIQUID), 0).toVar()
        // aging while wet: ferrihydrite and (slowly) lepidocrocite to goethite
        const ferrihydriteToGoethite = sA.y.mul(float(1).sub(exp(dt.div(-8 * SECONDS_PER_DAY)))).toVar()
        const lepidocrociteToGoethite = sA.z.mul(float(1).sub(exp(dt.div(-120 * SECONDS_PER_DAY)))).toVar()
        // lepidocrocite reduced on wetting (Stratmann), re-oxidized as O2 comes back (a tenth as magnetite)
        const reduced = min(sB.z.add(c.z.mul(dt).mul(RUST_REDUCTION_RATE)), sA.z).toVar()
        const reoxidized = reduced.mul(float(1).sub(exp(dt.mul(oxygen).div(-1800)))).toVar()

        const nextA = vec4(
          sA.x.add(green).sub(greenToLepidocrocite).sub(greenToMagnetite),
          sA.y.add(ferrihydrite).sub(ferrihydriteToGoethite),
          sA.z.add(lepidocrocite).add(greenToLepidocrocite).sub(toMagnetite.mul(2)).sub(lepidocrociteToGoethite).sub(reoxidized.mul(0.1)),
          sA.w.add(goethite).add(ferrihydriteToGoethite).add(lepidocrociteToGoethite),
        ).toVar()
        const nextB = vec4(
          sB.x.add(akaganeite),
          sB.y.add(greenToMagnetite).add(toMagnetite.mul(3)).add(reoxidized.mul(0.1)),
          reduced.sub(reoxidized),
          sB.w.add(e.z.mul(dt).mul(IRON_LOSS_RATE)),
        ).toVar()
        sA.assign(max(nextA, vec4(0)))
        sB.assign(max(nextB, vec4(0)))
        sp.assign(vec4(max(ferrous3, 0).mul(film), max(chloride1.sub(crystallized), 0).mul(film),
          carbonated.mul(film), sp.w.add(crystallized.mul(film))))
        grown.assign(vec4(lepidocrocite.add(greenToLepidocrocite), goethite, akaganeite, greenToMagnetite.add(toMagnetite.mul(3))))
        c.assign(vec4(filmPH(carbonated, max(ferrous3, 0)), oxygen, c.z, c.w))
      }).Else(() => {
        // a dried film: its Fe2+ oxidizes in air (lepidocrocite, some ferrihydrite), green rust too; rust's Fe(II) re-oxidizes
        const iron = max(sp.x, 0).mul(IRON_UM_PER_MOLAR_UM).toVar()
        const airGreen = sA.x.mul(float(1).sub(exp(dt.div(-1800)))).toVar()
        const reoxidized = sB.z.mul(float(1).sub(exp(dt.div(-1800)))).toVar()
        const nextA = vec4(sA.x.sub(airGreen), sA.y.add(iron.mul(0.3)), sA.z.add(iron.mul(0.7)).add(airGreen).sub(reoxidized.mul(0.1)), sA.w).toVar()
        const nextB = vec4(sB.x, sB.y.add(reoxidized.mul(0.1)), sB.z.sub(reoxidized), sB.w).toVar()
        sA.assign(max(nextA, vec4(0)))
        sB.assign(max(nextB, vec4(0)))
        sp.assign(vec4(0, sp.y, 0, sp.w.add(airGreen.div(IRON_UM_PER_MOLAR_UM).mul(0.25))))
        grown.assign(vec4(iron.mul(0.7).add(airGreen), 0, 0, 0))
        c.assign(vec4(7, 1, 0, c.w))
      })

      const crust = sA.x.mul(LP.greenRust).add(sA.y.mul(LP.ferrihydrite)).add(sA.z.mul(LP.lepidocrocite))
        .add(sA.w.mul(LP.goethite)).add(sB.x.mul(LP.akaganeite)).add(sB.y.mul(LP.magnetite)).toVar()
      const dense = sB.y.mul(LP.magnetite).add(sA.w.mul(LP.goethite))
      const cover = float(1).div(dense.div(3).add(1)).toVar()
      solidA.element(i).assign(sA)
      solidB.element(i).assign(sB)
      species.element(i).assign(sp)
      aux.element(i).assign(vec4(a.x, crust, cover, a.w))
      chem.element(i).assign(vec4(c.x, c.y, c.z, max(sA.z.sub(sB.z), 0)))
      grownOut.element(i).assign(grown)
    })().compute(this.cells) as ComputeNode
  }

  /**
   * Nucleation of the crystals: per cell and phase (lepidocrocite, goethite, akaganeite, magnetite) a Bernoulli trial
   * as likely as the iron that phase grew this step, `NUCLEATION` clusters per µm² per µm of iron.
   */
  private buildEvents() {
    const {f: grownIn} = this.multigrid.nodes
    const events = storage(this.events, 'vec4', EVENT_CAPACITY)
    const eventCount = storage(this.eventCount, 'uint', 4).toAtomic()
    const u = this.uniforms
    const cellArea = this.cell * this.cell
    return Fn(() => {
      const i = int(instanceIndex)
      const {world} = this.cellOf(i)
      const grown = grownIn.element(i).toVar()
      const amounts = [grown.x, grown.y, grown.z, grown.w]
      amounts.forEach((amount, k) => {
        const phase = k + 1
        const expected = amount.mul(NUCLEATION[phase] * cellArea)
        const chance = float(1).sub(exp(expected.negate()))
        const seed = uint(i).mul(2654435761).bitXor(u.step.mul(2246822519)).bitXor(uint(phase * 668265263 + 374761393)).toVar()
        If(hash(seed).lessThan(chance), () => {
          const slot = atomicAdd(eventCount.element(0), uint(1)).toVar()
          If(slot.lessThan(EVENT_CAPACITY), () => {
            const jitter = vec2(hash(seed.add(1)), hash(seed.add(2))).sub(0.5).mul(this.cell)
            const size = clamp(amount.mul(4), 0, 0.99)
            events.element(slot).assign(vec4(world.add(jitter), u.time, float(phase + 1).add(size)))
          })
        })
      })
    })().compute(this.cells) as ComputeNode
  }

  /** Iron lost, crust and phase mix, averaged over each snapshot texel, into the layer `snapshotLayer` (if ≥ 0). */
  private buildSnapshot() {
    const solidA = storage(this.solidA, 'vec4', this.cells)
    const solidB = storage(this.solidB, 'vec4', this.cells)
    const snapshots = storage(this.snapshots, 'uvec2', this.snapshotCount * this.snapshotSize * this.snapshotSize)
    const u = this.uniforms
    const m = this.snapshotSize
    const ds = this.grid.snapshotDownsample
    const n = this.grid.resolution
    return Fn(() => {
      If(u.snapshotLayer.greaterThanEqual(0), () => {
        const t = int(instanceIndex)
        const sx = t.mod(m)
        const sy = t.div(m)
        const loss = float(0).toVar()
        const phases = vec4(0).toVar()
        const crust = float(0).toVar()
        for (let dy = 0; dy < ds; dy++) {
          for (let dx = 0; dx < ds; dx++) {
            const i = sy.mul(ds).add(dy).mul(n).add(sx.mul(ds).add(dx))
            const a = solidA.element(i)
            const b = solidB.element(i)
            loss.addAssign(b.w)
            const lp = a.z.mul(LP.lepidocrocite)
            const gt = a.w.mul(LP.goethite)
            const ak = b.x.mul(LP.akaganeite)
            const mg = b.y.mul(LP.magnetite)
            phases.addAssign(vec4(lp, gt, ak, mg))
            crust.addAssign(lp.add(gt).add(ak).add(mg).add(a.x.mul(LP.greenRust)).add(a.y.mul(LP.ferrihydrite)))
          }
        }
        const count = ds * ds
        const mix4 = phases.div(max(crust, 1e-6))
        const byte = (v: Node<'float'>) => uint(clamp(v, 0, 1).mul(255).add(0.5))
        const packed = byte(mix4.x).bitOr(byte(mix4.y).shiftLeft(8)).bitOr(byte(mix4.z).shiftLeft(16)).bitOr(byte(mix4.w).shiftLeft(24))
        const index = u.snapshotLayer.mul(m * m).add(t)
        const halves = packHalf2x16(vec2(loss.div(count), crust.div(count))) as unknown as Node<'uint'>
        snapshots.element(index).assign(uvec2(halves, packed))
      })
    })().compute(m * m) as ComputeNode
  }
}
