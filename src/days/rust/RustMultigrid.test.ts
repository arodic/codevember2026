import { describe, expect, it } from 'vitest'
import { multigridLevels, multigridReference } from './RustMultigrid.js'

/** Face coefficients from a cell conductance (harmonic mean, zero across the edge and dry faces). */
function faces(size: number, conductance: (x: number, y: number) => number) {
  const aE = new Float64Array(size * size)
  const aN = new Float64Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = conductance(x, y)
      const harmonic = (a: number, b: number) => 2 * a * b / (a + b + 1e-30)
      if (x < size - 1) aE[y * size + x] = harmonic(c, conductance(x + 1, y))
      if (y < size - 1) aN[y * size + x] = harmonic(c, conductance(x, y + 1))
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
  const {residuals} = multigridReference(size, aE, aN, B, F, new Float64Array(size * size), cycles)
  return {
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
})
