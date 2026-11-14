import { describe, it, expect } from 'vitest'
import { type OctreeSource, contourOctree, stitchSlabs, triangulateQuads } from './HollowOctree.js'

/** Two spheres and a thin rod (`r = 4 cm`), finely meshed on the `+z` side only. */
const distance = (x: number, y: number, z: number) => Math.min(
  Math.hypot(x - 1.1, y - 1, z - 1) - 0.6,
  Math.hypot(x - 1.9, y - 1.1, z - 1.2) - 0.35,
  Math.max(Math.hypot(x - 1.5, z - 1.5) - 0.04, Math.abs(y - 1) - 0.8),
)
const source: OctreeSource<null> = {
  distance,
  visit(x, y, z, size) {
    const d = distance(x + size / 2, y + size / 2, z + size / 2)
    if (Math.abs(d) > size * Math.sqrt(3)) return null
    return {split: size > (z + size > 1.5 ? 0.02 : 0.16) + 1e-9, context: null}
  },
}
const ORIGIN = {x: 0, y: 0, z: 0}

/** Odd-use edges (holes) and the signed volume (positive: front faces face out). */
function inspect(positions: Float32Array, quads: Int32Array) {
  const idx = triangulateQuads(positions, quads)
  const n = positions.length / 3
  const edges = new Map<number, number>()
  let volume = 0
  const p = positions
  for (let i = 0; i < idx.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[i + e]
      const b = idx[i + (e + 1) % 3]
      const key = Math.min(a, b) * n + Math.max(a, b)
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  }
  let odd = 0
  for (const uses of edges.values()) if (uses % 2) odd++
  return {triangles: idx.length / 3, odd, volume}
}

describe('Hollow octree contouring', () => {
  it('meshes cells of very different sizes into one closed surface facing out', () => {
    const contour = contourOctree(source, ORIGIN, 2.56, 7, null)
    const {triangles, odd, volume} = inspect(contour.positions, contour.quads)
    expect(triangles).toBeGreaterThan(5000)
    expect(odd).toBe(0)
    // Two overlapping balls and the rod: `~1.08 m³` (mass points sit a little inside)
    expect(volume).toBeGreaterThan(0.95)
    expect(volume).toBeLessThan(1.1)
    // Fine cells (`2 cm`) on the far side, coarse (`16 cm`) on the near
    const sizes = new Set(Array.from({length: contour.cells.length / 4}, (_, v) => contour.cells[v * 4 + 3].toFixed(2)))
    expect(sizes.has('0.02')).toBe(true)
    expect(sizes.has('0.16')).toBe(true)
  })

  it('meshes slabs apart into exactly the surface of one piece', () => {
    const slab = {from: 0, to: 128, maxLeaf: 16}
    const whole = contourOctree(source, ORIGIN, 2.56, 7, null, slab)
    const parts = []
    for (let from = 0; from < 128; from += 16) parts.push(contourOctree(source, ORIGIN, 2.56, 7, null, {from, to: from + 16, maxLeaf: 16}))
    const {offsets, count, quads} = stitchSlabs(parts)
    const positions = new Float32Array(count * 3)
    parts.forEach((part, i) => positions.set(part.positions, offsets[i] * 3))
    expect(count).toBe(whole.positions.length / 3)
    const a = inspect(whole.positions, whole.quads)
    const b = inspect(positions, quads)
    expect(b.odd).toBe(0)
    expect(b.triangles).toBe(a.triangles)
    expect(b.volume).toBeCloseTo(a.volume, 5)
  })
})
