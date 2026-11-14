import {BufferAttribute, BufferGeometry} from 'three/webgpu'
import {SCULPT_CALCITE_GROUP, SCULPT_ROCK_GROUP} from './HollowSculpt.js'

/** Texels per side of the surface's atlas (`uv`). */
export const ATLAS_SIZE = 4096
/** Texels kept free around each chart, so filtering doesn't bleed between them. */
const ATLAS_PAD = 2
/** Most triangles a chunk holds (a meshlet geometry's levels of detail and culling are per chunk). */
export const CHUNK_TRIANGLES = 48000
/** How far (`m`) a chunk's skirt hangs back into the rock behind its border. */
export const SKIRT_DEPTH = 0.04

/** The cave as chunks: what draws (`render`), and the same with the zones the surface bake reads (`bake`). */
export interface HollowChunks {
  render: BufferGeometry[]
  bake: BufferGeometry[]
  /** Texels per metre of the atlas, and its charts. */
  scale: number
  charts: number
}

/** The cave's surface unwrapped: a vertex per chart corner, with its `uv` and the vertex it came from. */
interface Unwrapped {
  /** Source vertex of each corner. */
  source: Int32Array
  uv: Float32Array
  /** The triangles over the corners (the source's order, so its groups hold). */
  index: Uint32Array
  scale: number
  charts: number
}

/**
 * Charts of the cave's surface, box projected: each triangle takes the axis its normal (the mean of its vertices'
 * smooth normals) leans along most, the triangles of an axis sharing vertices make a chart, flattened onto that axis'
 * plane (stretched at most `√3` across its slopes). Shelf-packed into the atlas at the most texels per metre that fit.
 */
function unwrap(geometry: BufferGeometry): Unwrapped {
  const P = geometry.getAttribute('position').array as Float32Array
  const N = geometry.getAttribute('normal').array as Float32Array
  const I = geometry.getIndex()!.array as Uint32Array
  const vertices = P.length / 3
  const triangles = I.length / 3

  // The axis of each triangle (`0 … 5`: ±x, ±y, ±z), and a corner per vertex and axis
  const slot = new Int32Array(vertices * 6).fill(-1)
  const cornerOf = new Int32Array(triangles * 3)
  let corners = 0
  const labels = new Uint8Array(triangles)
  for (let t = 0; t < triangles; t++) {
    let nx = 0
    let ny = 0
    let nz = 0
    for (let c = 0; c < 3; c++) {
      const v = I[t * 3 + c] * 3
      nx += N[v]
      ny += N[v + 1]
      nz += N[v + 2]
    }
    const ax = Math.abs(nx)
    const ay = Math.abs(ny)
    const az = Math.abs(nz)
    const label = ax >= ay && ax >= az ? (nx >= 0 ? 0 : 1) : ay >= az ? (ny >= 0 ? 2 : 3) : (nz >= 0 ? 4 : 5)
    labels[t] = label
    for (let c = 0; c < 3; c++) {
      const key = I[t * 3 + c] * 6 + label
      if (slot[key] < 0) slot[key] = corners++
      cornerOf[t * 3 + c] = slot[key]
    }
  }
  const source = new Int32Array(corners)
  const cornerLabel = new Uint8Array(corners)
  for (let key = 0; key < slot.length; key++) {
    const corner = slot[key]
    if (corner < 0) continue
    source[corner] = Math.floor(key / 6)
    cornerLabel[corner] = key % 6
  }

  // Charts: the corners each triangle joins
  const parent = new Int32Array(corners)
  for (let i = 0; i < corners; i++) parent[i] = i
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (x: number, y: number) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[ry] = rx
  }
  for (let t = 0; t < triangles; t++) {
    union(cornerOf[t * 3], cornerOf[t * 3 + 1])
    union(cornerOf[t * 3], cornerOf[t * 3 + 2])
  }
  const chartOf = new Int32Array(corners).fill(-1)
  const rootChart = new Int32Array(corners).fill(-1)
  let charts = 0
  for (let i = 0; i < corners; i++) {
    const root = find(i)
    if (rootChart[root] < 0) rootChart[root] = charts++
    chartOf[i] = rootChart[root]
  }

  // Each corner flattened onto its axis' plane (`m`), and each chart's bounds there
  const plane = new Float32Array(corners * 2)
  const min = new Float32Array(charts * 2).fill(Infinity)
  const max = new Float32Array(charts * 2).fill(-Infinity)
  for (let i = 0; i < corners; i++) {
    const v = source[i] * 3
    const axis = cornerLabel[i] >> 1
    const u = axis === 0 ? P[v + 2] : P[v]
    const w = axis === 1 ? P[v + 2] : P[v + 1]
    plane[i * 2] = u
    plane[i * 2 + 1] = w
    const k = chartOf[i] * 2
    if (u < min[k]) min[k] = u
    if (u > max[k]) max[k] = u
    if (w < min[k + 1]) min[k + 1] = w
    if (w > max[k + 1]) max[k + 1] = w
  }

  // Shelves of charts, tallest first: the most texels per metre that fit
  const order = Array.from({length: charts}, (_, i) => i)
  order.sort((a, b) => (max[b * 2 + 1] - min[b * 2 + 1]) - (max[a * 2 + 1] - min[a * 2 + 1]))
  const offsets = new Float32Array(charts * 2)
  const pack = (scale: number) => {
    let x = 0
    let y = 0
    let shelf = 0
    for (const chart of order) {
      const w = Math.ceil((max[chart * 2] - min[chart * 2]) * scale) + 1 + 2 * ATLAS_PAD
      const h = Math.ceil((max[chart * 2 + 1] - min[chart * 2 + 1]) * scale) + 1 + 2 * ATLAS_PAD
      if (x + w > ATLAS_SIZE) {
        y += shelf
        x = 0
        shelf = 0
      }
      if (y + h > ATLAS_SIZE || w > ATLAS_SIZE) return false
      offsets[chart * 2] = x
      offsets[chart * 2 + 1] = y
      x += w
      shelf = Math.max(shelf, h)
    }
    return true
  }
  let area = 0
  for (let c = 0; c < charts; c++) area += (max[c * 2] - min[c * 2]) * (max[c * 2 + 1] - min[c * 2 + 1])
  let hi = ATLAS_SIZE / Math.sqrt(Math.max(area, 1e-6))
  let lo = 0
  for (let i = 0; i < 14; i++) {
    const mid = 0.5 * (lo + hi)
    if (pack(mid)) lo = mid
    else hi = mid
  }
  const scale = lo
  pack(scale)

  const uv = new Float32Array(corners * 2)
  for (let i = 0; i < corners; i++) {
    const k = chartOf[i] * 2
    uv[i * 2] = (offsets[k] + ATLAS_PAD + 0.5 + (plane[i * 2] - min[k]) * scale) / ATLAS_SIZE
    uv[i * 2 + 1] = (offsets[k + 1] + ATLAS_PAD + 0.5 + (plane[i * 2 + 1] - min[k + 1]) * scale) / ATLAS_SIZE
  }
  return {source, uv, index: new Uint32Array(cornerOf), scale, charts}
}

/**
 * Splits the triangles `ids` (of the unwrapped surface) at the middle of their centroids' longest extent, until no
 * part holds more than `CHUNK_TRIANGLES`.
 */
function split(ids: Int32Array, centroids: Float32Array, out: Int32Array[]) {
  if (ids.length <= CHUNK_TRIANGLES) {
    out.push(ids)
    return
  }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const t of ids) {
    for (let a = 0; a < 3; a++) {
      const c = centroids[t * 3 + a]
      if (c < lo[a]) lo[a] = c
      if (c > hi[a]) hi[a] = c
    }
  }
  const axis = hi[0] - lo[0] >= hi[1] - lo[1] && hi[0] - lo[0] >= hi[2] - lo[2] ? 0 : hi[1] - lo[1] >= hi[2] - lo[2] ? 1 : 2
  const middle = 0.5 * (lo[axis] + hi[axis])
  let below = 0
  for (const t of ids) if (centroids[t * 3 + axis] < middle) below++
  // All on one side (centroids coincide): halve by order
  if (below === 0 || below === ids.length) {
    split(ids.subarray(0, ids.length >> 1), centroids, out)
    split(ids.subarray(ids.length >> 1), centroids, out)
    return
  }
  const left = new Int32Array(below)
  const right = new Int32Array(ids.length - below)
  let l = 0
  let r = 0
  for (const t of ids) {
    if (centroids[t * 3 + axis] < middle) left[l++] = t
    else right[r++] = t
  }
  split(left, centroids, out)
  split(right, centroids, out)
}

/**
 * The cave's surface (`assembleSculpt`) for drawing: unwrapped into the atlas (`uv`), split into chunks of compact
 * shape (each culled and given its levels of detail apart), each chunk's open border hung with a skirt back into the
 * rock (so simplified neighbours never show a crack through to the void behind the walls). Every vertex keeps the
 * light map texel of the surface vertex it came from (`aLightTexel`, the surface's own vertex order: the light maps
 * bake the surface itself), skirts and seams included.
 */
export function buildHollowChunks(geometry: BufferGeometry): HollowChunks {
  const {source, uv, index, scale, charts} = unwrap(geometry)
  const P = geometry.getAttribute('position').array as Float32Array
  const N = geometry.getAttribute('normal').array as Float32Array
  const Z = geometry.getAttribute('aZone').array as Float32Array
  const S = geometry.getAttribute('aSheet').array as Float32Array
  const O = geometry.getAttribute('aOcclusion').array as Float32Array
  const groups = geometry.groups
  const rockEnd = (groups.find(g => g.materialIndex === SCULPT_ROCK_GROUP)?.count ?? index.length) / 3
  const triangles = index.length / 3

  const centroids = new Float32Array(triangles * 3)
  for (let t = 0; t < triangles; t++) {
    for (let c = 0; c < 3; c++) {
      const v = source[index[t * 3 + c]] * 3
      centroids[t * 3] += P[v] / 3
      centroids[t * 3 + 1] += P[v + 1] / 3
      centroids[t * 3 + 2] += P[v + 2] / 3
    }
  }
  const parts: Int32Array[] = []
  split(Int32Array.from({length: triangles}, (_, i) => i), centroids, parts)

  const local = new Int32Array(uv.length / 2).fill(-1)
  const render: BufferGeometry[] = []
  const bake: BufferGeometry[] = []
  for (const part of parts) {
    // Rock first, then the calcite (the ids ascend: the rock's are below `rockEnd`)
    part.sort()
    const rock = part.findIndex(t => t >= rockEnd)
    const rockCount = rock < 0 ? part.length : rock

    // Its corners, numbered locally
    const corners: number[] = []
    for (const t of part) {
      for (let c = 0; c < 3; c++) {
        const corner = index[t * 3 + c]
        if (local[corner] < 0) {
          local[corner] = corners.length
          corners.push(corner)
        }
      }
    }
    const tris = new Uint32Array(part.length * 3)
    part.forEach((t, i) => {
      for (let c = 0; c < 3; c++) tris[i * 3 + c] = local[index[t * 3 + c]]
    })

    // The border: edges of one triangle here (by position: its seams' corners share their source vertices)
    const edges = new Map<number, number>()
    const count = source.length
    const key = (a: number, b: number) => Math.min(a, b) * count + Math.max(a, b)
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const k = key(source[corners[tris[i + e]]], source[corners[tris[i + (e + 1) % 3]]])
        edges.set(k, (edges.get(k) ?? 0) + 1)
      }
    }
    const skirtOf = new Map<number, number>()
    const skirtCorners: number[] = []
    const skirt: number[] = []
    const hang = (a: number) => {
      let s = skirtOf.get(a)
      if (s === undefined) {
        s = corners.length + skirtCorners.length
        skirtOf.set(a, s)
        skirtCorners.push(corners[a])
      }
      return s
    }
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[i + e]
        const b = tris[i + (e + 1) % 3]
        if (edges.get(key(source[corners[a]], source[corners[b]])) !== 1) continue
        // Facing out across the border (away from the triangle), hanging back along the normals
        const a2 = hang(a)
        const b2 = hang(b)
        skirt.push(b, a, a2, b, a2, b2)
      }
    }

    // Rock, skirt (drawn with the rock), calcite
    const all = new Uint32Array(tris.length + skirt.length)
    all.set(tris.subarray(0, rockCount * 3), 0)
    all.set(skirt, rockCount * 3)
    all.set(tris.subarray(rockCount * 3), rockCount * 3 + skirt.length)

    const n = corners.length + skirtCorners.length
    const position = new Float32Array(n * 3)
    const normal = new Float32Array(n * 3)
    const coord = new Float32Array(n * 2)
    const zone = new Float32Array(n * 4)
    const sheet = new Float32Array(n * 2)
    const occlusion = new Float32Array(n)
    const texel = new Float32Array(n)
    const fill = (i: number, corner: number, depth: number) => {
      const v = source[corner]
      for (let c = 0; c < 3; c++) {
        normal[i * 3 + c] = N[v * 3 + c]
        position[i * 3 + c] = P[v * 3 + c] - N[v * 3 + c] * depth
      }
      coord.set(uv.subarray(corner * 2, corner * 2 + 2), i * 2)
      zone.set(Z.subarray(v * 4, v * 4 + 4), i * 4)
      sheet.set(S.subarray(v * 2, v * 2 + 2), i * 2)
      occlusion[i] = O[v]
      texel[i] = v
    }
    corners.forEach((corner, i) => fill(i, corner, 0))
    skirtCorners.forEach((corner, i) => fill(corners.length + i, corner, SKIRT_DEPTH))
    for (const corner of corners) local[corner] = -1

    const drawn = new BufferGeometry()
    drawn.setAttribute('position', new BufferAttribute(position, 3))
    drawn.setAttribute('normal', new BufferAttribute(normal, 3))
    drawn.setAttribute('uv', new BufferAttribute(coord, 2))
    drawn.setAttribute('aSheet', new BufferAttribute(sheet, 2))
    drawn.setAttribute('aOcclusion', new BufferAttribute(occlusion, 1))
    drawn.setAttribute('aLightTexel', new BufferAttribute(texel, 1))
    drawn.setIndex(new BufferAttribute(all, 1))
    const rockIndices = rockCount * 3 + skirt.length
    drawn.addGroup(0, rockIndices, SCULPT_ROCK_GROUP)
    if (all.length > rockIndices) drawn.addGroup(rockIndices, all.length - rockIndices, SCULPT_CALCITE_GROUP)
    drawn.computeBoundingBox()
    drawn.computeBoundingSphere()
    render.push(drawn)

    // The bake reads the zones too (the rest it shares)
    const baked = new BufferGeometry()
    for (const name of ['position', 'normal', 'uv', 'aSheet', 'aOcclusion']) baked.setAttribute(name, drawn.getAttribute(name))
    baked.setAttribute('aZone', new BufferAttribute(zone, 4))
    baked.setIndex(drawn.getIndex())
    baked.boundingBox = drawn.boundingBox
    baked.boundingSphere = drawn.boundingSphere
    bake.push(baked)
  }
  return {render, bake, scale, charts}
}
