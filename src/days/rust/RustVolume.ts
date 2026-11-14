import {
  ComputeNode, NearestFilter, RedIntegerFormat, Storage3DTexture, StorageBufferAttribute, UnsignedIntType,
  WebGPURenderer,
} from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import {
  Fn, If, Loop, abs, atomicAdd, atomicMin, clamp, cos, exp, float, floor, hash, instanceIndex, int, max, min, select,
  sin, smoothstep, sqrt, storage, storageTexture3D, uint, uniform, uvec3, uvec4, vec2, vec3, vec4,
} from 'three/tsl'
import { TILE_SIZE } from './RustSalt.js'
import { RUST_PHASES, volumeRatio } from './RustScience.js'
import type { RustBake } from './RustChemistry.js'

/**
 * Voxels per side of the tile and layers: 1.25 µm voxels (one per bake cell), 80 µm of height. Everything below is
 * in µm, so this is the resolution's one setting (1024 × 128 at 0.625 µm takes 8× the memory, ~600 MB).
 */
export const VOLUME_SIZE = 128
export const VOLUME_LAYERS = 64
export const VOXEL = TILE_SIZE / VOLUME_SIZE
/** Layers of steel under its original surface (at height 0): pits go this deep (20 µm), the rust in them too. */
export const STEEL_LAYERS = Math.round(20 / VOXEL)
export const VOLUME_BOTTOM = -STEEL_LAYERS * VOXEL
export const VOLUME_TOP = VOLUME_BOTTOM + VOLUME_LAYERS * VOXEL
/**
 * A voxel packs what it is (`KIND_BITS`), the tick it formed at and the tick it went (10 bits each, stored + 1; 0 for
 * born before the exposure, and not gone). Kinds: 0 empty, `STEEL`, `MATRIX_BASE` + phase for fine-grained rust, or
 * `CRYSTAL` with the offset of its nucleus's column (5 bits each way, + 16).
 */
export const KIND_BITS = 12
export const KIND_MASK = (1 << KIND_BITS) - 1
export const BIRTH_SHIFT = 12
export const DEATH_SHIFT = 22
export const TICK_MASK = 1023
/** The last tick a voxel can record: the timeline is cut into `MAX_TICK + 1` ticks. */
export const MAX_TICK = 1022
export const STEEL = 1
export const MATRIX_BASE = 2
export const CRYSTAL = 1 << 11
/** Side of the bricks (voxels) whose earliest birth lets the renderer skip empty space. */
export const BRICK = 8
/** The phases of the volume, in the order of the bake's deposits. */
export const VOLUME_PHASES = ['greenRust', 'ferrihydrite', 'lepidocrocite', 'goethite', 'akaganeite', 'magnetite'] as const

const VR = VOLUME_PHASES.map(name => volumeRatio(RUST_PHASES[name]))
/**
 * Crystals nucleated per µm² of surface per µm of fresh iron of that phase (green rust, lepidocrocite, goethite,
 * akaganeite, magnetite; ferrihydrite stays fine-grained): about one per 10 µm² once a micrometre of iron has turned
 * into the phase, as rosettes, cotton balls and octahedra a few micrometres across crowd fresh rust in SEM images.
 */
const NUCLEATION = [0.05, 0, 0.1, 0.06, 0.1, 0.05]
/** Reach (µm) of a crystal from its nucleus: hexagonal plates, -, rosette plates, needles, spindles, octahedra. */
const CRYSTAL_REACH = [3.5, 0, 5, 4.5, 3, 2]
/**
 * How strongly growth prefers sites with more solid around them (inner, outer: weight = solid faces^this): pockets
 * fill before tips grow, so rust grows as compact rounded globules and crusts; its roughness comes from where it
 * forms, not voxel noise (`NOISE`: the spread of a site's random weight).
 */
const SMOOTHING = [1.6, 1.4]
const NOISE = 0.6
/**
 * Where rust forms in a column (µm): Fe(OH)₂, green rust and magnetite at the metal (`INNER_DEPTH`); the
 * oxyhydroxides anywhere on the rust under the electrolyte (it coats every surface), hardly above it
 * (`OUTER_ABOVE`). A drop's air interface is far over its rust: drawing growth toward it would only raise spires.
 */
const INNER_DEPTH = 4
const OUTER_ABOVE = 2
/** Layers under the volume's top over which growth fades out (9 µm): rust turns aside before the ceiling. */
const CEILING = Math.round(9 / VOXEL)
/**
 * Growth slows (µm scale) above its neighbourhood's mean surface past an allowance: precipitate settles around a
 * mound's base and onto its flanks rather than stacking on its peak (domes and nodules, not spires).
 */
const SLOPE_ALLOWANCE = 1.5
const SLOPE_SCALE = 2.5
/**
 * What a column owes the volume carries between ticks: it places `floor(owed + θ)` voxels (θ a fixed random
 * threshold per column: unbiased, never more than a voxel off) and owes the rest, up to `MAX_PENDING` voxels it could
 * not place yet (30 µm of rust), or `MAX_CREDIT` ahead when the draws placed more.
 */
const MAX_PENDING = Math.round(30 / VOXEL)
const MAX_CREDIT = 2
/**
 * Rust nucleates on bare steel with no rust near at this chance per voxel of fresh precipitate there this tick, 2.4
 * islands per µm³ (it follows supersaturation, not what has drifted in); else what is owed drifts toward rust.
 */
const SEED = 2.4 * VOXEL ** 3
/** Of what a column with no rust near it owes, the share that drifts to its neighbours each tick (toward rust). */
const DRIFT = 0.6
/** Voxels a column may stand above its lowest neighbour before what it owes spills over (a slope: mounds, not pillars). */
const REPOSE = 3
/** Height (µm) over its steel past which rust draws drifting rust less (lower rust takes it first). */
const ATTRACTION_HEIGHT = 5
/**
 * How strongly bare steel draws the oxyhydroxides (lepidocrocite, goethite, akaganeite) where no rust touches it: they
 * nucleate on rust; Fe(OH)₂, green rust, ferrihydrite and magnetite form on the corroding metal itself.
 */
const BARE_DRAW = 0.08
/** Most steel voxels a column dissolves in a tick (15 µm), and how strongly corners and edges go first (exposed faces^this). */
const MAX_ETCH = Math.round(15 / VOXEL)
const ETCH_EXPOSURE = 1.6
/** Layers under a column's steel top that its etch and growth scan (7.5 µm: undercuts, rust in pits). */
const SCAN_DEPTH = Math.round(7.5 / VOXEL)

/** Integer min/max (TSL's are typed for floats). */
function maxInt(a: Node<'int'>, b: Node<'int'>) {
  return select(a.greaterThan(b), a, b)
}
function minInt(a: Node<'int'>, b: Node<'int'>) {
  return select(a.lessThan(b), a, b)
}
function minUint(a: Node<'uint'>, b: Node<'uint'>) {
  return select(a.lessThan(b), a, b)
}
function maxUint(a: Node<'uint'>, b: Node<'uint'>) {
  return select(a.greaterThan(b), a, b)
}

/** A voxel's kind, and whether it is there at `tick` (born by then, not gone). */
export function voxelKind(v: Node<'uint'>) {
  return v.bitAnd(KIND_MASK)
}
export function voxelAlive(v: Node<'uint'>, tick: Node<'uint'>) {
  const birth = v.shiftRight(BIRTH_SHIFT).bitAnd(TICK_MASK)
  const death = v.shiftRight(DEATH_SHIFT)
  return voxelKind(v).greaterThan(0).and(birth.lessThanEqual(tick.add(1))).and(death.equal(0).or(death.greaterThan(tick.add(1))))
}

type Volume = ReturnType<typeof storageTexture3D>

/** A voxel a column scan offers growth: its layer, centre, weights for inner and outer growth, the crystal by it. */
interface Candidate {
  z: Node<'int'>
  p: Node<'vec3'>
  v: Node<'uint'>
  wIn: Node<'float'>
  wOut: Node<'float'>
  crystal: Node<'int'>
  crystalPhase: Node<'int'>
  crystalInner: Node<'bool'>
  boost: Node<'float'>
  normal: Node<'vec3'>
}

/**
 * The specimen as a volume, grown from the bake: a periodic voxel grid over the tile (`VOLUME_SIZE`² ×
 * `VOLUME_LAYERS`, `VOXEL` µm), steel below its original surface and rust grown over and into it. Each voxel records
 * when it formed and when it went, so the whole exposure lives in one volume: at any time the specimen is the voxels
 * there by then (the renderer's isosurface moves with the playhead, scrubbing included).
 *
 * Per tick (the timeline cut into `MAX_TICK + 1`), from the bake's chemistry:
 * - The steel recedes where iron dissolved: each column dissolves the steel voxels its iron loss says, those exposed
 *   to the electrolyte (rust is porous), corners and edges first, so pits round out and undercut.
 * - The rust grows: each column wants its fresh rust per phase (as solid volume) placed, shared over its 3×3
 *   neighbourhood by where it attaches best, then drawn among the empty voxels touching solid by weight: where in the
 *   electrolyte the phase forms (Fe(OH)₂, green rust and magnetite at the metal; the oxyhydroxides at the surface of
 *   the electrolyte, which shells drops), exposed tips over pockets (porous, branching rust), rust over bare steel (it
 *   attaches to particles already there; bare steel nucleates rust only now and then, what it owes drifting to rust
 *   nearby: islands, not a dusting), fading under the ceiling, and the habit of a crystal next to it: needles of
 *   goethite and spindles of akaganeite grow along their axes from their nucleus, lepidocrocite as rosettes of plates,
 *   green rust as a hexagonal plate, magnetite as an octahedron. A crystal's frame follows the surface it nucleates on
 *   (its axis along the normal, tilted), or a neighbouring crystal of its phase (rotated a little: sheaves, stacks).
 *   Columns standing over their neighbours spill what they owe (mounds, not pillars).
 *
 * Deterministic: hashes, voxels read as they were at the tick's start (each column writes only its own), column
 * tops double-buffered, bricks by atomic min.
 */
export class RustVolume {

  readonly bake: RustBake
  readonly texture: Storage3DTexture
  /** Per column, two vec4: the crystal nucleated there (nucleus x, height, z, phase + 1; w = 0: none), its frame (axis, spin). */
  readonly clusters: StorageBufferAttribute
  /** Per brick, the earliest tick a voxel in it was born (0 for the steel; 0xffffffff: none yet). */
  readonly bricks: StorageBufferAttribute
  readonly brickCount: number
  /** Voxel counts by kind, for checks: steel (1), the matrix of each phase (2–7), crystals (8), gone (9). */
  readonly counts: StorageBufferAttribute
  /** The tick the volume has grown to. */
  tick = 0

  /** Per column: its highest rust (layer + 1, 0 none) by tick parity, and its steel's top (layer + 1). */
  private readonly columns: StorageBufferAttribute
  /** Steel voxels each column has dissolved. */
  private readonly etched: StorageBufferAttribute
  /** What each column owes the volume (inner, outer voxels), in two halves by tick parity. */
  private readonly pending: StorageBufferAttribute
  /** Per column, this tick: what it wants placed, its candidates' weights, their sum over its neighbourhood. */
  private readonly shares: StorageBufferAttribute
  /** Per column: how strongly it draws drifting rust, and the sum of that over its neighbours. */
  private readonly attraction: StorageBufferAttribute
  private readonly spread: StorageBufferAttribute
  private readonly uniforms = {tickFrom: uniform(0, 'uint'), tickTo: uniform(0, 'uint'), seed: uniform(0, 'uint')}
  private readonly resetNodes: ComputeNode[]
  private readonly growNodes: [ComputeNode[], ComputeNode[]]
  private readonly countNodes: ComputeNode[]
  private parity: 0 | 1 = 0

  constructor(bake: RustBake) {
    this.bake = bake
    const n = VOLUME_SIZE
    const texture = new Storage3DTexture(n, n, VOLUME_LAYERS)
    texture.format = RedIntegerFormat
    texture.type = UnsignedIntType
    texture.magFilter = texture.minFilter = NearestFilter
    texture.generateMipmaps = false
    this.texture = texture
    this.clusters = new StorageBufferAttribute(new Float32Array(n * n * 2 * 4), 4)
    this.brickCount = (n / BRICK) * (n / BRICK) * (VOLUME_LAYERS / BRICK)
    this.bricks = new StorageBufferAttribute(new Uint32Array(this.brickCount), 1)
    this.counts = new StorageBufferAttribute(new Uint32Array(10), 1)
    this.columns = new StorageBufferAttribute(new Uint32Array(n * n * 3), 1)
    this.etched = new StorageBufferAttribute(new Float32Array(n * n), 1)
    this.pending = new StorageBufferAttribute(new Float32Array(n * n * 2 * 2), 2)
    this.shares = new StorageBufferAttribute(new Float32Array(n * n * 3 * 2), 2)
    this.attraction = new StorageBufferAttribute(new Float32Array(n * n * 2), 2)
    const m = bake.grid.resolution
    this.spread = new StorageBufferAttribute(new Float32Array(m * m * 2 * 4), 4)
    this.resetNodes = this.buildReset()
    this.growNodes = [this.buildGrowList(0), this.buildGrowList(1)]
    this.countNodes = this.buildCount()
  }

  /** Back to bare steel at tick 0. */
  reset(renderer: WebGPURenderer, seed: number) {
    this.uniforms.seed.value = seed
    this.tick = 0
    this.parity = 0
    void renderer.compute(this.resetNodes)
  }

  /** Grows (and etches) what the bake made since the last call into the ticks after `this.tick` up to `tick`. */
  grow(renderer: WebGPURenderer, tick: number) {
    const to = Math.min(Math.floor(tick), MAX_TICK)
    if (to <= this.tick) return
    this.uniforms.tickFrom.value = this.tick
    this.uniforms.tickTo.value = to
    void renderer.compute(this.growNodes[this.parity])
    this.parity = this.parity === 0 ? 1 : 0
    this.tick = to
  }

  /** Voxel counts by kind, the column tops and crystals, read back: headless checks. */
  async readCounts(renderer: WebGPURenderer) {
    await renderer.compute(this.countNodes)
    const n2 = VOLUME_SIZE * VOLUME_SIZE
    const counts = new Uint32Array(await renderer.getArrayBufferAsync(this.counts))
    const columns = new Uint32Array(await renderer.getArrayBufferAsync(this.columns))
    const clusters = new Float32Array(await renderer.getArrayBufferAsync(this.clusters))
    return {counts, tops: columns.subarray(this.parity * n2, (this.parity + 1) * n2), steelTops: columns.subarray(2 * n2), clusters}
  }

  /** The voxels of a block (`size`² columns from `x0`, `y0`; all layers), read back: headless checks. */
  async readBlock(renderer: WebGPURenderer, x0: number, y0: number, size: number) {
    const L = VOLUME_LAYERS
    const out = new StorageBufferAttribute(new Uint32Array(size * size * L), 1)
    const volume = storageTexture3D(this.texture).toReadOnly()
    const target = storage(out, 'uint', size * size * L)
    const node = Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(size)
      const y = i.div(size).mod(size)
      const z = i.div(size * size)
      target.element(i).assign(this.load(volume, x.add(x0), y.add(y0), z))
    })().compute(size * size * L) as ComputeNode
    await renderer.compute(node)
    const data = new Uint32Array(await renderer.getArrayBufferAsync(out))
    node.dispose()
    return data
  }

  dispose() {
    this.texture.dispose()
    for (const node of [...this.resetNodes, ...this.growNodes[0], ...this.growNodes[1], ...this.countNodes]) node.dispose()
  }

  /** Texel of voxel (`x`, `y`, `z`), the column wrapped onto the tile. */
  private texel(x: Node<'int'>, y: Node<'int'>, z: Node<'int'>) {
    const n = VOLUME_SIZE
    return uvec3(uint(x.add(n).mod(n)), uint(y.add(n).mod(n)), uint(z))
  }

  /** The voxel at (`x`, `y`, `z`) (r32uint: TSL types its load as a float vector). */
  private load(volume: Volume, x: Node<'int'>, y: Node<'int'>, z: Node<'int'>) {
    return volume.load(this.texel(x, y, z)).x as unknown as Node<'uint'>
  }

  /** Index of column (`x` + `dx`, `y` + `dy`), wrapped. */
  private columnAt(x: Node<'int'>, y: Node<'int'>, dx: number, dy: number) {
    const n = VOLUME_SIZE
    return y.add(dy + n).mod(n).mul(n).add(x.add(dx + n).mod(n))
  }

  private buildReset(): ComputeNode[] {
    const n = VOLUME_SIZE
    const volume = storageTexture3D(this.texture).toWriteOnly()
    const columns = storage(this.columns, 'uint', n * n * 3)
    const etched = storage(this.etched, 'float', n * n)
    const pending = storage(this.pending, 'vec2', n * n * 2)
    const clusters = storage(this.clusters, 'vec4', n * n * 2)
    const bricks = storage(this.bricks, 'uint', this.brickCount)
    const counts = storage(this.counts, 'uint', 10)
    const columnNode = Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(n)
      const y = i.div(n)
      Loop({start: 0, end: VOLUME_LAYERS, type: 'int', condition: '<'}, ({i: z}) => {
        volume.store(this.texel(x, y, z), uvec4(select(z.lessThan(STEEL_LAYERS), uint(STEEL), uint(0)), 0, 0, 0))
      })
      columns.element(i).assign(uint(0))
      columns.element(i.add(n * n)).assign(uint(0))
      columns.element(i.add(n * n * 2)).assign(uint(STEEL_LAYERS))
      etched.element(i).assign(float(0))
      pending.element(i).assign(vec2(0))
      pending.element(i.add(n * n)).assign(vec2(0))
      clusters.element(i.mul(2)).assign(vec4(0))
      clusters.element(i.mul(2).add(1)).assign(vec4(0))
    })().compute(n * n) as ComputeNode
    const brickNode = Fn(() => {
      const b = int(instanceIndex)
      const layer = b.div((n / BRICK) * (n / BRICK)).mul(BRICK)
      bricks.element(b).assign(select(layer.lessThan(STEEL_LAYERS), uint(0), uint(0xffffffff)))
      If(b.lessThan(10), () => {
        counts.element(b).assign(uint(0))
      })
    })().compute(this.brickCount) as ComputeNode
    return [columnNode, brickNode]
  }

  private buildGrowList(parity: 0 | 1): ComputeNode[] {
    return [
      this.buildSpread(), this.buildClear(), this.buildEtch(), this.buildWants(parity), this.buildWeigh(parity),
      this.buildWeightSums(), this.buildPlace(parity), this.buildAttraction(parity), this.buildDrift(parity),
    ]
  }

  /**
   * The bake's deposits since the last tick, smoothed over 3×3 cells (binomial, periodic: precipitate drifts a
   * micrometre or two before it attaches), with each cell's film thickness and iron lost: `spread` = (GR, FH, LP, GT),
   * (AK, MG, h, loss) per cell.
   */
  private buildSpread() {
    const bake = this.bake
    const m = bake.grid.resolution
    const depositA = storage(bake.depositA, 'vec4', m * m)
    const depositB = storage(bake.depositB, 'vec4', m * m)
    const electro = storage(bake.electro, 'vec4', m * m)
    const solidB = storage(bake.solidB, 'vec4', m * m)
    const spread = storage(this.spread, 'vec4', m * m * 2)
    return Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(m)
      const y = i.div(m)
      const a = vec4(0).toVar()
      const b = vec4(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = (2 - Math.abs(dx)) * (2 - Math.abs(dy)) / 16
          const j = y.add(dy + m).mod(m).mul(m).add(x.add(dx + m).mod(m))
          a.addAssign(depositA.element(j).mul(w))
          b.addAssign(depositB.element(j).mul(w))
        }
      }
      spread.element(i.mul(2)).assign(a)
      spread.element(i.mul(2).add(1)).assign(vec4(b.xy, electro.element(i).x, solidB.element(i).w))
    })().compute(m * m) as ComputeNode
  }

  /** Empties the bake's deposits once `buildSpread` has taken them. */
  private buildClear() {
    const bake = this.bake
    const m = bake.grid.resolution
    const depositA = storage(bake.depositA, 'vec4', m * m)
    const depositB = storage(bake.depositB, 'vec4', m * m)
    return Fn(() => {
      depositA.element(instanceIndex).assign(vec4(0))
      depositB.element(instanceIndex).assign(vec4(0))
    })().compute(m * m) as ComputeNode
  }

  /** The bake's state at column (`cx`, `cy`): fresh rust per phase (iron, Fe-µm), its film, its iron lost. */
  private columnInputs(cx: Node<'int'>, cy: Node<'int'>, spread: StorageBufferNode<'vec4'>) {
    const n = VOLUME_SIZE
    const m = this.bake.grid.resolution
    const fx = float(cx).add(0.5).mul(m / n).sub(0.5)
    const fy = float(cy).add(0.5).mul(m / n).sub(0.5)
    const x0 = int(floor(fx))
    const y0 = int(floor(fy))
    const tx = fx.sub(floor(fx))
    const ty = fy.sub(floor(fy))
    const cell = (dx: number, dy: number) => y0.add(dy + m).mod(m).mul(m).add(x0.add(dx + m).mod(m))
    const sample = (k: number) => {
      const at = (dx: number, dy: number) => spread.element(cell(dx, dy).mul(2).add(k))
      return at(0, 0).mul(float(1).sub(tx)).add(at(1, 0).mul(tx)).mul(float(1).sub(ty))
        .add(at(0, 1).mul(float(1).sub(tx)).add(at(1, 1).mul(tx)).mul(ty))
    }
    const a = sample(0).toVar()
    const b = sample(1).toVar()
    const iron = [a.x, a.y, a.z, a.w, b.x, b.y]
    const solid = iron.map((fe, k) => fe.mul(VR[k]).div(VOXEL))
    return {
      iron, film: b.z.toVar(), loss: b.w.toVar(),
      freshIn: solid[0].add(solid[1]).add(solid[5]).toVar(), freshOut: solid[2].add(solid[3]).add(solid[4]).toVar(),
      ironTotal: iron.reduce((sum, fe) => sum.add(fe), float(0) as Node<'float'>).toVar(),
    }
  }

  /**
   * The steel recedes: each column dissolves the steel voxels its iron loss calls for (dithered), among those exposed
   * to electrolyte or rust, weighted by exposed faces (corners and edges first: pits round out, undercut).
   */
  private buildEtch() {
    const n = VOLUME_SIZE
    const m = this.bake.grid.resolution
    const volume = storageTexture3D(this.texture).toReadWrite()
    const columns = storage(this.columns, 'uint', n * n * 3)
    const etched = storage(this.etched, 'float', n * n)
    const spread = storage(this.spread, 'vec4', m * m * 2)
    const u = this.uniforms
    return Fn(() => {
      const i = int(instanceIndex)
      const cx = i.mod(n)
      const cy = i.div(n)
      const {loss} = this.columnInputs(cx, cy, spread)
      const done = etched.element(i).toVar()
      const column = uint(i).mul(2654435761).bitXor(u.seed.mul(3266489917)).toVar()
      // a voxel goes once 0.3–0.7 of it has dissolved: passive steel (nanometres) never pits, active steel recedes unevenly
      const count = min(floor(loss.div(VOXEL).sub(done).max(0).add(hash(column.add(41)).mul(0.4).add(0.3))), MAX_ETCH).toVar()
      If(count.greaterThan(0.5), () => {
        const top = int(columns.element(i.add(n * n * 2))).toVar()
        const zLo = maxInt(top.sub(SCAN_DEPTH), int(0))
        const zHi = minInt(top.add(2), int(STEEL_LAYERS - 1))
        const seed = uint(i).mul(1597334677).bitXor(u.tickTo.mul(2246822519)).bitXor(u.seed.mul(3812015801)).toVar()
        const isSteel = (v: Node<'uint'>) => voxelKind(v).equal(STEEL).and(voxelAlive(v, u.tickFrom))
        const total = float(0).toVar()
        const removed = float(0).toVar()
        const newTop = int(0).toVar()
        const scan = (pass: 0 | 1) => {
          Loop({start: zLo, end: zHi.add(1), type: 'int', condition: '<'}, ({i: z}) => {
            const v = this.load(volume, cx, cy, z)
            If(isSteel(v), () => {
              const faces = [
                this.load(volume, cx.add(1), cy, z), this.load(volume, cx.sub(1), cy, z), this.load(volume, cx, cy.add(1), z),
                this.load(volume, cx, cy.sub(1), z), this.load(volume, cx, cy, minInt(z.add(1), int(VOLUME_LAYERS - 1))),
              ]
              // open faces (the layer below is steel or the volume's floor)
              const open = faces.reduce((sum, f) => sum.add(select(isSteel(f), float(0), float(1))), float(0) as Node<'float'>)
                .add(select(z.greaterThan(0).and(isSteel(this.load(volume, cx, cy, maxInt(z.sub(1), int(0)))).not()), float(1), float(0)))
              const w = open.pow(ETCH_EXPOSURE).mul(hash(seed.add(uint(z).mul(131).add(3))).add(0.5)).toVar()
              if (pass === 0) {
                total.addAssign(w)
              } else {
                const go = hash(seed.add(uint(z).mul(131).add(4))).lessThan(count.mul(w).div(max(total, 1e-12)))
                If(go.and(w.greaterThan(0)), () => {
                  const span = u.tickTo.sub(u.tickFrom)
                  const death = u.tickFrom.add(1).add(minUint(uint(hash(seed.add(uint(z).mul(131).add(5))).mul(float(span))), span.sub(1)))
                  volume.store(this.texel(cx, cy, z), uvec4(v.bitOr(death.add(1).shiftLeft(DEATH_SHIFT)), 0, 0, 0))
                  removed.addAssign(1)
                }).Else(() => {
                  newTop.assign(maxInt(newTop, z.add(1)))
                })
              }
            })
          })
        }
        scan(0)
        scan(1)
        etched.element(i).assign(done.add(removed))
        // all of the scanned steel gone: it goes on below the scan
        columns.element(i.add(n * n * 2)).assign(uint(select(newTop.equal(0), zLo, newTop)))
      })
    })().compute(n * n) as ComputeNode
  }

  /** The highest rust (layer + 1) of a column's 3×3 neighbourhood. */
  private highestAround(columns: StorageBufferNode<'uint'>, cx: Node<'int'>, cy: Node<'int'>, offset: number) {
    const highest = uint(0).toVar()
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) highest.assign(maxUint(highest, columns.element(this.columnAt(cx, cy, dx, dy).add(offset))))
    }
    return highest
  }

  /** The frame of crystal `seed` with main `axis` and `spin` about it: (tangent, axis, bitangent). */
  private static frame(axis: Node<'vec3'>, spin: Node<'float'>) {
    const helper = select(abs(axis.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0))
    const tangent = helper.cross(axis).normalize().toVar()
    const side = axis.cross(tangent)
    const t = tangent.mul(cos(spin)).add(side.mul(sin(spin))).toVar()
    return {t, axis, b: axis.cross(t)}
  }

  /** How well a crystal of `phase` (nucleus, frame) would take a voxel at `p`: 0–1 by its habit (see the class). */
  private habit(phase: Node<'int'>, nucleus: Node<'vec3'>, axis: Node<'vec3'>, spin: Node<'float'>, p: Node<'vec3'>) {
    const d = p.sub(nucleus).toVar()
    // through the nearest periodic image
    d.assign(vec3(d.x.sub(floor(d.x.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE)), d.y, d.z.sub(floor(d.z.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE))))
    const r = max(d.length(), 1e-4).toVar()
    const {t, b} = RustVolume.frame(axis, spin)
    const q = vec3(d.dot(t), d.dot(axis), d.dot(b)).div(r).toVar()
    const reach = select(phase.equal(0), float(CRYSTAL_REACH[0]), select(phase.equal(2), float(CRYSTAL_REACH[2]),
      select(phase.equal(3), float(CRYSTAL_REACH[3]), select(phase.equal(4), float(CRYSTAL_REACH[4]), float(CRYSTAL_REACH[5])))))
    const within = smoothstep(reach, reach.mul(0.75), r)
    const a = q.abs().toVar()
    // needles (goethite: many, thin, the frame's axes and diagonals, a sheaf about the main axis) and spindles
    // (akaganeite: few, thicker), outward from the nucleus; how far off the nearest one the voxel is
    const onAxis = max(max(a.x, a.y), a.z)
    const onDiagonal = a.x.add(a.y).add(a.z).div(Math.sqrt(3))
    const outward = smoothstep(-0.3, 0.2, q.y)
    const needleCos = select(phase.equal(3), max(onAxis, onDiagonal), onAxis)
    const off = r.mul(sqrt(max(float(1).sub(needleCos.mul(needleCos)), 0)))
    const needle = exp(off.div(select(phase.equal(3), float(0.45), float(0.8))).pow(2).negate()).mul(outward)
    // plates (lepidocrocite: three through the nucleus, a rosette; green rust: one across the axis, hexagonal)
    const plateDistance = select(phase.equal(0), r.mul(a.y), r.mul(min(min(a.x, a.y), a.z)))
    const hexagon = max(max(abs(q.x), abs(q.x.mul(0.5).add(q.z.mul(0.866)))), abs(q.x.mul(0.5).sub(q.z.mul(0.866)))).mul(r)
    const plate = exp(plateDistance.div(0.4).pow(2).negate())
      .mul(select(phase.equal(0), smoothstep(reach, reach.mul(0.8), hexagon.div(0.866)), float(1)))
    // octahedra (magnetite): fastest along the frame's axes, the faces between them
    const octahedron = exp(a.x.add(a.y).add(a.z).sub(1).mul(-2.5))
    const shape = select(phase.equal(3).or(phase.equal(4)), needle, select(phase.equal(5), octahedron, plate))
    return shape.mul(within)
  }

  /** The crystal a voxel kind belongs to: the index of its nucleus's column (or -1). */
  private crystalOf(kind: Node<'uint'>, cx: Node<'int'>, cy: Node<'int'>) {
    const n = VOLUME_SIZE
    const dx = int(kind.bitAnd(31)).sub(16)
    const dy = int(kind.shiftRight(5).bitAnd(31)).sub(16)
    return select(kind.bitAnd(CRYSTAL).greaterThan(0), cy.add(dy).add(n).mod(n).mul(n).add(cx.add(dx).add(n).mod(n)), int(-1))
  }

  /**
   * Walks column (`cx`, `cy`) up from `zLo` to `zHi`, calling `visit` with each candidate voxel (not there at the
   * tick's start, touching solid) and its weights for inner and outer growth, the crystal next to it, the local normal.
   */
  private scanColumn(volume: Volume, clusters: StorageBufferNode<'vec4'>, cx: Node<'int'>, cy: Node<'int'>,
    inputs: ReturnType<RustVolume['columnInputs']>, steelTop: Node<'int'>, zLo: Node<'int'>, zHi: Node<'int'>,
    surface: {highest: Node<'float'>; mean: Node<'float'>}, seed: Node<'uint'>,
    visit: (c: Candidate) => void) {
    const L = VOLUME_LAYERS
    const u = this.uniforms
    const centre = vec2(float(cx).add(0.5).mul(VOXEL).sub(TILE_SIZE / 2), float(cy).add(0.5).mul(VOXEL).sub(TILE_SIZE / 2))
    const {iron, ironTotal, film} = inputs
    const steelHeight = float(steelTop).mul(VOXEL).add(VOLUME_BOTTOM)
    // the electrolyte's surface: the drop's, or the film over the rust around (it wets a spike's flanks too)
    const liquid = max(steelHeight.add(film), surface.highest.add(min(film, 1)))
    const settle = surface.mean.add(SLOPE_ALLOWANCE)
    const alive = (v: Node<'uint'>) => voxelAlive(v, u.tickFrom)
    Loop({start: zLo, end: zHi.add(1), type: 'int', condition: '<'}, ({i: z}) => {
      const v = this.load(volume, cx, cy, z)
      If(alive(v).not(), () => {
        // below, the four sides, above: (offset, voxel)
        const near: [[number, number, number], Node<'uint'>][] = [
          [[0, -1, 0], this.load(volume, cx, cy, maxInt(z.sub(1), int(0)))],
          [[1, 0, 0], this.load(volume, cx.add(1), cy, z)], [[-1, 0, 0], this.load(volume, cx.sub(1), cy, z)],
          [[0, 0, 1], this.load(volume, cx, cy.add(1), z)], [[0, 0, -1], this.load(volume, cx, cy.sub(1), z)],
          [[0, 1, 0], this.load(volume, cx, cy, minInt(z.add(1), int(L - 1)))],
        ]
        // the volume's floor is steel; nothing is over its ceiling
        const solid = near.map(([, w], k) => k === 0 ? alive(w).or(z.equal(0)) : k === 5 ? alive(w).and(z.lessThan(L - 1)) : alive(w))
        const rusty = near.map(([, w], k) => solid[k].and(voxelKind(w).notEqual(STEEL)))
        const solids = solid.reduce((sum, s) => sum.add(select(s, int(1), int(0))), int(0) as Node<'int'>).toVar()
        If(solids.greaterThan(0), () => {
          const rusts = rusty.reduce((sum, s) => sum.add(select(s, int(1), int(0))), int(0) as Node<'int'>)
          const height = float(z).add(0.5).mul(VOXEL).add(VOLUME_BOTTOM).toVar()
          const p = vec3(centre.x, height, centre.y)
          // the local normal: away from the solid around it
          const normal = vec3(0).toVar()
          near.forEach(([[dx, dy, dz]], k) => {
            normal.subAssign(select(solid[k], vec3(dx, dy, dz), vec3(0)))
          })
          normal.assign(select(normal.length().lessThan(0.1), vec3(0, 1, 0), normal.normalize()))
          // the crystal next to it, if any (below first, then the sides, then above)
          const crystal = int(-1).toVar()
          near.forEach(([, w], k) => {
            const owner = this.crystalOf(voxelKind(w), cx.add(k === 1 ? 1 : k === 2 ? -1 : 0), cy.add(k === 3 ? 1 : k === 4 ? -1 : 0))
            If(crystal.lessThan(0).and(solid[k]).and(owner.greaterThanEqual(0)), () => {
              crystal.assign(owner)
            })
          })
          const habitWeight = float(0).toVar()
          const crystalPhase = int(-1).toVar()
          If(crystal.greaterThanEqual(0), () => {
            const c = clusters.element(crystal.mul(2)).toVar()
            const f = clusters.element(crystal.mul(2).add(1)).toVar()
            crystalPhase.assign(int(c.w).sub(1))
            habitWeight.assign(this.habit(crystalPhase, c.xyz, f.xyz, f.w, p))
          })
          // whether the crystal's phase forms here now
          const crystalShare = float(0).toVar()
          iron.forEach((fe, k) => {
            If(crystalPhase.equal(k), () => {
              crystalShare.assign(fe.div(max(ironTotal, 1e-12)))
            })
          })
          const crystalInner = crystalPhase.equal(0).or(crystalPhase.equal(1)).or(crystalPhase.equal(5)).toVar()
          const boost = habitWeight.mul(12).mul(smoothstep(0, 0.05, crystalShare)).toVar()
          // pockets before tips (rounded globules); the oxyhydroxides barely onto bare steel; fading under the ceiling
          const held = float(solids)
          const bare = select(rusts.equal(0), float(BARE_DRAW), float(1))
          const ceiling = smoothstep(float(L - 1), float(L - 1 - CEILING), float(z))
          const slope = exp(height.sub(settle).max(0).div(-SLOPE_SCALE))
          const noise = hash(seed.add(uint(z).mul(97).add(5))).sub(0.5).mul(NOISE).add(1).mul(ceiling).mul(slope).toVar()
          const wIn = held.pow(SMOOTHING[0]).mul(exp(height.sub(steelHeight).max(0).div(-INNER_DEPTH))).mul(noise)
            .mul(select(crystalInner, boost.add(1), float(1))).toVar()
          const outer = exp(height.sub(liquid).max(0).div(-OUTER_ABOVE))
          const wOut = held.pow(SMOOTHING[1]).mul(outer).mul(noise).mul(bare)
            .mul(select(crystalInner.not().and(crystalPhase.greaterThanEqual(0)), boost.add(1), float(1))).toVar()
          visit({z, p, v, wIn, wOut, crystal, crystalPhase, crystalInner, boost, normal})
        })
      })
    })
  }

  /** The highest and the mean height (µm) of the surfaces (rust, or steel where bare) of a column's 3×3 neighbourhood. */
  private surroundings(columns: StorageBufferNode<'uint'>, cx: Node<'int'>, cy: Node<'int'>, offset: number) {
    const n = VOLUME_SIZE
    const highest = uint(0).toVar()
    const sum = float(0).toVar()
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = this.columnAt(cx, cy, dx, dy)
        const top = maxUint(columns.element(j.add(offset)), columns.element(j.add(n * n * 2)))
        highest.assign(maxUint(highest, top))
        sum.addAssign(float(top))
      }
    }
    return {highest: float(highest).mul(VOXEL).add(VOLUME_BOTTOM), mean: sum.div(9).mul(VOXEL).add(VOLUME_BOTTOM)}
  }

  /** What each column wants placed this tick (inner, outer voxels): what it owes and the fresh rust at it. */
  private buildWants(parity: 0 | 1) {
    const n = VOLUME_SIZE
    const m = this.bake.grid.resolution
    const pending = storage(this.pending, 'vec2', n * n * 2)
    const shares = storage(this.shares, 'vec2', n * n * 3)
    const spread = storage(this.spread, 'vec4', m * m * 2)
    const from = parity * n * n
    return Fn(() => {
      const i = int(instanceIndex)
      const inputs = this.columnInputs(i.mod(n), i.div(n), spread)
      shares.element(i).assign(pending.element(i.add(from)).add(vec2(inputs.freshIn, inputs.freshOut)))
    })().compute(n * n) as ComputeNode
  }

  /** The scan range of a column: from a little under its steel's top to a layer over the highest rust around. */
  private scanRange(columns: StorageBufferNode<'uint'>, cx: Node<'int'>, cy: Node<'int'>, i: Node<'int'>, offset: number) {
    const n = VOLUME_SIZE
    const steelTop = int(columns.element(i.add(n * n * 2))).toVar()
    const highest = this.highestAround(columns, cx, cy, offset).toVar()
    const zLo = maxInt(steelTop.sub(SCAN_DEPTH), int(0)).toVar()
    const zHi = minInt(maxInt(int(highest), steelTop), int(VOLUME_LAYERS - 1)).toVar()
    return {steelTop, highest, zLo, zHi}
  }

  /** Each column's candidate weights summed (inner, outer), where rust may be placed around it this tick. */
  private buildWeigh(parity: 0 | 1) {
    const n = VOLUME_SIZE
    const m = this.bake.grid.resolution
    const volume = storageTexture3D(this.texture).toReadOnly()
    const columns = storage(this.columns, 'uint', n * n * 3)
    const shares = storage(this.shares, 'vec2', n * n * 3)
    const clusters = storage(this.clusters, 'vec4', n * n * 2)
    const spread = storage(this.spread, 'vec4', m * m * 2)
    const u = this.uniforms
    const offset = parity * n * n
    return Fn(() => {
      const i = int(instanceIndex)
      const cx = i.mod(n)
      const cy = i.div(n)
      const around = float(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = shares.element(this.columnAt(cx, cy, dx, dy))
          around.addAssign(w.x.max(0).add(w.y.max(0)))
        }
      }
      const total = vec2(0).toVar()
      If(around.greaterThan(1e-6), () => {
        const inputs = this.columnInputs(cx, cy, spread)
        const {steelTop, zLo, zHi} = this.scanRange(columns, cx, cy, i, offset)
        const seed = uint(i).mul(2654435761).bitXor(u.tickTo.mul(2246822519)).bitXor(u.seed.mul(3266489917)).toVar()
        this.scanColumn(volume, clusters, cx, cy, inputs, steelTop, zLo, zHi, this.surroundings(columns, cx, cy, offset), seed, ({wIn, wOut}) => {
          total.addAssign(vec2(wIn, wOut))
        })
      })
      shares.element(i.add(n * n)).assign(total)
    })().compute(n * n) as ComputeNode
  }

  /** Each column's neighbourhood (3×3) total of the candidate weights, to share its rust by. */
  private buildWeightSums() {
    const n = VOLUME_SIZE
    const shares = storage(this.shares, 'vec2', n * n * 3)
    return Fn(() => {
      const i = int(instanceIndex)
      const cx = i.mod(n)
      const cy = i.div(n)
      const total = vec2(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) total.addAssign(shares.element(this.columnAt(cx, cy, dx, dy).add(n * n)))
      }
      shares.element(i.add(n * n * 2)).assign(total)
    })().compute(n * n) as ComputeNode
  }

  /**
   * Places the rust: each column gets its share of its neighbourhood's wants (its candidate weights over theirs: rust
   * lands where it attaches best, on the sides of a spike as on its tip), places a dithered whole number of voxels
   * among its candidates by weight, nucleates crystals, and owes the rest.
   */
  private buildPlace(parity: 0 | 1) {
    const n = VOLUME_SIZE
    const m = this.bake.grid.resolution
    const volume = storageTexture3D(this.texture).toReadWrite()
    const columns = storage(this.columns, 'uint', n * n * 3)
    const pending = storage(this.pending, 'vec2', n * n * 2)
    const shares = storage(this.shares, 'vec2', n * n * 3)
    const clusters = storage(this.clusters, 'vec4', n * n * 2)
    const bricks = storage(this.bricks, 'uint', this.brickCount).toAtomic()
    const spread = storage(this.spread, 'vec4', m * m * 2)
    const u = this.uniforms
    const from = parity * n * n
    const to = (1 - parity) * n * n
    const nb = n / BRICK

    return Fn(() => {
      const i = int(instanceIndex)
      const cx = i.mod(n)
      const cy = i.div(n)
      const own = shares.element(i.add(n * n)).toVar()
      // this column's share of each neighbour's want; a want with nowhere to go around it stays put
      const share = vec2(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = this.columnAt(cx, cy, dx, dy)
          const total = shares.element(j.add(n * n * 2))
          const want = shares.element(j)
          share.addAssign(vec2(
            select(total.x.greaterThan(1e-12), want.x.max(0).mul(own.x).div(total.x), float(0)),
            select(total.y.greaterThan(1e-12), want.y.max(0).mul(own.y).div(total.y), float(0)),
          ))
        }
      }
      const mine = shares.element(i).toVar()
      const ownTotal = shares.element(i.add(n * n * 2))
      share.addAssign(vec2(
        select(ownTotal.x.greaterThan(1e-12), min(mine.x, 0), mine.x),
        select(ownTotal.y.greaterThan(1e-12), min(mine.y, 0), mine.y),
      ))

      const inputs = this.columnInputs(cx, cy, spread)
      const {iron} = inputs
      const {steelTop, highest, zLo, zHi} = this.scanRange(columns, cx, cy, i, from)
      // whole voxels to place now (dithered); with no rust around, only if rust nucleates on the steel
      const column = uint(i).mul(2654435761).bitXor(u.seed.mul(3266489917)).toVar()
      const countIn = floor(share.x.max(0).add(hash(column.add(21)))).toVar()
      const countOut = floor(share.y.max(0).add(hash(column.add(22)))).toVar()
      const tickSeed = uint(i).mul(2246822519).bitXor(u.tickTo.mul(3266489917)).bitXor(u.seed.mul(668265263)).toVar()
      const seeds = hash(tickSeed.add(31)).lessThan(float(1).sub(exp(inputs.freshIn.add(inputs.freshOut).mul(-SEED))))
      If(highest.equal(0).and(seeds.not()), () => {
        countIn.assign(0)
        countOut.assign(0)
      })
      const newTop = columns.element(i.add(from)).toVar()
      const placed = vec2(0).toVar()

      If(countIn.add(countOut).greaterThan(0.5), () => {
        // a crystal nucleates here this tick (one per column, ever), of the phase picked by its fresh iron
        const seed = uint(i).mul(2654435761).bitXor(u.tickTo.mul(2246822519)).bitXor(u.seed.mul(3266489917)).toVar()
        const expected = iron.reduce((sum, fe, k) => sum.add(fe.mul(NUCLEATION[k] * VOXEL * VOXEL)), float(0) as Node<'float'>).toVar()
        const nucleusPhase = int(-1).toVar()
        If(clusters.element(i.mul(2)).w.lessThan(0.5).and(hash(seed.add(1)).lessThan(float(1).sub(exp(expected.negate())))), () => {
          const pick = hash(seed.add(2)).mul(expected).toVar()
          const acc = float(0).toVar()
          iron.forEach((fe, k) => {
            if (NUCLEATION[k] === 0) return
            acc.addAssign(fe.mul(NUCLEATION[k] * VOXEL * VOXEL))
            If(nucleusPhase.lessThan(0).and(pick.lessThan(acc)), () => {
              nucleusPhase.assign(k)
            })
          })
        })
        const nucleated = int(0).toVar()
        const surface = this.surroundings(columns, cx, cy, from)
        this.scanColumn(volume, clusters, cx, cy, inputs, steelTop, zLo, zHi, surface, seed,
          ({z, p, wIn, wOut, crystal, crystalPhase, crystalInner, boost, normal}) => {
            const pIn = countIn.mul(wIn).div(max(own.x, 1e-12))
            const pOut = countOut.mul(wOut).div(max(own.y, 1e-12))
            const roll = hash(seed.add(uint(z).mul(97).add(6))).toVar()
            If(roll.lessThan(pIn.add(pOut)), () => {
              const inner = roll.lessThan(pIn).toVar()
              // the phase: the crystal's, if it is of this class and forms here; else by the fresh iron
              const choice = hash(seed.add(uint(z).mul(97).add(7))).toVar()
              const weight = (k: number) => iron[k].add(1e-9)
              const sumIn = weight(0).add(weight(1)).add(weight(5))
              const sumOut = weight(2).add(weight(3)).add(weight(4))
              const pickIn = select(choice.mul(sumIn).lessThan(weight(0)), int(0),
                select(choice.mul(sumIn).lessThan(weight(0).add(weight(1))), int(1), int(5)))
              const pickOut = select(choice.mul(sumOut).lessThan(weight(2)), int(2),
                select(choice.mul(sumOut).lessThan(weight(2).add(weight(3))), int(3), int(4)))
              const phase = select(inner, pickIn, pickOut).toVar()
              const joins = crystal.greaterThanEqual(0).and(select(inner, crystalInner, crystalInner.not())).and(boost.greaterThan(1))
              // a crystal's voxels point back to its nucleus's column
              const dx = crystal.mod(n).sub(cx).add(n + n / 2).mod(n).sub(n / 2)
              const dy = crystal.div(n).sub(cy).add(n + n / 2).mod(n).sub(n / 2)
              const kind = select(joins.and(abs(dx).lessThan(16)).and(abs(dy).lessThan(16)),
                uint(CRYSTAL).bitOr(uint(dx.add(16))).bitOr(uint(dy.add(16)).shiftLeft(5)), uint(phase.add(MATRIX_BASE))).toVar()
              // the first voxel of a nucleating crystal's class becomes its nucleus; its frame follows the surface
              // it grows on, or the crystal of its phase it grows from, rotated a little
              If(nucleated.equal(0).and(nucleusPhase.greaterThanEqual(0)), () => {
                const nucleusInner = nucleusPhase.equal(0).or(nucleusPhase.equal(5))
                If(select(inner, nucleusInner, nucleusInner.not()), () => {
                  kind.assign(uint(CRYSTAL).bitOr(uint(16)).bitOr(uint(16).shiftLeft(5)))
                  const tiltAngle = hash(seed.add(51)).mul(0.6)
                  const around = hash(seed.add(52)).mul(Math.PI * 2)
                  const inherited = crystal.greaterThanEqual(0).and(crystalPhase.equal(nucleusPhase))
                  const base = select(inherited, clusters.element(maxInt(crystal, int(0)).mul(2).add(1)).xyz, normal).normalize().toVar()
                  const {t, b} = RustVolume.frame(base, around)
                  const tilt = select(inherited, tiltAngle.mul(0.4), tiltAngle)
                  const axis = base.mul(cos(tilt)).add(t.mul(sin(tilt).mul(cos(around)))).add(b.mul(sin(tilt).mul(sin(around)))).normalize()
                  clusters.element(i.mul(2)).assign(vec4(p, float(nucleusPhase.add(1))))
                  clusters.element(i.mul(2).add(1)).assign(vec4(axis, hash(seed.add(53)).mul(Math.PI * 2)))
                  nucleated.assign(1)
                })
              })
              // born within the tick range, spread over it (the growth streams in through a long step)
              const span = u.tickTo.sub(u.tickFrom)
              const birth = u.tickFrom.add(1).add(minUint(uint(hash(seed.add(uint(z).mul(97).add(8))).mul(float(span))), span.sub(1)))
              volume.store(this.texel(cx, cy, z), uvec4(birth.add(1).shiftLeft(BIRTH_SHIFT).bitOr(kind), 0, 0, 0))
              atomicMin(bricks.element(int(z).div(BRICK).mul(nb * nb).add(cy.div(BRICK).mul(nb)).add(cx.div(BRICK))), birth)
              placed.addAssign(select(inner, vec2(1, 0), vec2(0, 1)))
              newTop.assign(maxUint(newTop, uint(z.add(1))))
            })
          })
      })
      pending.element(i.add(from)).assign(min(max(share.sub(placed), vec2(-MAX_CREDIT)), vec2(MAX_PENDING)))
      columns.element(i.add(to)).assign(newTop)
    })().compute(n * n) as ComputeNode
  }

  /** How strongly each column draws drifting rust (rust draws, lower more; bare steel barely), and its neighbours' sum. */
  private buildAttraction(parity: 0 | 1) {
    const n = VOLUME_SIZE
    const columns = storage(this.columns, 'uint', n * n * 3)
    const attraction = storage(this.attraction, 'vec2', n * n)
    const to = (1 - parity) * n * n
    return Fn(() => {
      const i = int(instanceIndex)
      const cx = i.mod(n)
      const cy = i.div(n)
      const draw = (dx: number, dy: number) => {
        const j = this.columnAt(cx, cy, dx, dy)
        const rust = columns.element(j.add(to))
        const above = float(rust).sub(float(columns.element(j.add(n * n * 2))))
        return select(rust.greaterThan(0), exp(above.max(0).div(-ATTRACTION_HEIGHT / VOXEL)).mul(4).add(0.2), float(0.05))
      }
      let sum = float(0) as Node<'float'>
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) sum = sum.add(draw(dx, dy))
      attraction.element(i).assign(vec2(draw(0, 0), sum))
    })().compute(n * n) as ComputeNode
  }

  /**
   * Moves what columns owe toward where it attaches: each keeps what it does not let go and gathers its neighbours'
   * share by its attraction (conservative). A column with no rust around lets go of `DRIFT` (next to rust it grows
   * onto it instead); one standing more than `REPOSE` voxels over its lowest neighbour spills its excess. Credit stays.
   */
  private buildDrift(parity: 0 | 1) {
    const n = VOLUME_SIZE
    const columns = storage(this.columns, 'uint', n * n * 3)
    const pending = storage(this.pending, 'vec2', n * n * 2)
    const attraction = storage(this.attraction, 'vec2', n * n)
    const top = (1 - parity) * n * n
    const from = parity * n * n
    const to = (1 - parity) * n * n
    return Fn(() => {
      const i = int(instanceIndex)
      const surface = (j: Node<'int'>) => maxUint(columns.element(j.add(top)), columns.element(j.add(n * n * 2)))
      /** The share of what column `j` owes that it lets go this tick. */
      const release = (j: Node<'int'>) => {
        const jx = j.mod(n)
        const jy = j.div(n)
        const height = surface(j).toVar()
        const lowest = height.toVar()
        const rustAround = uint(0).toVar()
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = this.columnAt(jx, jy, dx, dy)
            rustAround.assign(maxUint(rustAround, columns.element(k.add(top))))
            if (dx || dy) lowest.assign(minUint(lowest, surface(k)))
          }
        }
        const excess = clamp(float(height).sub(float(lowest)).sub(REPOSE).div(4), 0, DRIFT)
        return select(rustAround.equal(0), float(DRIFT), excess)
      }
      const own = pending.element(i.add(from)).toVar()
      const kept = own.sub(max(own, vec2(0)).mul(release(i))).toVar()
      const draw = attraction.element(i).x
      const cx = i.mod(n)
      const cy = i.div(n)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const j = this.columnAt(cx, cy, dx, dy)
          kept.addAssign(max(pending.element(j.add(from)), vec2(0)).mul(release(j)).mul(draw.div(max(attraction.element(j).y, 1e-6))))
        }
      }
      pending.element(i.add(to)).assign(kept)
    })().compute(n * n) as ComputeNode
  }

  /** Counts the voxels by kind into `counts` (headless checks). */
  private buildCount(): ComputeNode[] {
    const n = VOLUME_SIZE
    const volume = storageTexture3D(this.texture).toReadOnly()
    const counts = storage(this.counts, 'uint', 10).toAtomic()
    const u = this.uniforms
    const clear = Fn(() => {
      atomicMin(counts.element(instanceIndex), uint(0))
    })().compute(10) as ComputeNode
    const count = Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(n)
      const y = i.div(n)
      const local = Array.from({length: 10}, () => uint(0).toVar())
      Loop({start: 0, end: VOLUME_LAYERS, type: 'int', condition: '<'}, ({i: z}) => {
        const v = this.load(volume, x, y, z)
        const kind = voxelKind(v)
        If(voxelAlive(v, u.tickTo), () => {
          If(kind.equal(STEEL), () => {
            local[1].addAssign(1)
          })
          for (let k = 0; k < 6; k++) {
            If(kind.equal(MATRIX_BASE + k), () => {
              local[2 + k].addAssign(1)
            })
          }
          If(kind.bitAnd(CRYSTAL).greaterThan(0), () => {
            local[8].addAssign(1)
          })
        }).ElseIf(kind.greaterThan(0), () => {
          local[9].addAssign(1)
        })
      })
      for (let k = 1; k < 10; k++) atomicAdd(counts.element(k), local[k])
    })().compute(n * n) as ComputeNode
    return [clear, count]
  }
}
