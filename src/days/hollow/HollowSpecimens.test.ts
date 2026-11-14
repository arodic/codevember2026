import {describe, it, expect} from 'vitest'
import {HOLLOW_SPECIMENS, meshSpecimen, specimenDistance} from './HollowSpecimens.js'

describe('Hollow material specimens', () => {
  it('mesh into closed surfaces on their fields, with the cave attributes', () => {
    for (const specimen of HOLLOW_SPECIMENS) {
      const start = performance.now()
      const geometry = meshSpecimen(specimen)
      const ms = performance.now() - start
      const position = geometry.getAttribute('position')
      const index = geometry.getIndex()!
      const count = position.count
      console.log(`${specimen.name}: ${count} vertices, ${index.count / 3} triangles, ${ms.toFixed(0)} ms`)
      expect(count).toBeGreaterThan(5000)
      expect(ms).toBeLessThan(3000)

      // Every edge shared by an even number of triangles: no holes
      const edges = new Map<number, number>()
      const ix = index.array
      for (let i = 0; i < ix.length; i += 3) {
        for (let e = 0; e < 3; e++) {
          const a = ix[i + e]
          const b = ix[i + (e + 1) % 3]
          const key = Math.min(a, b) * count + Math.max(a, b)
          edges.set(key, (edges.get(key) ?? 0) + 1)
        }
      }
      let odd = 0
      for (const uses of edges.values()) if (uses % 2) odd++
      expect(odd, `${specimen.name} holes`).toBe(0)

      // Vertices on the surface, attributes in range
      const zone = geometry.getAttribute('aZone')
      const occlusion = geometry.getAttribute('aOcclusion')
      let off = 0
      for (let v = 0; v < count; v += 7) {
        const d = specimenDistance(specimen, position.getX(v), position.getY(v), position.getZ(v))
        if (Math.abs(d) > specimen.cell * 0.25) off++
        for (let c = 0; c < 4; c++) {
          expect(zone.getComponent(v, c)).toBeGreaterThanOrEqual(-1e-6)
          expect(zone.getComponent(v, c)).toBeLessThanOrEqual(1 + 1e-6)
        }
        expect(occlusion.getX(v)).toBeGreaterThanOrEqual(0)
        expect(occlusion.getX(v)).toBeLessThanOrEqual(1)
      }
      expect(off, `${specimen.name} vertices off the surface`).toBeLessThan(count / 7 / 100)
      geometry.dispose()
    }
  })

  it('carry calcite where the formations are and thin sheets on the drapery', () => {
    const calciteOf = (name: string) => {
      const geometry = meshSpecimen(HOLLOW_SPECIMENS.find(s => s.name === name)!)
      const zone = geometry.getAttribute('aZone')
      const sheet = geometry.getAttribute('aSheet')
      let calcite = 0
      let thin = 0
      for (let v = 0; v < zone.count; v++) {
        if (zone.getY(v) > 0.5) calcite++
        if (sheet.getX(v) < 0.1) thin++
      }
      geometry.dispose()
      return {calcite: calcite / zone.count, thin: thin / zone.count}
    }
    expect(calciteOf('Boulder').calcite).toBe(0)
    expect(calciteOf('Stalactites').calcite).toBeGreaterThan(0.1)
    const drapery = calciteOf('Drapery')
    expect(drapery.calcite).toBeGreaterThan(0.2)
    expect(drapery.thin).toBeGreaterThan(0.2)
  })
})
