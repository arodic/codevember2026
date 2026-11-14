import { ComputeNode, StorageBufferAttribute, WebGPURenderer } from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import {
  Fn, If, Loop, abs, atomicAdd, atomicLoad, atomicMax, atomicStore, clamp, exp, float, floatBitsToUint, floor, hash,
  instanceIndex, int, localId, log, max, min, packHalf2x16, select, smoothstep, sqrt, storage, uint,
  uintBitsToFloat, uniform, uvec2, vec2, vec4, workgroupArray, workgroupBarrier, workgroupId,
} from 'three/tsl'
import { Diffusivity, Multigrid } from './RustMultigrid.js'
import {
  CARBONATE_CO3, CARBONATE_HCO3,
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
/**
 * Anodic and cathodic kinetics: currents (A/m²) at the reference potential and natural-log Tafel slopes (V). Scaled
 * together (the mixed potential stays) so a corroding drop's anode averages ~0.25 A/m², ~0.8 µm of iron a day while
 * wet: thin NaCl films on carbon steel measure 0.1–1 A/m² (Nishikata & Tsuru; Li & Hihara).
 */
const ANODIC_EXCHANGE = 0.055
const ANODIC_TAFEL = 0.026
const CATHODIC_EXCHANGE = 0.08
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
/**
 * Lepidocrocite reduction current (A/m², Stratmann) at the reference potential with plenty of it to reduce: a cathode
 * beside O₂ reduction, scaled with it (`CATHODIC_EXCHANGE`), so rust reduces as it wets without becoming the cathode
 * that grows more rust on itself.
 */
const RUST_REDUCTION = 0.03
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
/** How far (µm) past a drop's edge its Fe²⁺ can meet the film's alkalinity on a front (see `buildPrecipitate`). */
const FRONT_REACH = 10
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

/** The periodic tile the bake runs on, centred on the origin. */
export interface BakeGrid {
  /** Side (µm). */
  size: number
  /** Cells per side (a power of two). */
  resolution: number
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

/** `filmPH` of RustScience (carbonate-buffered in air) in float32, without cancellation. */
function filmPH(alkalinity: Node<'float'>, ferrous: Node<'float'>) {
  const effective = alkalinity.sub(sqrt(max(ferrous, 0).mul(FERROUS_HYDROLYSIS)))
  const c1 = CARBONATE_HCO3 + 1e-14
  const root = sqrt(effective.mul(effective).add(4 * c1))
  const y = select(effective.greaterThanEqual(0), effective.add(root).mul(0.5), float(2 * c1).div(root.sub(effective)))
  const acidic = log10(max(y, 1e-30)).sub(Math.log10(c1))
  const x = effective.mul(2).div(sqrt(effective.mul(8 * CARBONATE_CO3).add(c1 * c1)).add(c1))
  return select(effective.greaterThan(1e-4), log10(max(x, 1)), acidic)
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
  /**
   * Fresh rust since the volume last grew (Fe-µm per cell): (green rust, ferrihydrite, lepidocrocite, goethite) and
   * (akaganeite, magnetite, ·, ·), as iron from solution or a dried film; conversions between phases are not in it.
   */
  readonly depositA: StorageBufferAttribute
  readonly depositB: StorageBufferAttribute
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
    this.originX = -grid.size / 2
    this.originZ = -grid.size / 2
    this.snapshotSize = n
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
    this.depositA = vec4Buffer(this.cells)
    this.depositB = vec4Buffer(this.cells)
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

  /** Cell index range `[lo, hi]` along one axis covering world `[a, b]`, unwrapped (it may run past the tile). */
  private span(a: Node<'float'>, b: Node<'float'>, origin: number) {
    const n = this.grid.resolution
    const lo = int(floor(a.sub(origin).div(this.cell)))
    const hi = minInt(int(floor(b.sub(origin).div(this.cell))), lo.add(n - 1))
    return {lo, hi}
  }

  /** Index of cell `(x, y)`, wrapped onto the tile (from up to a tile outside it). */
  wrap(x: Node<'int'>, y: Node<'int'>) {
    const n = this.grid.resolution
    return y.add(n).mod(n).mul(n).add(x.add(n).mod(n))
  }

  /** The shortest of `d`'s periodic images (µm): offsets between points of the tile. */
  private nearest(d: Node<'vec2'>) {
    const size = this.grid.size
    return d.sub(floor(d.div(size).add(0.5)).mul(size))
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
    const depositA = storage(this.depositA, 'vec4', this.cells)
    const depositB = storage(this.depositB, 'vec4', this.cells)
    const deposits = Fn(() => {
      depositA.element(instanceIndex).assign(vec4(0))
      depositB.element(instanceIndex).assign(vec4(0))
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
    return [fields, rest, deposits]
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
    const list: ComputeNode[] = [this.buildSaltLanding(), this.buildSmallCaps(), this.buildLargeCaps(), this.buildMicroCaps()]
    list.push(this.buildFilm(), this.buildLabelCopy())
    const kinetics = this.buildKinetics()
    const potentialOut = this.buildPotentialOut()
    const [patchTiles, patchTotals] = this.buildPatchSums(POTENTIAL_DIFFUSIVITY, true)
    const potentialShift = this.buildPatchShift(true)
    for (let newton = 0; newton < 2; newton++) {
      list.push(kinetics, ...mg.coefficientNodes, ...mg.vCycle(POTENTIAL_DIFFUSIVITY))
      list.push(patchTiles, patchTotals, potentialShift, potentialOut)
    }
    // the species' totals are made exact by shifting the drop of each patch, which holds nearly all its volume: a
    // shift over the whole patch would carry the drop's residual into its thin film, flipping its chemistry
    const [speciesTiles, speciesTotals] = this.buildPatchSums(SPECIES_DIFFUSIVITY, true, true)
    const speciesShift = this.buildPatchShift(true, true)
    list.push(this.buildCurrents(), ...this.buildCurrentSums())
    list.push(this.buildTransportSetup(), ...mg.coefficientNodes)
    for (let cycle = 0; cycle < 3; cycle++) list.push(...mg.vCycle(SPECIES_DIFFUSIVITY))
    list.push(speciesTiles, speciesTotals, speciesShift, this.buildSpeciesOut(), this.buildPrecipitate())
    list.push(...this.buildPrecipitateSums(), this.buildPrecipitateScale(), this.buildReact(), this.buildEvents())
    list.push(this.buildDeposit())
    return list
  }

  /** Salt landing this step, spread over each crystal's footprint (fixed point, summed). */
  private buildSaltLanding() {
    const deposits = storage(this.deposits, 'vec4', this.depositCount)
    const accum = storage(this.accum, 'uint', this.cells * 4).toAtomic()
    const u = this.uniforms
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
          atomicAdd(accum.element(this.wrap(j, i).mul(4).add(2)), fixed)
        })
      })
    })().compute(this.depositCount) as ComputeNode
  }

  /** Writes a cap (`radius`, `height` at `(cx, cz)`) into the film by atomic max, with `label` (0 = none). */
  private capLoop(accum: AtomicBuffer, cx: Node<'float'>, cz: Node<'float'>, radius: Node<'float'>, height: Node<'float'>, label: Node<'uint'> | null) {
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
        const cell = this.wrap(j, i).mul(4)
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
            const cell = this.wrap(cx, cz).mul(4)
            atomicMax(accum.element(cell), floatBitsToUint(h))
            // + LABELS: a drop's label wins over its microdroplets' (theirs are higher) where they overlap
            atomicMax(accum.element(cell.add(1)), uint(k.add(1 + LABELS)))
          })
        })
      })
    })().computeKernel([64]) as ComputeNode
    node.dispatchSize = [MAX_LARGE_DROPS, 1, 1]
    return node
  }

  /** Microdroplets, wet once their parent's spreading film has reached them; those its drop reaches have joined it. */
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
      const radius = m.z.mul(u.microScale).toVar()
      const drop = large.element(p)
      const apart = this.nearest(m.xy.sub(drop.xy)).length().greaterThan(drop.z.add(radius))
      If(film.y.greaterThan(0.5).and(m.w.lessThan(film.x)).and(m.z.greaterThan(0)).and(apart), () => {
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
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y, world} = this.cellOf(i)
      const caps = uintBitsToFloat(atomicLoad(accum.element(i.mul(4))))
      const stored = atomicLoad(accum.element(i.mul(4).add(1)))
      const capLabel = select(stored.greaterThan(LABELS), stored.sub(LABELS), stored)
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
        const r = this.nearest(world.sub(drop.xy)).length()
        const inside = film.y.greaterThan(0.5).and(r.greaterThan(drop.z)).and(r.lessThan(drop.z.add(film.x)))
        If(inside, () => {
          spread.assign(max(spread, smoothstep(drop.z.add(film.x), drop.z.add(film.x.mul(0.85)), r).mul(SPREAD_FILM)))
          spreadLabel.assign(maxUint(spreadLabel, uint(k + DROPS + 1)))
        })
      }
      // effloresced (the clock's salt is solid): the brine crystallizes where it is, only alkali still holds water
      const brine = u.liquid.greaterThan(0.5)
      If(brine.not(), () => {
        sp.assign(vec4(sp.x, 0, sp.z, sp.w.add(sp.y)))
      })
      const adsorbed = smoothstep(0.6, 0.95, u.rh).mul(4).add(1).mul(0.003)
      const salty = smoothstep(0, 5, sp.y.add(sp.w))
      const rustWater = min(a.y.mul(0.25), 4).mul(smoothstep(0.55, 0.9, u.rh)).mul(salty.mul(0.65).add(0.35))
      // dissolved salt and alkali hold as much water as the humidity lets them (and salt crust re-deliquesces)
      const solute = select(brine, sp.y.add(max(sp.z, 0)).add(select(u.rh.greaterThanEqual(DELIQUESCENCE_RH), sp.w, float(0))), max(sp.z, 0))
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
        sp.assign(vec4(sp.x, 0, sp.z, sp.w.add(sp.y)))
      })
      species.element(i).assign(sp)

      const ionic = sp.y.add(max(sp.z, 0)).add(sp.x.mul(2)).div(max(h, 1e-6)).toVar()
      const kappa = max(float(8.5).mul(ionic).div(ionic.mul(0.15).add(1)), select(spread.greaterThan(0), float(0.5), float(0)))
      const kappaH = select(wet, kappa.mul(h), float(0)).toVar()

      // a cap's label, else the spreading film's, else (brine-wet rust, hygroscopic films) a wet neighbour's label of
      // the same kind (next to a drop it joins the drop, next to a film the passive film), or its own
      const label = select(uint(capLabel).greaterThan(0), uint(capLabel), spreadLabel).toVar()
      If(label.equal(uint(0)).and(wet), () => {
        const neighbour = (di: Node<'int'>) => uint(aux.element(di).w)
        label.assign(maxUint(maxUint(neighbour(this.wrap(x.add(1), y)), neighbour(this.wrap(x.sub(1), y))),
          maxUint(neighbour(this.wrap(x, y.add(1))), neighbour(this.wrap(x, y.sub(1))))))
        label.assign(maxUint(label, uint(a.w)))
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
    const patch = (l: Node<'float'>) => electrical ? patchOf(l) : int(l)
    const label = patch(aux.element(i).w)
    const east = this.wrap(x.add(1), y)
    const north = this.wrap(x, y.add(1))
    const coupled = (j: Node<'int'>) => label.greaterThan(0).and(patch(aux.element(j).w).equal(label))
    const aE = select(coupled(east), harmonic(value(i), value(east)), float(0))
    const aN = select(coupled(north), harmonic(value(i), value(north)), float(0))
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
  private buildLabelSums(
    value: (i: Node<'int'>, x: Node<'int'>, y: Node<'int'>, aux: ReturnType<RustBake['nodes']>['aux']) => {v: Node<'vec4'>; b: Node<'float'>},
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
      const sample = value(i, i.mod(n), i.div(n), aux)
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
  private buildPatchSums(d: Diffusivity, electrical: boolean, dropsOnly = false): [ComputeNode, ComputeNode] {
    const mg = this.multigrid
    const level = mg.levels[0]
    return this.buildLabelSums((i, x, y, aux) => ({
      v: mg.nodes.f.element(i).sub(mg.apply(i, x, y, level, d)),
      b: dropsOnly ? mg.nodes.k.element(i).z.mul(float(aux.element(i).w.lessThan(DROPS + 0.5))) : mg.nodes.k.element(i).z,
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
  private buildPatchShift(electrical: boolean, dropsOnly = false) {
    const {aux} = this.nodes()
    const {u} = this.multigrid.nodes
    const patches = storage(this.patches, 'vec4', LABELS * 2)
    return Fn(() => {
      const i = int(instanceIndex)
      const label = electrical ? patchOf(aux.element(i).w) : int(aux.element(i).w)
      const shifted = dropsOnly ? label.greaterThan(0).and(aux.element(i).w.lessThan(DROPS + 0.5)) : label.greaterThan(0)
      If(shifted, () => {
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
   * Fe(OH)₂ precipitation in the fast-reaction limit. Fe²⁺ and OH⁻ cannot coexist, and a step (minutes) is long against
   * diffusion across a drop (seconds), so each step reaches the quasi-steady state: `ψ = Fe²⁺ − alkalinity/2`, which
   * precipitation leaves as it is, diffuses with the electrode sources. Where `ψ > 0` the solution holds Fe²⁺ and the
   * OH⁻ the cathodes make there precipitates in place; where `ψ < 0` it holds alkalinity and the Fe²⁺ the anodes make
   * there precipitates in place; and what diffuses across the front `ψ = 0` precipitates on it (`D k |Δψ|` through
   * each face it crosses, shared by how near it runs to either cell): at the anodes of an alkaline drop, at the
   * cathodes of an Fe²⁺-rich one, and where a drop's Fe²⁺ meets the alkaline film around it (the Evans ring). Only
   * faces within `FRONT_REACH` of a drop's edge count: farther out in the thin film the flux is the solve's error times a
   * large conductance, not iron (what it would have placed forms where the mix is). How much
   * precipitates is exact: each cell's own mix after the transport, `min(Fe²⁺, alkalinity/2)`, which leaves its
   * solution as the limit does; `buildPrecipitateScale` places each patch's total by these estimates. (The place cannot
   * come from the transport's operator applied to that mix, the source whose image it is: at `D dt/dx² ~ 10⁵` that
   * amplifies the solve's rounding into a checkerboard of hot spots.) The estimate and the mix (M·µm) go to `f`.
   */
  private buildPrecipitate() {
    const {electro, species} = this.nodes()
    const {u, f, k} = this.multigrid.nodes
    const large = storage(this.largeDrops, 'vec4', MAX_LARGE_DROPS * 2)
    const dt = this.uniforms.dt
    const D = SPECIES_DIFFUSIVITY[0] / (this.cell * this.cell)
    return Fn(() => {
      const i = int(instanceIndex)
      const {x, y, world} = this.cellOf(i)
      const e = electro.element(i).toVar()
      const h = e.x
      If(h.greaterThan(WET_FILM), () => {
        const film = max(h, 1e-6)
        const sp = species.element(i).toVar()
        // from the transported concentrations (`u`, whose xyz this pass leaves as they are): no cell reads what another writes
        const c = u.element(i).toVar()
        const own = min(max(c.x, 0), max(c.z, 0).mul(0.5)).toVar()
        const nearDrop = float(0).toVar()
        for (let d = 0; d < MAX_LARGE_DROPS; d++) {
          const drop = large.element(d)
          const within = drop.z.greaterThan(0).and(this.nearest(world.sub(drop.xy)).length().lessThan(drop.z.add(FRONT_REACH)))
          nearDrop.assign(max(nearDrop, float(within)))
        }
        const psi = c.x.sub(c.z.mul(0.5)).toVar()
        const kc = k.element(i)
        const west = this.wrap(x.sub(1), y)
        const south = this.wrap(x, y.sub(1))
        const faces: [Node<'int'>, Node<'float'>][] = [
          [this.wrap(x.add(1), y), kc.x], [west, k.element(west).x], [this.wrap(x, y.add(1)), kc.y], [south, k.element(south).y],
        ]
        // what crosses the front through each face (a coefficient is 0 out of the patch), this cell's share of it
        let flux = float(0) as Node<'float'>
        for (const [j, coefficient] of faces) {
          const cj = u.element(j)
          const other = cj.x.sub(cj.z.mul(0.5))
          const share = abs(other).div(abs(psi).add(abs(other)).add(1e-30))
          flux = flux.add(select(psi.mul(other).lessThan(0), coefficient.mul(abs(psi.sub(other))).mul(share), float(0)))
        }
        const inPlace = select(psi.greaterThan(0), e.w.mul(ALKALINITY_PER_CATHODIC * 0.5), e.z.mul(FERROUS_PER_ANODIC)).mul(dt)
        species.element(i).assign(vec4(max(c.x, 0).sub(own).mul(film), sp.y, c.z.sub(own.mul(2)).mul(film), sp.w))
        f.element(i).assign(vec4(inPlace.add(flux.mul(D).mul(nearDrop)), 0, own.mul(film), 0))
        u.element(i).assign(vec4(c.xyz, own.mul(film)))
      }).Else(() => {
        f.element(i).assign(vec4(0))
      })
    })().compute(this.cells) as ComputeNode
  }

  /** Each patch's precipitate estimate and its total, for `buildPrecipitateScale`. */
  private buildPrecipitateSums(): [ComputeNode, ComputeNode] {
    const {f} = this.multigrid.nodes
    return this.buildLabelSums(i => ({v: f.element(i), b: float(0)}), this.patches, true)
  }

  /**
   * Places each patch's precipitate by the estimates (scaled down when they come to more than its total); what they
   * miss (the old solution mixing as the patch changed) forms where the mix was. A cell in no patch keeps its own mix
   * (nothing moved there).
   */
  private buildPrecipitateScale() {
    const {aux} = this.nodes()
    const {u, f} = this.multigrid.nodes
    const patches = storage(this.patches, 'vec4', LABELS * 2)
    return Fn(() => {
      const i = int(instanceIndex)
      const patch = patchOf(aux.element(i).w)
      If(patch.greaterThan(0), () => {
        const sums = patches.element(patch.sub(1).mul(2)).toVar()
        const terms = f.element(i).toVar()
        const estimated = min(sums.z.div(max(sums.x, 1e-30)), 1).toVar()
        const missed = max(sums.z.sub(sums.x.mul(estimated)), 0).div(max(sums.z, 1e-30))
        const c = u.element(i).toVar()
        u.element(i).assign(vec4(c.xyz, terms.x.mul(estimated).add(terms.z.mul(missed))))
      })
    })().compute(this.cells) as ComputeNode
  }

  /**
   * The reactions of a step: the precipitated Fe(OH)₂ (from `buildPrecipitate`) becomes green rust, ferrihydrite or
   * lepidocrocite by local conditions, dissolved Fe²⁺ oxygenates (Stumm–Lee) into the phase its pH and chloride
   * select, green rust and lepidocrocite turn to magnetite without O₂, the young phases age, rust's Fe(II) reduced on
   * wetting re-oxidizes, the iron is lost (Faraday). The fresh iron per phase goes to `f` (GR, FH, LP, GT) and `u` (AK,
   * MG, and the lepidocrocite and magnetite converted from other phases) for `buildEvents` and the deposit. Every
   * intermediate is a variable: TSL re-emits expressions where they are used, which would read species after they changed.
   */
  private buildReact() {
    const {electro, species, aux, solidA, solidB, chem} = this.nodes()
    const {u: solution, f: freshOut} = this.multigrid.nodes
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
      const fresh = vec4(0).toVar()
      const freshMore = vec4(0).toVar()

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
        // FeCl2 past saturation crystallizes and oxidizes (akaganeite in its acid chloride), releasing oxygenation's acid
        const salted = max(ferrous0.sub(MAX_FERROUS), 0).toVar()
        const precipitated = solution.element(i).w.div(film).toVar()
        const toGreen = smoothstep(0.6, 0.2, oxygen).mul(smoothstep(0.02, 0.2, chloride0)).toVar()
        // green rust holds a Cl- per four iron: no more forms than the chloride there allows
        const greenFormed = min(precipitated.mul(toGreen), chloride0.mul(4)).toVar()
        const rest = precipitated.sub(greenFormed).toVar()
        const toFerrihydrite = smoothstep(0.02, 0.2, precipitated).toVar()
        const ferrous1 = ferrous0.sub(salted).toVar()

        // Stumm-Lee oxygenation of what stays dissolved; its phase by local conditions
        const rate = hydroxide.mul(hydroxide).mul(oxygen.mul(0.21).mul(salting)).mul(STUMM_LEE_K)
        const oxidized = ferrous1.mul(float(1).sub(exp(rate.mul(dt).negate()))).add(salted).toVar()
        const wAkaganeite = smoothstep(0.3, 1.5, chloride0).mul(smoothstep(6.0, 4.5, pH)).toVar()
        const wGoethite = smoothstep(6.8, 5.2, pH).mul(float(1).sub(wAkaganeite)).toVar()
        const wFerrihydrite = smoothstep(0.02, 0.2, ferrous1).mul(smoothstep(7.2, 8.2, pH))
          .mul(max(float(1).sub(wAkaganeite).sub(wGoethite), 0)).toVar()
        const wLepidocrocite = max(float(1).sub(wAkaganeite).sub(wGoethite).sub(wFerrihydrite), 0).toVar()
        const ferrous2 = ferrous0.sub(oxidized).toVar()

        const green = greenFormed.mul(toIron).toVar()
        const ferrihydrite = rest.mul(toFerrihydrite).add(oxidized.mul(wFerrihydrite)).mul(toIron).toVar()
        const lepidocrocite = rest.mul(float(1).sub(toFerrihydrite)).add(oxidized.mul(wLepidocrocite)).mul(toIron).toVar()
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
        const greenConverted = greenToLepidocrocite.add(greenToMagnetite).div(toIron).toVar()
        const alkalinity1 = alkalinity0.sub(oxidized.add(toMagnetite.div(toIron)).mul(2))
          .add(greenFormed.sub(greenConverted).mul(0.25)).toVar()
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
          alkalinity1.mul(film), sp.w.add(crystallized.mul(film))))
        fresh.assign(vec4(green, ferrihydrite, lepidocrocite, goethite))
        freshMore.assign(vec4(akaganeite, toMagnetite, greenToLepidocrocite, greenToMagnetite.add(toMagnetite.mul(2))))
        c.assign(vec4(filmPH(alkalinity1, max(ferrous3, 0)), oxygen, c.z, c.w))
      }).Else(() => {
        // a dried film: its Fe2+ oxidizes in air (lepidocrocite, some ferrihydrite), green rust too; rust's Fe(II) re-oxidizes
        const iron = max(sp.x, 0).mul(IRON_UM_PER_MOLAR_UM).toVar()
        const airGreen = sA.x.mul(float(1).sub(exp(dt.div(-1800)))).toVar()
        const reoxidized = sB.z.mul(float(1).sub(exp(dt.div(-1800)))).toVar()
        const nextA = vec4(sA.x.sub(airGreen), sA.y.add(iron.mul(0.3)), sA.z.add(iron.mul(0.7)).add(airGreen).sub(reoxidized.mul(0.1)), sA.w).toVar()
        const nextB = vec4(sB.x, sB.y.add(reoxidized.mul(0.1)), sB.z.sub(reoxidized), sB.w).toVar()
        sA.assign(max(nextA, vec4(0)))
        sB.assign(max(nextB, vec4(0)))
        const greenFreed = airGreen.div(IRON_UM_PER_MOLAR_UM).mul(0.25)
        sp.assign(vec4(0, sp.y, sp.z.sub(max(sp.x, 0).mul(2)).sub(greenFreed), sp.w.add(greenFreed)))
        fresh.assign(vec4(0, iron.mul(0.3), iron.mul(0.7), 0))
        freshMore.assign(vec4(0, 0, airGreen, 0))
        c.assign(vec4(7, 1, 0, c.w))
      })

      const crust = sA.x.mul(LP.greenRust).add(sA.y.mul(LP.ferrihydrite)).add(sA.z.mul(LP.lepidocrocite))
        .add(sA.w.mul(LP.goethite)).add(sB.x.mul(LP.akaganeite)).add(sB.y.mul(LP.magnetite)).toVar()
      const dense = sB.y.mul(LP.magnetite).add(sA.w.mul(LP.goethite))
      const cover = float(1).div(dense.div(10).add(1)).toVar()
      solidA.element(i).assign(sA)
      solidB.element(i).assign(sB)
      species.element(i).assign(sp)
      aux.element(i).assign(vec4(a.x, crust, cover, a.w))
      chem.element(i).assign(vec4(c.x, c.y, c.z, max(sA.z.sub(sB.z), 0)))
      freshOut.element(i).assign(fresh)
      solution.element(i).assign(freshMore)
    })().compute(this.cells) as ComputeNode
  }

  /** Adds this step's fresh rust per phase (from `buildReact`) to the deposit the volume grows from. */
  private buildDeposit() {
    const {f: freshIn, u: moreIn} = this.multigrid.nodes
    const depositA = storage(this.depositA, 'vec4', this.cells)
    const depositB = storage(this.depositB, 'vec4', this.cells)
    return Fn(() => {
      const i = int(instanceIndex)
      depositA.element(i).addAssign(freshIn.element(i))
      depositB.element(i).addAssign(vec4(moreIn.element(i).xy, 0, 0))
    })().compute(this.cells) as ComputeNode
  }

  /**
   * Nucleation of the crystals: per cell and phase (lepidocrocite, goethite, akaganeite, magnetite) a Bernoulli trial
   * as likely as the iron that phase grew this step, `NUCLEATION` clusters per µm² per µm of iron.
   */
  private buildEvents() {
    const {f: freshIn, u: moreIn} = this.multigrid.nodes
    const events = storage(this.events, 'vec4', EVENT_CAPACITY)
    const eventCount = storage(this.eventCount, 'uint', 4).toAtomic()
    const u = this.uniforms
    const cellArea = this.cell * this.cell
    return Fn(() => {
      const i = int(instanceIndex)
      const {world} = this.cellOf(i)
      const fresh = freshIn.element(i).toVar()
      const more = moreIn.element(i).toVar()
      // grown this step: lepidocrocite, goethite, akaganeite, magnetite (fresh or converted)
      const amounts = [fresh.z.add(more.z), fresh.w, more.x, more.y.add(more.w)]
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

  /** Iron lost, crust and phase mix of each cell into the layer `snapshotLayer` (if ≥ 0). */
  private buildSnapshot() {
    const solidA = storage(this.solidA, 'vec4', this.cells)
    const solidB = storage(this.solidB, 'vec4', this.cells)
    const snapshots = storage(this.snapshots, 'uvec2', this.snapshotCount * this.snapshotSize * this.snapshotSize)
    const u = this.uniforms
    const m = this.snapshotSize
    return Fn(() => {
      If(u.snapshotLayer.greaterThanEqual(0), () => {
        const t = int(instanceIndex)
        const a = solidA.element(t)
        const b = solidB.element(t)
        const lp = a.z.mul(LP.lepidocrocite)
        const gt = a.w.mul(LP.goethite)
        const ak = b.x.mul(LP.akaganeite)
        const mg = b.y.mul(LP.magnetite)
        const crust = lp.add(gt).add(ak).add(mg).add(a.x.mul(LP.greenRust)).add(a.y.mul(LP.ferrihydrite)).toVar()
        const mix4 = vec4(lp, gt, ak, mg).div(max(crust, 1e-6))
        const byte = (v: Node<'float'>) => uint(clamp(v, 0, 1).mul(255).add(0.5))
        const packed = byte(mix4.x).bitOr(byte(mix4.y).shiftLeft(8)).bitOr(byte(mix4.z).shiftLeft(16)).bitOr(byte(mix4.w).shiftLeft(24))
        const index = u.snapshotLayer.mul(m * m).add(t)
        const halves = packHalf2x16(vec2(b.w, crust)) as unknown as Node<'uint'>
        snapshots.element(index).assign(uvec2(halves, packed))
      })
    })().compute(m * m) as ComputeNode
  }
}
