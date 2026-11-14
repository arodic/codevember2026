import { ComputeNode, StorageBufferAttribute } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { Fn, instanceIndex, int, max, storage, vec4 } from 'three/tsl'

/** One level of the multigrid pyramid: `size × size` cells, starting at `offset` in the shared buffers. */
export interface MultigridLevel {
  size: number
  offset: number
}

/** Per-component multipliers of the face coefficients (diffusivities, or 1 for the potential). */
export type Diffusivity = readonly [number, number, number, number]

/** Levels from `size` (a power of two) down to a single cell, halving each time. */
export function multigridLevels(size: number): MultigridLevel[] {
  const levels: MultigridLevel[] = []
  let offset = 0
  for (let n = size; n >= 1; n >>= 1) {
    levels.push({size: n, offset})
    offset += n * n
  }
  return levels
}

/**
 * Geometric multigrid on the GPU for the cell-centred finite-volume problem the bake solves for the potential and for
 * the species (each component on its own):
 *
 *   Σ_faces a_f D (u_i − u_j) + B_i u_i = F_i
 *
 * with `k = (a_east, a_north, B, ·)` per cell (`a` zero between cells that are not coupled: no flux), `D` a
 * per-component multiplier. The grid is periodic: the last column's east face and the last row's north face wrap to
 * the first, on every level (a coarse face still sums the two fine faces it spans). The coarse levels are Galerkin for piecewise-constant
 * interpolation: a coarse cell sums its four children's `B` and residuals, a coarse face sums the two fine faces it
 * spans, and the correction is injected unchanged. That is variational (restriction = transposed interpolation, coarse
 * operator = R A P), so a cycle never adds energy: wet/dry masks and conductances a thousandfold apart cannot make it
 * diverge (bilinear interpolation with averaged faces did, 3000× in a cycle on a masked drop). It converges more
 * slowly (~0.75 a cycle on near-singular patches), which warm starts from the last step make up for. Red-black
 * Gauss–Seidel smoothing in place, an exact solve of the last single cell. All levels share three vec4 buffers; the
 * kernels have their level baked in, so a cycle is one list for `renderer.compute` (one pass, one submit).
 */
export class Multigrid {

  readonly levels: MultigridLevel[]
  readonly cells: number
  readonly u: StorageBufferAttribute
  readonly f: StorageBufferAttribute
  readonly k: StorageBufferAttribute
  /** Restricts the coefficients from level 0 down: run after level 0's `k` changes. */
  readonly coefficientNodes: ComputeNode[]

  private readonly uNode
  private readonly fNode
  private readonly kNode
  private readonly smoothNodes = new Map<string, ComputeNode>()
  private readonly restrictNodes = new Map<string, ComputeNode>()
  private readonly cycles = new Map<string, ComputeNode[]>()
  private readonly prolongNodes: ComputeNode[]
  private readonly coarsestNode: ComputeNode

  constructor(size: number) {
    this.levels = multigridLevels(size)
    const last = this.levels[this.levels.length - 1]
    this.cells = last.offset + 1
    this.u = new StorageBufferAttribute(new Float32Array(this.cells * 4), 4)
    this.f = new StorageBufferAttribute(new Float32Array(this.cells * 4), 4)
    this.k = new StorageBufferAttribute(new Float32Array(this.cells * 4), 4)
    this.uNode = storage(this.u, 'vec4', this.cells)
    this.fNode = storage(this.f, 'vec4', this.cells)
    this.kNode = storage(this.k, 'vec4', this.cells)
    this.coefficientNodes = this.levels.slice(0, -1).map((_, l) => this.restrictCoefficients(l))
    this.prolongNodes = this.levels.slice(0, -1).map((_, l) => this.prolong(l))
    this.coarsestNode = Fn(() => {
      const i = int(last.offset)
      this.uNode.element(i).assign(this.fNode.element(i).div(max(this.kNode.element(i).z, 1e-30)))
    })().compute(1) as ComputeNode
  }

  /** The storage nodes, for the kernels that fill level 0 and read the solution. */
  get nodes() {
    return {u: this.uNode, f: this.fNode, k: this.kNode}
  }

  /** One V-cycle with `sweeps` red-black sweeps before restricting and after prolongating each level. Cached. */
  vCycle(d: Diffusivity, sweeps = 1): ComputeNode[] {
    const key = `${d.join(',')}|${sweeps}`
    const cached = this.cycles.get(key)
    if (cached) return cached
    const list: ComputeNode[] = []
    const levels = this.levels.length
    for (let l = 0; l < levels - 1; l++) {
      for (let s = 0; s < sweeps; s++) list.push(this.smooth(l, 0, d), this.smooth(l, 1, d))
      list.push(this.restrictResidual(l, d))
    }
    list.push(this.coarsestNode)
    for (let l = levels - 2; l >= 0; l--) {
      list.push(this.prolongNodes[l])
      for (let s = 0; s < sweeps; s++) list.push(this.smooth(l, 1, d), this.smooth(l, 0, d))
    }
    this.cycles.set(key, list)
    return list
  }

  /** Cell `(x, y)`'s neighbours on a level (wrapping around) and the coefficients of its west and south faces. */
  neighbours(x: Node<'int'>, y: Node<'int'>, level: MultigridLevel) {
    const n = level.size
    const row = y.mul(n).add(level.offset)
    const iE = row.add(x.add(1).mod(n))
    const iW = row.add(x.add(n - 1).mod(n))
    const iN = y.add(1).mod(n).mul(n).add(x).add(level.offset)
    const iS = y.add(n - 1).mod(n).mul(n).add(x).add(level.offset)
    return {iE, iW, iN, iS, aW: this.kNode.element(iW).x, aS: this.kNode.element(iS).y}
  }

  /** `A u` at cell `i` = (x, y) of a level. */
  apply(i: Node<'int'>, x: Node<'int'>, y: Node<'int'>, level: MultigridLevel, d: Diffusivity) {
    const k = this.kNode.element(i)
    const {iE, iW, iN, iS, aW, aS} = this.neighbours(x, y, level)
    const D = vec4(d[0], d[1], d[2], d[3])
    const ui = this.uNode.element(i)
    const flux = ui.sub(this.uNode.element(iE)).mul(k.x)
      .add(ui.sub(this.uNode.element(iW)).mul(aW))
      .add(ui.sub(this.uNode.element(iN)).mul(k.y))
      .add(ui.sub(this.uNode.element(iS)).mul(aS))
    return flux.mul(D).add(ui.mul(k.z))
  }

  private smooth(l: number, color: 0 | 1, d: Diffusivity) {
    const key = `${l}|${color}|${d.join(',')}`
    const cached = this.smoothNodes.get(key)
    if (cached) return cached
    const level = this.levels[l]
    const n = level.size
    const half = n / 2
    const node = Fn(() => {
      const t = int(instanceIndex)
      const y = t.div(half)
      const x = t.mod(half).mul(2).add(y.add(color).mod(2))
      const i = y.mul(n).add(x).add(level.offset)
      const k = this.kNode.element(i).toVar()
      const {iE, iW, iN, iS, aW, aS} = this.neighbours(x, y, level)
      const D = vec4(d[0], d[1], d[2], d[3])
      const neighbours = this.uNode.element(iE).mul(k.x)
        .add(this.uNode.element(iW).mul(aW))
        .add(this.uNode.element(iN).mul(k.y))
        .add(this.uNode.element(iS).mul(aS))
      const numerator = this.fNode.element(i).add(neighbours.mul(D))
      const denominator = D.mul(k.x.add(aW).add(k.y).add(aS)).add(k.z)
      this.uNode.element(i).assign(numerator.div(max(denominator, vec4(1e-30))))
    })().compute(n * n / 2) as ComputeNode
    this.smoothNodes.set(key, node)
    return node
  }

  /** The residual `F − A u` of level `l`, summed over each coarse cell's children into level `l + 1`'s `F`; its `u` = 0. */
  private restrictResidual(l: number, d: Diffusivity) {
    const key = `${l}|${d.join(',')}`
    const cached = this.restrictNodes.get(key)
    if (cached) return cached
    const fine = this.levels[l]
    const coarse = this.levels[l + 1]
    const nc = coarse.size
    const nf = fine.size
    const node = Fn(() => {
      const t = int(instanceIndex)
      const X = t.mod(nc)
      const Y = t.div(nc)
      let sum = vec4(0) as Node<'vec4'>
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = X.mul(2).add(dx)
          const y = Y.mul(2).add(dy)
          const i = y.mul(nf).add(x).add(fine.offset)
          sum = sum.add(this.fNode.element(i).sub(this.apply(i, x, y, fine, d)))
        }
      }
      const I = Y.mul(nc).add(X).add(coarse.offset)
      this.fNode.element(I).assign(sum)
      this.uNode.element(I).assign(vec4(0))
    })().compute(nc * nc) as ComputeNode
    this.restrictNodes.set(key, node)
    return node
  }

  /** Adds level `l + 1`'s correction to level `l`: each fine cell takes its coarse cell's. */
  private prolong(l: number) {
    const fine = this.levels[l]
    const coarse = this.levels[l + 1]
    const nc = coarse.size
    const nf = fine.size
    return Fn(() => {
      const t = int(instanceIndex)
      const x = t.mod(nf)
      const y = t.div(nf)
      const correction = this.uNode.element(y.div(2).mul(nc).add(x.div(2)).add(coarse.offset))
      this.uNode.element(y.mul(nf).add(x).add(fine.offset)).addAssign(correction)
    })().compute(nf * nf) as ComputeNode
  }

  /** Level `l + 1`'s coefficients from level `l`'s: `B` summed, each coarse face the sum of the two fine faces it spans. */
  private restrictCoefficients(l: number) {
    const fine = this.levels[l]
    const coarse = this.levels[l + 1]
    const nc = coarse.size
    const nf = fine.size
    return Fn(() => {
      const t = int(instanceIndex)
      const X = t.mod(nc)
      const Y = t.div(nc)
      const at = (dx: number, dy: number) => this.kNode.element(Y.mul(2).add(dy).mul(nf).add(X.mul(2).add(dx)).add(fine.offset))
      const b = at(0, 0).z.add(at(1, 0).z).add(at(0, 1).z).add(at(1, 1).z)
      const east = at(1, 0).x.add(at(1, 1).x)
      const north = at(0, 1).y.add(at(1, 1).y)
      this.kNode.element(Y.mul(nc).add(X).add(coarse.offset)).assign(vec4(east, north, b, 0))
    })().compute(nc * nc) as ComputeNode
  }
}

/**
 * The same multigrid on the CPU, one component, for tests: solves `Σ a D (u_i − u_j) + B u_i = F` on level 0 given
 * `aE`, `aN`, `B`, `F` (size² each; the last column's east and the last row's north faces wrap around, so zero
 * there is a closed edge) from `u0`, in `cycles` V-cycles, returning the solution and the residual norm before each
 * cycle and after the last.
 */
export function multigridReference(
  size: number, aE: Float64Array, aN: Float64Array, B: Float64Array, F: Float64Array, u0: Float64Array,
  cycles: number, d = 1, sweeps = 1,
) {
  const levels = multigridLevels(size).map(level => ({
    n: level.size,
    aE: new Float64Array(level.size * level.size),
    aN: new Float64Array(level.size * level.size),
    B: new Float64Array(level.size * level.size),
    F: new Float64Array(level.size * level.size),
    u: new Float64Array(level.size * level.size),
  }))
  levels[0].aE.set(aE)
  levels[0].aN.set(aN)
  levels[0].B.set(B)
  levels[0].F.set(F)
  levels[0].u.set(u0)
  for (let l = 0; l < levels.length - 1; l++) {
    const fine = levels[l]
    const coarse = levels[l + 1]
    for (let Y = 0; Y < coarse.n; Y++) {
      for (let X = 0; X < coarse.n; X++) {
        const at = (dx: number, dy: number) => (Y * 2 + dy) * fine.n + X * 2 + dx
        const I = Y * coarse.n + X
        coarse.B[I] = fine.B[at(0, 0)] + fine.B[at(1, 0)] + fine.B[at(0, 1)] + fine.B[at(1, 1)]
        coarse.aE[I] = fine.aE[at(1, 0)] + fine.aE[at(1, 1)]
        coarse.aN[I] = fine.aN[at(0, 1)] + fine.aN[at(1, 1)]
      }
    }
  }

  type Level = typeof levels[number]
  /** The four faces of cell (x, y): neighbour index and coefficient, wrapping around. */
  const faces = (L: Level, x: number, y: number) => {
    const n = L.n
    const i = y * n + x
    const w = y * n + (x + n - 1) % n
    const s = ((y + n - 1) % n) * n + x
    return [[y * n + (x + 1) % n, L.aE[i]], [w, L.aE[w]], [((y + 1) % n) * n + x, L.aN[i]], [s, L.aN[s]]] as const
  }
  const apply = (L: Level, x: number, y: number) => {
    const i = y * L.n + x
    let flux = 0
    for (const [j, a] of faces(L, x, y)) flux += a * (L.u[i] - L.u[j])
    return flux * d + L.B[i] * L.u[i]
  }
  const smooth = (L: Level, color: number) => {
    const n = L.n
    for (let y = 0; y < n; y++) {
      for (let x = (y + color) % 2; x < n; x += 2) {
        let neighbours = 0
        let sum = 0
        for (const [j, a] of faces(L, x, y)) { neighbours += a * L.u[j]; sum += a }
        L.u[y * n + x] = (L.F[y * n + x] + d * neighbours) / Math.max(d * sum + L.B[y * n + x], 1e-30)
      }
    }
  }
  const residualNorm = () => {
    const L = levels[0]
    let sum = 0
    for (let y = 0; y < L.n; y++) for (let x = 0; x < L.n; x++) sum += (L.F[y * L.n + x] - apply(L, x, y)) ** 2
    return Math.sqrt(sum)
  }

  const residuals: number[] = []
  for (let c = 0; c < cycles; c++) {
    residuals.push(residualNorm())
    for (let l = 0; l < levels.length - 1; l++) {
      const fine = levels[l]
      const coarse = levels[l + 1]
      for (let s = 0; s < sweeps; s++) { smooth(fine, 0); smooth(fine, 1) }
      for (let Y = 0; Y < coarse.n; Y++) {
        for (let X = 0; X < coarse.n; X++) {
          let sum = 0
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) sum += fine.F[(Y * 2 + dy) * fine.n + X * 2 + dx] - apply(fine, X * 2 + dx, Y * 2 + dy)
          }
          coarse.F[Y * coarse.n + X] = sum
          coarse.u[Y * coarse.n + X] = 0
        }
      }
    }
    const last = levels[levels.length - 1]
    last.u[0] = last.F[0] / Math.max(last.B[0], 1e-30)
    for (let l = levels.length - 2; l >= 0; l--) {
      const fine = levels[l]
      const coarse = levels[l + 1]
      for (let y = 0; y < fine.n; y++) {
        for (let x = 0; x < fine.n; x++) fine.u[y * fine.n + x] += coarse.u[(y >> 1) * coarse.n + (x >> 1)]
      }
      for (let s = 0; s < sweeps; s++) { smooth(fine, 1); smooth(fine, 0) }
    }
  }
  residuals.push(residualNorm())
  return {u: levels[0].u, residuals}
}
