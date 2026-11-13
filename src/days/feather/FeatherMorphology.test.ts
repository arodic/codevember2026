import { describe, it, expect } from 'vitest'
import { Color, Vector3 } from 'three/webgpu'
import {
  BARB_COUNT, RACHIS_NODES, REFERENCE_BG_BASE_HEX, REFERENCE_BG_GLOW_HEX, REFERENCE_BG_TOP_HEX, STEM_NODES,
  barbuleEnvelopeShape, buildFeatherMorphology, inverseNeutralToneMappingColor,
} from './FeatherMorphology.js'

function applyNeutralToneMappingChannel(v: number): number {
  if (v < 0.76) return v
  const d = 1 - 0.76
  return 1 - (d * d) / (v + d - 0.76)
}

function forwardNeutralToneMapping(linear: Color, exposure: number): Color {
  const c = linear.clone().multiplyScalar(exposure)
  const x = Math.min(c.r, c.g, c.b)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  c.r -= offset
  c.g -= offset
  c.b -= offset
  const peak = Math.max(c.r, c.g, c.b)
  if (peak < 0.76) return c
  const newPeak = applyNeutralToneMappingChannel(peak)
  c.multiplyScalar(newPeak / peak)
  return c
}

describe('FeatherMorphology & Thin-Lens Capture Optics', () => {
  it('welds all 128 barbs to the single central rachis with exact segment lengths and orthogonal Bishop frames', () => {
    const morph = buildFeatherMorphology(12, 1.0, 1.0)
    const pA = new Vector3()
    const pB = new Vector3()
    const sockA = new Vector3()
    const sockB = new Vector3()
    const sockPos = new Vector3()
    const normal = new Vector3()
    const tangent = new Vector3()

    for (let i = 0; i < BARB_COUNT; i++) {
      const rachisS = morph.barbRootInfo[i * 4 + 0]
      const barbLength = morph.barbRootInfo[i * 4 + 2]
      const expectedSegLen = barbLength / (STEM_NODES - 1)

      const scaled = rachisS * (RACHIS_NODES - 1)
      const r0 = Math.min(Math.floor(scaled), RACHIS_NODES - 2)
      const rf = scaled - r0
      sockA.fromArray(morph.rachisRestPos, r0 * 4)
      sockB.fromArray(morph.rachisRestPos, (r0 + 1) * 4)
      sockPos.lerpVectors(sockA, sockB, rf)

      const rootBase = i * STEM_NODES * 4
      pA.fromArray(morph.initialStemPos, rootBase)
      // Root must sit directly on the lateral socket of the rachis shaft (< 0.05 cm)
      expect(pA.distanceTo(sockPos)).toBeLessThan(0.05)

      for (let j = 0; j < STEM_NODES - 1; j++) {
        pA.fromArray(morph.initialStemPos, (i * STEM_NODES + j) * 4)
        pB.fromArray(morph.initialStemPos, (i * STEM_NODES + j + 1) * 4)
        expect(pA.distanceTo(pB)).toBeCloseTo(expectedSegLen, 5)
      }

      // Check Bishop normal unit length & orthogonality at mid-stem
      const mid = i * STEM_NODES + 10
      pA.fromArray(morph.initialStemPos, (mid - 1) * 4)
      pB.fromArray(morph.initialStemPos, (mid + 1) * 4)
      tangent.subVectors(pB, pA).normalize()
      normal.fromArray(morph.initialStemFrame, mid * 4)
      expect(normal.length()).toBeCloseTo(1, 5)
      expect(Math.abs(normal.dot(tangent))).toBeLessThan(1e-5)
    }
  })

  it('shapes the shared barbule envelope from zero at socket through a downy peak to a tapered lance tip', () => {
    expect(barbuleEnvelopeShape(0)).toBe(0)
    expect(barbuleEnvelopeShape(0.22)).toBeGreaterThan(0.75)
    expect(barbuleEnvelopeShape(1.0)).toBeLessThan(0.02)
  })

  it('inverts NeutralToneMapping accurately across the studio reference backdrop stops', () => {
    for (const hex of [REFERENCE_BG_BASE_HEX, REFERENCE_BG_TOP_HEX, REFERENCE_BG_GLOW_HEX]) {
      const target = new Color(hex)
      const preTone = inverseNeutralToneMappingColor(target, 1.0)
      const roundTrip = forwardNeutralToneMapping(preTone, 1.0)
      expect(roundTrip.r).toBeCloseTo(target.r, 5)
      expect(roundTrip.g).toBeCloseTo(target.g, 5)
      expect(roundTrip.b).toBeCloseTo(target.b, 5)
    }
  })
})
