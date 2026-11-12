import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { CanyonPath } from './CanyonPath.js'
import { createRandom } from './celestial.js'
import { TERRAIN_SIZE } from './FoldTerrain.js'

describe('CanyonPath', () => {
  it('closes the loop', () => {
    const path = new CanyonPath(TERRAIN_SIZE)
    path.randomize(createRandom(3), 2)
    expect(path.radiusAt(0)).toBeCloseTo(path.radiusAt(Math.PI * 2), 9)
    const start = path.pointAt(0, 0, new Vector3())
    const end = path.pointAt(Math.PI * 2, 0, new Vector3())
    expect(start.distanceTo(end)).toBeLessThan(1e-9)
  })

  it('puts points at the radius from the center, offsets outward', () => {
    const path = new CanyonPath(TERRAIN_SIZE)
    path.randomize(createRandom(9), 3)
    const angle = 1.2
    const point = path.pointAt(angle, -10, new Vector3(), 2)
    expect(Math.hypot(point.x - path.center.x, point.z - path.center.y)).toBeCloseTo(path.radiusAt(angle) + 2, 9)
    expect(point.y).toBe(-10)
  })

  it('keeps the floor inside the block for any seed and lobes at the largest radius', () => {
    const path = new CanyonPath(TERRAIN_SIZE)
    path.radius = 44
    for (let seed = 0; seed < 300; seed++) {
      path.randomize(createRandom(seed), 2 + seed % 4)
      for (let i = 0; i < 360; i++) {
        const point = path.pointAt(i / 360 * Math.PI * 2, 0, new Vector3(), path.halfWidth)
        expect(Math.max(Math.abs(point.x), Math.abs(point.z))).toBeLessThan(TERRAIN_SIZE / 2)
      }
    }
  })

  it('bends back between its lobes: right turns as well as left ones', () => {
    for (const lobes of [2, 3, 4, 5]) {
      const path = new CanyonPath(TERRAIN_SIZE)
      path.randomize(createRandom(lobes * 7), lobes)
      const a = new Vector3()
      const b = new Vector3()
      const c = new Vector3()
      let left = 0
      let right = 0
      for (let i = 0; i < 720; i++) {
        path.pointAt((i - 1) / 720 * Math.PI * 2, 0, a)
        path.pointAt(i / 720 * Math.PI * 2, 0, b)
        path.pointAt((i + 1) / 720 * Math.PI * 2, 0, c)
        const turn = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)
        if (turn > 0) left++
        else right++
      }
      expect(Math.min(left, right)).toBeGreaterThan(50)
    }
  })

  it('flies the loop at an even speed', () => {
    const path = new CanyonPath(TERRAIN_SIZE)
    path.randomize(createRandom(4), 2)
    const a = new Vector3()
    const b = new Vector3()
    for (let i = 0; i < 200; i++) {
      path.pointAt(path.angleAt(i / 200), 0, a)
      path.pointAt(path.angleAt((i + 1) / 200), 0, b)
      expect(a.distanceTo(b)).toBeCloseTo(path.length / 200, 1)
    }
  })
})
