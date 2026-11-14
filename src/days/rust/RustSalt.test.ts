import { describe, expect, it } from 'vitest'
import { RustClock } from './RustClock.js'
import { CRITICAL_RADIUS, DropModel, TILE_SIZE, generateSalt, tileDistance, wrapTile } from './RustSalt.js'
import { SECONDS_PER_DAY, saltCubeMass } from './RustScience.js'

const options = {seed: 7, heroEdge: 28, saltLoad: 20, chlorideDeposition: 60, exposureDays: 30}

describe('Rust salt', () => {
  const salt = generateSalt(options)
  const clock = new RustClock({exposureDays: 30, secondsPerDay: 5, seed: 7})

  it('puts the hero near the centre and one neighbour 200–260 µm off, on the periodic tile', () => {
    const [hero, neighbour, ...others] = salt.large
    expect(Math.hypot(hero.x, hero.z)).toBeLessThan(15)
    expect(hero.edge).toBe(28)
    const distance = tileDistance(hero.x, hero.z, neighbour.x, neighbour.z)
    expect(distance).toBeGreaterThan(199)
    expect(distance).toBeLessThan(261)
    expect(others.length).toBe(0)
    for (const d of [...salt.large, ...salt.small, ...salt.micro]) {
      expect(Math.abs(d.x)).toBeLessThanOrEqual(TILE_SIZE / 2)
      expect(Math.abs(d.z)).toBeLessThanOrEqual(TILE_SIZE / 2)
    }
  })

  it('measures distances through the nearest periodic image', () => {
    expect(wrapTile(TILE_SIZE / 2 + 5)).toBeCloseTo(-TILE_SIZE / 2 + 5, 9)
    expect(tileDistance(-TILE_SIZE / 2 + 2, 0, TILE_SIZE / 2 - 3, 0)).toBeCloseTo(5, 9)
  })

  it('scatters small crystals by mass, at the start and every day', () => {
    const area = (TILE_SIZE * 1e-4) ** 2
    const initial = salt.small.filter(d => d.time < 0).reduce((sum, d) => sum + saltCubeMass(d.edge), 0)
    expect(initial * 1e6 / area).toBeCloseTo(20, 0)
    const day3 = salt.small.filter(d => d.time >= 3 * SECONDS_PER_DAY && d.time < 4 * SECONDS_PER_DAY)
    const chloride = day3.reduce((sum, d) => sum + saltCubeMass(d.edge), 0) * 35.453 / 58.443 * 1e3 / (area * 1e-4)
    expect(chloride).toBeCloseTo(60, -1)
    for (const d of salt.small) {
      expect(d.edge).toBeGreaterThanOrEqual(1)
      expect(d.edge).toBeLessThanOrEqual(12)
    }
  })

  it('rings the corroding drops with microdroplets that shrink outward and never overlap', () => {
    const hero = salt.micro.filter(m => m.parent === 0)
    expect(hero.length).toBeGreaterThan(200)
    const near = hero.filter(m => m.distance < 30).map(m => m.radius)
    const far = hero.filter(m => m.distance > 120).map(m => m.radius)
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
    expect(mean(near)).toBeGreaterThan(2 * mean(far))
    for (let i = 0; i < hero.length; i += 7) {
      for (let j = i + 1; j < hero.length; j++) {
        expect(tileDistance(hero[i].x, hero[i].z, hero[j].x, hero[j].z)).toBeGreaterThan(hero[i].radius + hero[j].radius)
      }
    }
  })

  it('grows, pins and dries the hero drop with the humidity, and spreads its film while wet', () => {
    const drops = new DropModel(clock, salt)
    expect(drops.stateAt(0).large[0].radius).toBe(0)
    const wet = clock.deliquescence[0] + 3600
    const hero = drops.stateAt(wet).large[0]
    expect(hero.wet).toBe(true)
    expect(hero.radius).toBeGreaterThan(CRITICAL_RADIUS)
    expect(hero.height).toBeGreaterThan(10)
    expect(hero.spread).toBeGreaterThan(30)
    const dry = clock.efflorescence[0] + 600
    expect(drops.stateAt(dry).large[0].radius).toBe(0)
    expect(drops.stateAt(dry).liquid).toBe(false)
    const small = drops.stateAt(wet)
    expect(small.smallRadius).toBeGreaterThan(1.5)
    expect(small.microScale).toBeGreaterThan(0.5)
  })
})
