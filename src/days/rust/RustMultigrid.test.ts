import { describe, expect, it } from 'vitest'
import { multigridLevels, multigridReference } from './RustMultigrid.js'

/** Face coefficients from a cell conductance (harmonic mean, zero at dry faces), wrapping around the grid. */
function faces(size: number, conductance: (x: number, y: number) => number) {
  const aE = new Float64Array(size * size)
  const aN = new Float64Array(size * size)
  const harmonic = (a: number, b: number) => 2 * a * b / (a + b + 1e-30)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = conductance(x, y)
      aE[y * size + x] = harmonic(c, conductance((x + 1) % size, y))
      aN[y * size + x] = harmonic(c, conductance(x, (y + 1) % size))
    }
  }
  return {aE, aN}
}

function solve(size: number, conductance: (x: number, y: number) => number, b: (x: number, y: number) => number,
  f: (x: number, y: number) => number, cycles: number) {
  const {aE, aN} = faces(size, conductance)
  const B = new Float64Array(size * size)
  const F = new Float64Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      B[y * size + x] = b(x, y)
      F[y * size + x] = f(x, y)
    }
  }
  const {u, residuals} = multigridReference(size, aE, aN, B, F, new Float64Array(size * size), cycles)
  return {
    u,
    factor: (residuals[residuals.length - 1] / residuals[0]) ** (1 / (residuals.length - 1)),
    worst: Math.max(...residuals.map((r, i) => i === 0 ? 0 : r / residuals[i - 1])),
  }
}

describe('Rust multigrid (CPU reference of the GPU solver)', () => {
  it('lays the levels out from the finest down to one cell', () => {
    const levels = multigridLevels(512)
    expect(levels.map(l => l.size)).toEqual([512, 256, 128, 64, 32, 16, 8, 4, 2, 1])
    expect(levels[1].offset).toBe(512 * 512)
  })

  it('solves a weakly screened Poisson problem steadily', () => {
    const point = (x: number, y: number) => (x === 32 && y === 32 ? 1 : 0) - (x === 50 && y === 10 ? 0.5 : 0)
    const {factor, worst} = solve(64, () => 1, () => 1e-4, point, 12)
    expect(factor).toBeLessThan(0.75)
    expect(worst).toBeLessThan(1)
  })

  it('never diverges on a wet disc in a dry field, near-singular inside', () => {
    const wet = (x: number, y: number) => Math.hypot(x - 60, y - 70) < 40
    const {factor, worst} = solve(128, (x, y) => wet(x, y) ? 300 : 0, (x, y) => wet(x, y) ? 3e-4 : 1e-12,
      (x, y) => wet(x, y) ? 1e-4 * Math.sin(x * 0.3) * Math.cos(y * 0.2) + 1e-5 : 0, 12)
    expect(factor).toBeLessThan(0.82)
    expect(worst).toBeLessThan(1)
  })

  it('never diverges with a thin film around a thick drop (a thousandfold in conductance)', () => {
    const conductance = (x: number, y: number) => {
      const r = Math.hypot(x - 64, y - 64)
      return r < 30 ? 450 : r < 55 ? 0.4 : 0
    }
    const {factor, worst} = solve(128, conductance, (x, y) => conductance(x, y) > 0 ? 2e-4 : 1e-12,
      (x, y) => conductance(x, y) > 0 ? (Math.hypot(x - 64, y - 64) < 10 ? 5e-6 : -1e-6) : 0, 12)
    expect(factor).toBeLessThan(0.9)
    expect(worst).toBeLessThan(1)
  })

  it('wraps around: a drop across the corner of the tile solves as one, symmetric about the seam', () => {
    const n = 64
    // a wet disc centred on the corner (0, 0): its four quarters sit in the four corners of the grid
    const wet = (x: number, y: number) => Math.hypot(Math.min(x, n - x), Math.min(y, n - y)) < 14
    const source = (x: number, y: number) => x === 3 && y === 2 ? 1e-3 : x === n - 4 && y === n - 3 ? -1e-3 : 0
    const {u, factor, worst} = solve(n, (x, y) => wet(x, y) ? 50 : 0, (x, y) => wet(x, y) ? 1e-4 : 1e-12, source, 14)
    expect(factor).toBeLessThan(0.82)
    expect(worst).toBeLessThan(1)
    // the source and the sink are mirror images through the corner: so is the solution
    expect(u[2 * n + 3]).toBeGreaterThan(0)
    expect(u[2 * n + 3] + u[(n - 3) * n + n - 4]).toBeCloseTo(0, 6)
  })
})
