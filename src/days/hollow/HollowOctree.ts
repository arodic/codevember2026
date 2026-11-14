/** A node's verdict from `OctreeSource.visit`: split it into eight, and visit the children with `context`. */
export interface OctreeVisit<C> {
  split: boolean
  context: C
}

/** The signed distance field `contourOctree` meshes, and how finely. */
export interface OctreeSource<C> {
  /** Signed distance (`m`) at a point: positive outside, in the open. */
  distance(x: number, y: number, z: number): number
  /**
   * A node's box (min corner, edge `size`), called top-down with its parent's context: `null` when it certainly holds
   * no surface, not even on its faces (an empty leaf: the edges around it aren't contoured), else whether its surface
   * needs smaller cells (a leaf that only probably holds none is still contoured). `corners()` gives the distance at
   * its eight corners (`c = x | y << 1 | z << 2`), from the lattice the contouring samples anyway.
   */
  visit(x: number, y: number, z: number, size: number, parent: C, corners: () => Float32Array): OctreeVisit<C> | null
  /** Whether to contour the edge whose midpoint is `(x, y, z)` (default: every edge). */
  emit?(x: number, y: number, z: number): boolean
}

/** A slab of the octree along `z` (in finest cells): one of several meshed apart (in parallel) and merged. */
export interface OctreeSlab {
  /** The slab `[from, to)`, multiples of `maxLeaf`. */
  from: number
  to: number
  /** Nodes larger than this (in finest cells) always split unless empty, so no leaf straddles two slabs. */
  maxLeaf: number
}

export interface OctreeContour {
  /** One vertex per cell the surface crosses: the mean of the crossings on the edges around it (not on the surface). */
  positions: Float32Array
  /** Each vertex's cell: min corner `xyz`, edge `w`. */
  cells: Float32Array
  /**
   * Polygons around the crossed edges, front faces facing the open: four vertex references, `-1` last for a
   * triangle. A reference `r >= 0` is a vertex here, `r <= -2` the neighbouring slab's leaf `foreign[-r - 2]`.
   */
  quads: Int32Array
  /** Keys (`leafKey`) of the leaves of the neighbouring slabs that polygons here refer to. */
  foreign: Float64Array
  /** Keys of this slab's vertices on its faces (`boundaryVertices`), for the neighbours' references. */
  boundaryKeys: Float64Array
  boundaryVertices: Int32Array
}

/** A leaf's key: its min corner (in finest cells), unique among leaves. */
export function leafKey(x: number, y: number, z: number, depth: number) {
  const side = (1 << depth) + 1
  return x + side * (y + side * z)
}

/**
 * Adaptive dual contouring (Ju et al. 2002, with Surface Nets mass points instead of QEF vertices): `source.visit`
 * grows an octree of cubes of `size` at `origin` down to `size / 2^depth`, each leaf that the surface crosses gets a
 * vertex, and every minimal edge (an edge of the smallest leaves around it) the surface crosses becomes a polygon of
 * the leaves around it. Leaves of any size meet without cracks. A crossing is found from the distance at the edge's
 * ends. Edges on an empty leaf (`visit` returns `null`) are skipped unevaluated, so that verdict must be certain: a
 * wrong one opens a hole.
 */
export function contourOctree<C>(
  source: OctreeSource<C>,
  origin: {x: number; y: number; z: number},
  size: number,
  depth: number,
  context: C,
  slab: OctreeSlab = {from: 0, to: 1 << depth, maxLeaf: 1 << depth},
): OctreeContour {
  const unit = size / (1 << depth)
  const {from, to, maxLeaf} = slab
  const nodeX: number[] = []
  const nodeY: number[] = []
  const nodeZ: number[] = []
  const nodeS: number[] = []
  /** First child, `-1` for a leaf, `EMPTY` for an empty leaf. */
  const nodeChild: number[] = []
  const EMPTY = -2

  const add = (x: number, y: number, z: number, s: number) => {
    nodeX.push(x)
    nodeY.push(y)
    nodeZ.push(z)
    nodeS.push(s)
    nodeChild.push(-1)
    return nodeX.length - 1
  }

  // Distance at lattice corners, shared by the nodes and edges that meet there (open addressing; keys
  // `x + side (y + side z)`)
  const side = (1 << depth) + 1
  let capacity = 1 << 16
  let keys = new Float64Array(capacity).fill(-1)
  let values = new Float32Array(capacity)
  let stored = 0
  const slot = (x: number, y: number, z: number, key: number, table: Float64Array) => {
    const mask = table.length - 1
    let i = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) & mask
    while (table[i] !== key && table[i] !== -1) i = (i + 1) & mask
    return i
  }
  const corner = (x: number, y: number, z: number) => {
    const key = x + side * (y + side * z)
    const i = slot(x, y, z, key, keys)
    if (keys[i] === key) return values[i]
    const d = source.distance(origin.x + x * unit, origin.y + y * unit, origin.z + z * unit)
    keys[i] = key
    values[i] = d
    if (++stored * 2 > capacity) {
      const oldKeys = keys
      const oldValues = values
      capacity *= 2
      keys = new Float64Array(capacity).fill(-1)
      values = new Float32Array(capacity)
      for (let j = 0; j < oldKeys.length; j++) {
        const k = oldKeys[j]
        if (k === -1) continue
        const kx = k % side
        const ky = Math.floor(k / side) % side
        const kz = Math.floor(k / (side * side))
        const to = slot(kx, ky, kz, k, keys)
        keys[to] = k
        values[to] = oldValues[j]
      }
    }
    return d
  }

  // The corners of the node being visited
  let visiting = 0
  const cornerValues = new Float32Array(8)
  const cornersOf = () => {
    const s = nodeS[visiting]
    const x = nodeX[visiting]
    const y = nodeY[visiting]
    const z = nodeZ[visiting]
    for (let c = 0; c < 8; c++) cornerValues[c] = corner(x + (c & 1) * s, y + ((c >> 1) & 1) * s, z + (c >> 2) * s)
    return cornerValues
  }

  // 1. The tree: children `c = x | y << 1 | z << 2` (a bit per axis), each `s / 2` from the parent's min corner. In
  // the slab, and a skin of leaves across its faces (the neighbours' leaves there, as the neighbours grow them); the
  // rest of the neighbours stays unexpanded
  const build = (id: number, parent: C) => {
    const s = nodeS[id]
    const z = nodeZ[id]
    if (!(z < to && z + s > from) && z + s !== from && z !== to) return
    if (s === 1) return
    visiting = id
    const visit = source.visit(
      origin.x + nodeX[id] * unit, origin.y + nodeY[id] * unit, origin.z + z * unit, s * unit, parent, cornersOf,
    )
    if (!visit) nodeChild[id] = EMPTY
    if (!visit || (!visit.split && s <= maxLeaf)) return
    const h = s >> 1
    const first = nodeX.length
    for (let c = 0; c < 8; c++) add(nodeX[id] + (c & 1) * h, nodeY[id] + ((c >> 1) & 1) * h, nodeZ[id] + (c >> 2) * h, h)
    nodeChild[id] = first
    for (let c = 0; c < 8; c++) build(first + c, visit.context)
  }
  build(add(0, 0, 0, 1 << depth), context)

  const child = (n: number, c: number) => (nodeChild[n] < 0 ? n : nodeChild[n] + c)
  const leaf = (n: number) => nodeChild[n] < 0
  const empty = (n: number) => nodeChild[n] === EMPTY

  // Mass points per leaf of the slab; leaves across its faces are referred to by key
  const owned = (n: number) => nodeZ[n] >= from && nodeZ[n] < to
  const foreignOf = new Map<number, number>()
  const foreign: number[] = []
  const refer = (n: number) => {
    const key = leafKey(nodeX[n], nodeY[n], nodeZ[n], depth)
    let f = foreignOf.get(key)
    if (f === undefined) {
      f = foreign.length
      foreignOf.set(key, f)
      foreign.push(key)
    }
    return -2 - f
  }
  const vertexOf = new Int32Array(nodeX.length).fill(-1)
  const sums: number[] = []
  const counts: number[] = []
  const cellOf: number[] = []
  const quads: number[] = []

  const accumulate = (n: number, x: number, y: number, z: number) => {
    let v = vertexOf[n]
    if (v < 0) {
      v = vertexOf[n] = counts.length
      sums.push(0, 0, 0)
      counts.push(0)
      cellOf.push(n)
    }
    sums[v * 3] += x
    sums[v * 3 + 1] += y
    sums[v * 3 + 2] += z
    counts[v]++
    return v
  }

  const p0 = [0, 0, 0]
  const p1 = [0, 0, 0]
  const around = new Int32Array(4)
  const ids = new Int32Array(4)

  /**
   * The four leaves around an edge along axis `a`, `nq` on the low side of axis `u = a + 1` when `q & 1` is `0` and
   * of axis `v = a + 2` when `q & 2` is: the smallest one's edge is the minimal edge.
   */
  const processEdge = (n0: number, n1: number, n2: number, n3: number, a: number) => {
    // On an empty leaf's boundary: no crossing
    if (empty(n0) || empty(n1) || empty(n2) || empty(n3)) return
    let q = 0
    let m = n0
    if (nodeS[n1] < nodeS[m]) { q = 1; m = n1 }
    if (nodeS[n2] < nodeS[m]) { q = 2; m = n2 }
    if (nodeS[n3] < nodeS[m]) { q = 3; m = n3 }
    const s = nodeS[m]
    const u = (a + 1) % 3
    const v = (a + 2) % 3
    p0[0] = nodeX[m]
    p0[1] = nodeY[m]
    p0[2] = nodeZ[m]
    p0[u] += (1 - (q & 1)) * s
    p0[v] += (1 - (q >> 1)) * s
    p1[0] = p0[0]
    p1[1] = p0[1]
    p1[2] = p0[2]
    p1[a] += s
    // Edges in the slab, and on its far face (for its leaves' mass points; the next slab emits their polygons)
    const mid2 = p0[2] + p1[2]
    if (mid2 < 2 * from || mid2 > 2 * to) return
    if (source.emit && !source.emit(
      origin.x + (p0[0] + p1[0]) * 0.5 * unit,
      origin.y + (p0[1] + p1[1]) * 0.5 * unit,
      origin.z + (p0[2] + p1[2]) * 0.5 * unit,
    )) return
    const d0 = corner(p0[0], p0[1], p0[2])
    const d1 = corner(p1[0], p1[1], p1[2])
    if ((d0 >= 0) === (d1 >= 0)) return
    const t = d0 / (d0 - d1)
    const x = origin.x + (p0[0] + (p1[0] - p0[0]) * t) * unit
    const y = origin.y + (p0[1] + (p1[1] - p0[1]) * t) * unit
    const z = origin.z + (p0[2] + (p1[2] - p0[2]) * t) * unit
    // Around the edge counterclockwise seen from `+a` (`u × v = a`): the polygon faces `+a`, the open end's way
    around[0] = n0
    around[1] = n1
    around[2] = n3
    around[3] = n2
    const emit = mid2 < 2 * to
    let count = 0
    for (let i = 0; i < 4; i++) {
      const node = around[i]
      if (node === around[(i + 3) % 4]) continue
      ids[count++] = owned(node) ? accumulate(node, x, y, z) : emit ? refer(node) : 0
    }
    if (count < 3 || !emit) return
    if (d0 >= 0) {
      if (count === 4) quads.push(ids[3], ids[2], ids[1], ids[0])
      else quads.push(ids[2], ids[1], ids[0], -1)
    } else {
      quads.push(ids[0], ids[1], ids[2], count === 4 ? ids[3] : -1)
    }
  }

  const edgeProc = (n0: number, n1: number, n2: number, n3: number, a: number) => {
    if (leaf(n0) && leaf(n1) && leaf(n2) && leaf(n3)) {
      processEdge(n0, n1, n2, n3, a)
      return
    }
    const u = 1 << ((a + 1) % 3)
    const v = 1 << ((a + 2) % 3)
    for (let half = 0; half < 2; half++) {
      const h = half << a
      edgeProc(child(n0, h | u | v), child(n1, h | v), child(n2, h | u), child(n3, h), a)
    }
  }

  /** Two nodes sharing a face across axis `a`, `n0` on its low side. */
  const faceProc = (n0: number, n1: number, a: number) => {
    if (leaf(n0) && leaf(n1)) return
    const A = 1 << a
    const ua = (a + 1) % 3
    const va = (a + 2) % 3
    const u = 1 << ua
    const v = 1 << va
    for (let bu = 0; bu < 2; bu++) {
      for (let bv = 0; bv < 2; bv++) {
        const c = (bu ? u : 0) | (bv ? v : 0)
        faceProc(child(n0, A | c), child(n1, c), a)
      }
    }
    // The face's inner edges along `u` (the four around it split by `v`, then `a`) and along `v` (by `a`, then `u`)
    for (let bu = 0; bu < 2; bu++) {
      const c = bu ? u : 0
      edgeProc(child(n0, A | c), child(n0, A | c | v), child(n1, c), child(n1, c | v), ua)
    }
    for (let bv = 0; bv < 2; bv++) {
      const c = bv ? v : 0
      edgeProc(child(n0, A | c), child(n1, c), child(n0, A | c | u), child(n1, c | u), va)
    }
  }

  const cellProc = (n: number) => {
    if (leaf(n)) return
    for (let c = 0; c < 8; c++) cellProc(child(n, c))
    for (let a = 0; a < 3; a++) {
      for (let c = 0; c < 8; c++) if (!(c & (1 << a))) faceProc(child(n, c), child(n, c | (1 << a)), a)
    }
    for (let a = 0; a < 3; a++) {
      const u = 1 << ((a + 1) % 3)
      const v = 1 << ((a + 2) % 3)
      for (let half = 0; half < 2; half++) {
        const h = half << a
        edgeProc(child(n, h), child(n, h | u), child(n, h | v), child(n, h | u | v), a)
      }
    }
  }
  cellProc(0)

  const count = counts.length
  const positions = new Float32Array(count * 3)
  const cells = new Float32Array(count * 4)
  const boundaryKeys: number[] = []
  const boundaryVertices: number[] = []
  for (let v = 0; v < count; v++) {
    positions[v * 3] = sums[v * 3] / counts[v]
    positions[v * 3 + 1] = sums[v * 3 + 1] / counts[v]
    positions[v * 3 + 2] = sums[v * 3 + 2] / counts[v]
    const n = cellOf[v]
    cells[v * 4] = origin.x + nodeX[n] * unit
    cells[v * 4 + 1] = origin.y + nodeY[n] * unit
    cells[v * 4 + 2] = origin.z + nodeZ[n] * unit
    cells[v * 4 + 3] = nodeS[n] * unit
    if (nodeZ[n] === from || nodeZ[n] + nodeS[n] === to) {
      boundaryKeys.push(leafKey(nodeX[n], nodeY[n], nodeZ[n], depth))
      boundaryVertices.push(v)
    }
  }
  return {
    positions,
    cells,
    quads: new Int32Array(quads),
    foreign: new Float64Array(foreign),
    boundaryKeys: new Float64Array(boundaryKeys),
    boundaryVertices: new Int32Array(boundaryVertices),
  }
}

/**
 * Triangles of `contourOctree`'s polygons. A quad folds along one of its diagonals: with `normals` (the surface's at
 * the vertices), along the one the surface bends least over, so the triangles' edges run along creases instead of
 * zig-zagging across them, and never so that a triangle turns its back to its vertices' normals; else along the
 * shorter one.
 */
export function triangulateQuads(
  positions: ArrayLike<number>, quads: ArrayLike<number>, normals?: ArrayLike<number>,
): Uint32Array {
  const out = new Uint32Array(quads.length * 1.5)
  let o = 0
  const p = positions
  const n = normals
  const dist2 = (a: number, b: number) => {
    const dx = p[a * 3] - p[b * 3]
    const dy = p[a * 3 + 1] - p[b * 3 + 1]
    const dz = p[a * 3 + 2] - p[b * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }
  /** How far the surface bends along `a -> b`: its normals' change along the chord (`m`). */
  const bend = (a: number, b: number) => {
    if (!n) return 0
    return Math.abs((n[a * 3] - n[b * 3]) * (p[b * 3] - p[a * 3]) + (n[a * 3 + 1] - n[b * 3 + 1]) * (p[b * 3 + 1] - p[a * 3 + 1])
      + (n[a * 3 + 2] - n[b * 3 + 2]) * (p[b * 3 + 2] - p[a * 3 + 2]))
  }
  /** Whether triangle `a b c` faces along its vertices' normals. */
  const facing = (a: number, b: number, c: number) => {
    if (!n) return true
    const ux = p[b * 3] - p[a * 3]
    const uy = p[b * 3 + 1] - p[a * 3 + 1]
    const uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3]
    const vy = p[c * 3 + 1] - p[a * 3 + 1]
    const vz = p[c * 3 + 2] - p[a * 3 + 2]
    return (uy * vz - uz * vy) * (n[a * 3] + n[b * 3] + n[c * 3])
      + (uz * vx - ux * vz) * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1])
      + (ux * vy - uy * vx) * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]) > 0
  }
  for (let i = 0; i < quads.length; i += 4) {
    const a = quads[i]
    const b = quads[i + 1]
    const c = quads[i + 2]
    const d = quads[i + 3]
    if (d < 0) {
      out[o++] = a
      out[o++] = b
      out[o++] = c
      continue
    }
    // Bend first; between near-flat diagonals the shorter
    const ac = bend(a, c) + 0.02 * Math.sqrt(dist2(a, c))
    const bd = bend(b, d) + 0.02 * Math.sqrt(dist2(b, d))
    let alongAC = ac <= bd
    const fineAC = facing(a, b, c) && facing(a, c, d)
    const fineBD = facing(b, c, d) && facing(b, d, a)
    if (fineAC !== fineBD) alongAC = fineAC
    if (alongAC) {
      out[o++] = a; out[o++] = b; out[o++] = c
      out[o++] = a; out[o++] = c; out[o++] = d
    } else {
      out[o++] = b; out[o++] = c; out[o++] = d
      out[o++] = b; out[o++] = d; out[o++] = a
    }
  }
  return out.slice(0, o)
}

/**
 * Joins slabs meshed apart (consecutive, in order): their vertices are concatenated, so slab `i`'s vertex `v` becomes
 * `offsets[i] + v`, and the polygons' references to the neighbours' leaves resolve to those.
 */
export function stitchSlabs(slabs: OctreeContour[]): {offsets: number[]; count: number; quads: Int32Array} {
  const offsets: number[] = []
  let count = 0
  const byKey = new Map<number, number>()
  for (const slab of slabs) {
    offsets.push(count)
    slab.boundaryKeys.forEach((key, i) => byKey.set(key, count + slab.boundaryVertices[i]))
    count += slab.positions.length / 3
  }
  const quads = new Int32Array(slabs.reduce((sum, slab) => sum + slab.quads.length, 0))
  let o = 0
  slabs.forEach((slab, i) => {
    const q = slab.quads
    for (let j = 0; j < q.length; j++) {
      const r = q[j]
      if (r >= 0) quads[o++] = offsets[i] + r
      else if (r === -1) quads[o++] = -1
      else {
        const v = byKey.get(slab.foreign[-r - 2])
        if (v === undefined) throw new Error('stitchSlabs: a polygon refers to a leaf no slab has')
        quads[o++] = v
      }
    }
  })
  return {offsets, count, quads}
}
