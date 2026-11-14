import {MathUtils, Vector3} from 'three/webgpu'
import { HollowField, createHollowRandom } from './HollowField.js'
import {type HollowDraperyBody, type HollowDripstoneBody, draperyBody, dripstoneBody} from './HollowSculpt.js'

export interface SpeleothemParams {
  stalactiteDensity: number
  stalagmiteDensity: number
  draperyScale: number
}

export interface HollowSpeleothemSet {
  /** Stalactites, stalagmites and draperies: bodies of the cave's field (`HollowSculpt`). */
  bodies: (HollowDripstoneBody | HollowDraperyBody)[]
  dripEmitters: Vector3[]
  stalactiteCount: number
  stalagmiteCount: number
  draperyCount: number
}

/** Columns along a drapery's anchor curve. */
const DRAPERY_COLUMNS = 64

/**
 * A swept, folded, vertically fluted calcite wall drapery ("cave bacon" / organ-pipe curtain) with a sawtooth icicle
 * fringe, hanging from `start` to `end` (`xz`) under the ceiling.
 */
function flutedDrapery(
  field: HollowField,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  drop: number,
  thickness: number,
  seed: number,
): HollowDraperyBody {
  const rand = createHollowRandom(seed)
  const foldPhase = rand() * Math.PI * 2
  const flutePhase = rand() * Math.PI * 2
  const perpX = -(endZ - startZ)
  const perpZ = endX - startX
  const pLen = Math.hypot(perpX, perpZ) || 1.0
  // The anchor curve: folds across the line, a little inside the ceiling
  const curve = new Float32Array((DRAPERY_COLUMNS + 1) * 3)
  for (let c = 0; c <= DRAPERY_COLUMNS; c++) {
    const u = c / DRAPERY_COLUMNS
    const sWave = Math.sin(u * Math.PI * 2.5 + foldPhase) * 0.26 + Math.sin(u * Math.PI * 6.0 + flutePhase) * 0.08
    const wx = MathUtils.lerp(startX, endX, u) + (perpX / pLen) * sWave
    const wz = MathUtils.lerp(startZ, endZ, u) + (perpZ / pLen) * sWave
    const ceilY = field.findCeilingY(wx, wz) ?? field.ceilingHeightAt(wx, wz, true)
    curve.set([wx, ceilY + 0.05, wz], c * 3)
  }
  return draperyBody({curve, drop, thickness, foldPhase, flutePhase})
}

/**
 * Procedurally populates the cavern with rib-guided ceiling stalactites, active over-lake droplet emitters,
 * left-gallery pagoda stalagmites and upper-right/left fluted calcite draperies: bodies of the cave's field.
 */
export function buildHollowSpeleothems(field: HollowField, params: SpeleothemParams): HollowSpeleothemSet {
  const rand = createHollowRandom(field.params.seed * 53 + 701)
  const wScale = field.widthScale
  const wl = field.params.waterLevel
  const bodies: (HollowDripstoneBody | HollowDraperyBody)[] = []
  const dripCandidates: {tip: Vector3; score: number}[] = []

  const normal = new Vector3()

  let stalactiteCount = 0
  let stalagmiteCount = 0
  let draperyCount = 0

  const dens = field.featureDensity
  const pose = field.cinemaPose

  // 1. Rib-guided ceiling stalactites & skylight arch curtain silhouettes
  const targetStalactites = Math.round(310 * Math.max(0.0, params.stalactiteDensity) * dens)
  let attempts = 0
  while (stalactiteCount < targetStalactites && attempts < targetStalactites * 12) {
    attempts++
    const z = -19.0 + rand() * 23.2
    const x = field.spineX(z) + (-6.2 + rand() * 12.4) * wScale

    // Keep immediate foreground lens cone clear so no giant stalactite blocks the camera lens
    if (z > pose.startZ - 3.2 && Math.abs(x - pose.startX) < 2.4) continue

    const ceilY = field.findCeilingY(x, z)
    if (ceilY === null || ceilY < wl + 1.8 || ceilY > 8.8) continue

    field.sampleNormal(x, ceilY, z, normal, 0.08)
    if (normal.y > -0.36) continue

    // Strongly cluster stalactites along diagonal ceiling ribs and the `z ~ -12.5` skylight arch brow
    const ribWeight = field.ceilingRibMask(x, z)
    const galleryCurtainBoost = (x - field.spineX(z)) * field.gallerySide > 1.2 && z > -10.5 && z < 2.0 ? 0.35 : 0.0
    const acceptProb = MathUtils.clamp(0.12 + 0.68 * ribWeight + galleryCurtainBoost, 0.0, 0.96)
    if (rand() > acceptProb) continue

    const floorY = field.findFloorY(x, z, ceilY - 0.4) ?? wl
    const clearance = ceilY - Math.max(floorY, wl)
    if (clearance < 1.1) continue

    const uPower = Math.pow(rand(), 1.55)
    const length = Math.min(clearance * 0.42, (0.32 + uPower * 1.38) * (0.75 + 0.35 * Math.min(ribWeight, 1.0)))
    const baseRadius = 0.042 + length * (0.058 + rand() * 0.032)
    const flutes = 6 + Math.floor(rand() * 5)

    bodies.push(dripstoneBody({
      anchor: new Vector3(x, ceilY, z),
      hostNormal: normal.clone(),
      hanging: true,
      length,
      baseRadius,
      flutes,
      fluteDepth: 0.16 + rand() * 0.12,
      ringFreq: 14.0 + rand() * 10.0,
      phase: rand() * Math.PI * 2,
    }))
    stalactiteCount++

    // Track stalactite tips directly over open lake water for Phase 2 falling droplets & ripple rings
    const lakeDepth = field.lakeDepthAt(x, z)
    if (lakeDepth > 0.26 && Math.abs(x - field.spineX(z)) < 3.6 * wScale) {
      dripCandidates.push({
        tip: new Vector3(x, ceilY - length, z),
        score: lakeDepth + (z > -6.5 ? 0.45 : 0.0) + rand() * 0.35,
      })
    }
  }

  // 2. Warm-gallery pagoda stalagmites (opposite hero boulder side) + seeded bosses
  if (params.stalagmiteDensity > 0.02) {
    const gallerySide = field.gallerySide
    const heroShelfPresets: [number, number, number, number][] = [
      [5.05, -5.65, 1.62, 0.34],
      [4.35, -6.45, 0.92, 0.24],
      [5.55, -4.45, 0.78, 0.21],
      [3.75, -7.85, 0.68, 0.19],
      [2.85, -8.45, 0.56, 0.17],
    ]
    for (const [hx, hz, hLen, hRad] of heroShelfPresets) {
      const wx = field.spineX(hz) + gallerySide * hx * wScale * (0.75 + rand() * 0.35)
      const floorY = field.findFloorY(wx, hz, 3.8)
      if (floorY === null || floorY < wl + 0.3) continue
      field.sampleNormal(wx, floorY, hz, normal, 0.08)
      if (normal.y < 0.45) normal.set(0, 1, 0)
      bodies.push(dripstoneBody({
        anchor: new Vector3(wx, floorY, hz),
        hostNormal: normal.clone(),
        hanging: false,
        length: hLen * MathUtils.clamp(params.stalagmiteDensity, 0.5, 1.4) * dens,
        baseRadius: hRad * dens,
        flutes: 8,
        fluteDepth: 0.09,
        ringFreq: 18.0,
        phase: hx * 1.7,
      }))
      stalagmiteCount++
    }

    const targetStalagmites = Math.round(34 * Math.max(0.0, params.stalagmiteDensity) * dens)
    let mAttempts = 0
    while (stalagmiteCount < targetStalagmites + heroShelfPresets.length && mAttempts < targetStalagmites * 16) {
      mAttempts++
      const z = -19.5 + rand() * 20.5
      const x = field.spineX(z) + (-6.2 + rand() * 12.4) * wScale
      if (field.rimstoneCoord(x, z) < 1.25) continue
      if (z > pose.startZ - 4.5 && Math.abs(x - pose.startX) < 2.8) continue

      const floorY = field.findFloorY(x, z, 3.8)
      if (floorY === null || floorY < wl + 0.15 || floorY > wl + 3.2) continue
      field.sampleNormal(x, floorY, z, normal, 0.08)
      if (normal.y < 0.70) continue

      const ceilY = field.findCeilingY(x, z) ?? 7.0
      if (ceilY - floorY < 1.3) continue

      // Favor the warm gallery (opposite hero) and rear cascade margins
      const galleryBias = (x - field.spineX(z)) * gallerySide > 1.5 ? 0.78 : 0.34
      if (rand() > galleryBias) continue

      const len = 0.28 + Math.pow(rand(), 1.5) * 0.95
      const rad = 0.085 + len * (0.14 + rand() * 0.06)
      bodies.push(dripstoneBody({
        anchor: new Vector3(x, floorY, z),
        hostNormal: normal.clone(),
        hanging: false,
        length: len,
        baseRadius: rad,
        flutes: 7 + Math.floor(rand() * 4),
        fluteDepth: 0.08 + rand() * 0.06,
        ringFreq: 15.0 + rand() * 9.0,
        phase: rand() * Math.PI * 2,
      }))
      stalagmiteCount++
    }
  }

  // 3. Fluted wall draperies / organ-pipe curtains (hero-side curtains + warm-gallery + skylight brow)
  if (params.draperyScale > 0.05) {
    const scale = params.draperyScale * dens
    const side = field.heroSide
    const skyZ = field.skylightCenter.z + 4.5
    const curtainSpecs: [number, number, number, number, number, number][] = [
      // Hero-side organ-pipe curtains
      [field.spineX(-0.85) + side * 4.25 * wScale, -0.85, field.spineX(-4.65) + side * 3.65 * wScale, -4.65, 2.35 * scale, 0.22],
      [field.spineX(-2.35) + side * 4.65 * wScale, -2.35, field.spineX(-6.15) + side * 3.95 * wScale, -6.15, 1.85 * scale, 0.18],
      // Warm-gallery draperies catching behind-camera fire spill
      [field.spineX(0.65) - side * 4.55 * wScale, 0.65, field.spineX(-3.15) - side * 2.65 * wScale, -3.15, 1.65 * scale, 0.17],
      [field.spineX(-2.45) - side * 5.25 * wScale, -2.45, field.spineX(-6.25) - side * 3.35 * wScale, -6.25, 1.55 * scale, 0.16],
      // Skylight arch rim silhouette curtains
      [field.skylightCenter.x - 2.4 * wScale, skyZ - 0.8, field.skylightCenter.x + 0.4 * wScale, skyZ - 1.7, 1.35 * scale, 0.14],
      [field.skylightCenter.x + 0.6 * wScale, skyZ - 1.2, field.skylightCenter.x + 2.8 * wScale, skyZ + 0.6, 1.45 * scale, 0.15],
    ]
    curtainSpecs.forEach(([sx, sz, ex, ez, drop, thick], i) => {
      bodies.push(flutedDrapery(field, sx, sz, ex, ez, drop, thick, field.params.seed * 41 + i * 13))
      draperyCount++
    })
  }

  // Select well-spaced active droplet emitters over the lake (`~12` stalactite tips)
  dripCandidates.sort((a, b) => b.score - a.score)
  const dripEmitters: Vector3[] = []
  for (const cand of dripCandidates) {
    if (dripEmitters.length >= 12) break
    const tooClose = dripEmitters.some(existing => existing.distanceToSquared(cand.tip) < 1.35 * 1.35)
    if (!tooClose) dripEmitters.push(cand.tip)
  }

  return {
    bodies,
    dripEmitters,
    stalactiteCount,
    stalagmiteCount,
    draperyCount,
  }
}
