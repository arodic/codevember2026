import { describe, expect, it } from 'vitest'
import {
  DELIQUESCENCE_RH, IRON_LOSS_RATE, NACL_SATURATION, RUST_PHASES, capAngle, capBaseRadius, capHeight, capVolumeFactor,
  dropVolume, ferrousHalfLife, filmPH, ironLoss, naclMolality, naclWaterActivity, oxygenLimitingCurrent, saltCubeMass,
  volumeRatio,
} from './RustScience.js'

describe('Rust science', () => {
  it('dissolves 1.16 mm of iron a year per A/m² (Faraday)', () => {
    expect(IRON_LOSS_RATE).toBeCloseTo(3.675e-5, 7)
    expect(ironLoss(1, 365.25 * 86400) / 1000).toBeCloseTo(1.16, 2)
  })

  it('gives the corrosion products their volume per volume of iron (Pilling–Bedworth)', () => {
    expect(volumeRatio(RUST_PHASES.magnetite)).toBeCloseTo(2.10, 2)
    expect(volumeRatio(RUST_PHASES.goethite)).toBeCloseTo(2.94, 2)
    expect(volumeRatio(RUST_PHASES.lepidocrocite)).toBeCloseTo(3.06, 2)
    for (const phase of [RUST_PHASES.akaganeite, RUST_PHASES.ferrihydrite]) {
      expect(volumeRatio(phase)).toBeGreaterThan(3.3)
      expect(volumeRatio(phase)).toBeLessThan(3.8)
    }
  })

  it('oxygenates Fe(II) at the Stumm–Lee rate: minutes at pH 7, hours at 6, seconds at 8', () => {
    expect(ferrousHalfLife(7) / 60).toBeCloseTo(4.1, 1)
    expect(ferrousHalfLife(6) / 3600).toBeCloseTo(6.9, 0)
    expect(ferrousHalfLife(8)).toBeCloseTo(2.5, 0)
  })

  it('limits the cathode by oxygen diffusing through the film', () => {
    expect(oxygenLimitingCurrent(10)).toBeCloseTo(19.3, 1)
    expect(oxygenLimitingCurrent(100)).toBeCloseTo(1.93, 2)
    expect(oxygenLimitingCurrent(10, 4)).toBeLessThan(oxygenLimitingCurrent(10) / 2)
  })

  it('deliquesces NaCl at 75.3% and keeps a drop supersaturated below it', () => {
    expect(naclWaterActivity(NACL_SATURATION)).toBeCloseTo(0.753, 3)
    expect(naclWaterActivity(1)).toBeCloseTo(0.967, 3)
    expect(naclMolality(DELIQUESCENCE_RH)).toBeCloseTo(NACL_SATURATION, 1)
    expect(naclMolality(0.85)).toBeCloseTo(4.03, 1)
    expect(naclMolality(0.6)).toBeGreaterThan(NACL_SATURATION)
    for (let rh = 0.46; rh < 0.99; rh += 0.01) expect(naclMolality(rh)).toBeGreaterThan(naclMolality(rh + 0.01))
  })

  it('grows the hero drop with the humidity, ~70 µm in radius at 85%', () => {
    const grams = saltCubeMass(28)
    expect(dropVolume(grams, 0.95) / dropVolume(grams, 0.76)).toBeGreaterThan(2.5)
    const radius = capBaseRadius(dropVolume(grams, 0.85), Math.PI / 4)
    expect(radius).toBeGreaterThan(60)
    expect(radius).toBeLessThan(100)
  })

  it('round-trips spherical caps', () => {
    for (const angle of [0.2, 0.5, 0.8, 1.2]) {
      const volume = capVolumeFactor(angle) * 50 ** 3
      expect(capBaseRadius(volume, angle)).toBeCloseTo(50, 6)
      expect(capAngle(volume, 50)).toBeCloseTo(angle, 4)
    }
    expect(capHeight(10, Math.PI / 2)).toBeCloseTo(10, 6)
  })

  it('reads the film pH from its alkalinity, ferrous hydrolysis and the air\'s CO₂', () => {
    expect(filmPH(0, 0)).toBeCloseTo(5.6, 1)
    expect(filmPH(1e-3, 0)).toBeCloseTo(8.2, 1)
    expect(filmPH(1, 0)).toBeCloseTo(10.56, 1)
    expect(filmPH(-1e-3, 0)).toBeCloseTo(3, 2)
    expect(filmPH(0, 0.1)).toBeCloseTo(5.2, 1)
    // continuous where the two regimes meet
    expect(Math.abs(filmPH(1.0001e-4, 0) - filmPH(0.9999e-4, 0))).toBeLessThan(0.01)
  })
})
