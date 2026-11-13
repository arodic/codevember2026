import { describe, expect, it } from 'vitest'
import { RustClock, START_RATE, START_RH } from './RustClock.js'
import { DELIQUESCENCE_RH, EFFLORESCENCE_RH, SECONDS_PER_DAY } from './RustScience.js'

describe('Rust clock', () => {
  const clock = new RustClock({exposureDays: 30, secondsPerDay: 5, seed: 7})

  it('lasts about three minutes for 30 days at 5 s a day', () => {
    expect(clock.duration).toBeGreaterThan(175)
    expect(clock.duration).toBeLessThan(192)
  })

  it('maps playback onto exposure monotonically, and back', () => {
    let previous = -1
    for (let tau = 0; tau <= clock.duration; tau += 0.37) {
      const t = clock.exposureAt(tau)
      expect(t).toBeGreaterThan(previous)
      expect(clock.timelineAt(t)).toBeCloseTo(tau, 6)
      previous = t
    }
    expect(clock.exposureAt(clock.duration) / SECONDS_PER_DAY).toBeCloseTo(30, 6)
  })

  it('starts at a minute a second and ends at a day per 5 s', () => {
    expect((clock.exposureAt(0.01) - clock.exposureAt(0)) / 0.01).toBeCloseTo(START_RATE, 0)
    const end = clock.duration
    expect((clock.exposureAt(end) - clock.exposureAt(end - 0.01)) / 0.01).toBeCloseTo(SECONDS_PER_DAY / 5, 0)
  })

  it('changes only the pace with secondsPerDay', () => {
    const fast = new RustClock({exposureDays: 30, secondsPerDay: 2, seed: 7})
    expect(fast.totalExposure).toBe(clock.totalExposure)
    expect(fast.duration).toBeLessThan(clock.duration)
    for (let t = 0; t < clock.totalExposure; t += 7777) expect(fast.humidityAt(t)).toBe(clock.humidityAt(t))
  })

  it('humidifies the dry specimen and deliquesces its salt within the first hour', () => {
    expect(clock.humidityAt(0)).toBeCloseTo(START_RH, 6)
    expect(clock.saltLiquid(0)).toBe(false)
    const first = clock.deliquescence[0]
    expect(first).toBeGreaterThan(600)
    expect(first).toBeLessThan(3600)
    expect(clock.humidityAt(first)).toBeCloseTo(DELIQUESCENCE_RH, 2)
    expect(clock.saltLiquid(first + 1)).toBe(true)
  })

  it('keeps the first afternoon wet and dries some later ones below 45%', () => {
    expect(clock.efflorescence[0]).toBeGreaterThan(1.5 * SECONDS_PER_DAY)
    expect(clock.efflorescence.length).toBeGreaterThanOrEqual(3)
    for (const t of clock.efflorescence) expect(clock.humidityAt(t)).toBeCloseTo(EFFLORESCENCE_RH, 2)
  })

  it('keeps the drops liquid between 45% and 75% until they effloresce (hysteresis)', () => {
    const start = clock.deliquescence[0]
    const end = clock.efflorescence[0]
    let between = 0
    for (let t = start + 60; t < end; t += 60) {
      const rh = clock.humidityAt(t)
      if (rh > EFFLORESCENCE_RH && rh < DELIQUESCENCE_RH) {
        expect(clock.saltLiquid(t)).toBe(true)
        between++
      }
    }
    expect(between).toBeGreaterThan(10)
    expect(clock.saltLiquid(end + 60)).toBe(false)
  })

  it('steps onto every snapshot, a few thousand steps in all', () => {
    const times = clock.snapshotTimes
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBe(clock.totalExposure)
    let t = 0
    let steps = 0
    const hit = new Set<number>([0])
    while (t < clock.totalExposure && steps < 20000) {
      t += clock.stepSize(t)
      if (times.includes(t)) hit.add(t)
      steps++
    }
    expect(t).toBe(clock.totalExposure)
    expect(hit.size).toBe(times.length)
    expect(steps).toBeLessThan(8000)
  })

  it('spreads each day of growth between its snapshots', () => {
    const a = SECONDS_PER_DAY * 3
    const b = SECONDS_PER_DAY * 4
    let previous = 0
    for (let t = a; t <= b; t += 3600) {
      const progress = clock.growthProgress(a, b, t)
      expect(progress).toBeGreaterThanOrEqual(previous)
      previous = progress
    }
    expect(clock.growthProgress(a, b, a)).toBe(0)
    expect(clock.growthProgress(a, b, b)).toBeCloseTo(1, 6)
  })
})
