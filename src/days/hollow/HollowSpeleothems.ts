import {
  BufferAttribute, BufferGeometry, MathUtils, Vector3,
} from 'three/webgpu'
import { HollowField, createHollowRandom } from './HollowField.js'

export interface SpeleothemParams {
  stalactiteDensity: number
  stalagmiteDensity: number
  draperyScale: number
}

export interface HollowSpeleothemSet {
  geometry: BufferGeometry
  dripEmitters: Vector3[]
  stalactiteCount: number
  stalagmiteCount: number
  draperyCount: number
}

interface MeshAccumulator {
  positions: number[]
  normals: number[]
  zones: number[]
  collars: number[]
  indices: number[]
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
  return t * t * (3.0 - 2.0 * t)
}

function orthonormalBasis(normal: Vector3, t1: Vector3, t2: Vector3) {
  if (Math.abs(normal.y) < 0.92) {
    t1.set(0, 1, 0).cross(normal).normalize()
  } else {
    t1.set(1, 0, 0).cross(normal).normalize()
  }
  t2.crossVectors(normal, t1).normalize()
}

/**
 * Appends one fluted stalactite (hanging down) or pagoda stalagmite (growing up) whose basal sinter collar conforms
 * tangent to the host rock normal while its shaft bends quickly into true vertical gravity alignment.
 */
function appendDripstone(
  acc: MeshAccumulator,
  anchor: Vector3,
  hostNormal: Vector3,
  hanging: boolean,
  length: number,
  baseRadius: number,
  fluteCount: number,
  fluteDepth: number,
  ringFreq: number,
  phase: number,
  radialSegs: number,
  axialRings: number,
) {
  const baseVertex = acc.positions.length / 3
  const gravityDir = hanging ? -1.0 : 1.0

  const hostT1 = new Vector3()
  const hostT2 = new Vector3()
  orthonormalBasis(hostNormal, hostT1, hostT2)

  // World horizontal basis aligned consistently with `hostT1` azimuth so rings never twist across the root bend
  const horizT1 = new Vector3(hostT1.x, 0, hostT1.z)
  if (horizT1.lengthSq() < 1e-4) horizT1.set(1, 0, 0)
  else horizT1.normalize()
  const horizT2 = new Vector3(0, gravityDir, 0).cross(horizT1).normalize()

  const spineX = new Float32Array(axialRings + 1)
  const spineY = new Float32Array(axialRings + 1)
  const spineZ = new Float32Array(axialRings + 1)
  let cx = anchor.x - hostNormal.x * 0.035
  let cy = anchor.y - hostNormal.y * 0.035
  let cz = anchor.z - hostNormal.z * 0.035
  spineX[0] = cx
  spineY[0] = cy
  spineZ[0] = cz

  const ds = length / axialRings
  for (let r = 1; r <= axialRings; r++) {
    const t = r / axialRings
    // Root aligns with host normal at `t = 0`, bending into plumb vertical `(0, +-1, 0)` by `t = 0.22`
    const vertBlend = smoothstep(0.0, 0.22, t)
    let dx = MathUtils.lerp(hostNormal.x, 0.0, vertBlend)
    let dy = MathUtils.lerp(hostNormal.y, gravityDir, vertBlend)
    let dz = MathUtils.lerp(hostNormal.z, 0.0, vertBlend)
    const dLen = Math.hypot(dx, dy, dz) || 1.0
    dx /= dLen; dy /= dLen; dz /= dLen
    cx += dx * ds
    cy += dy * ds
    cz += dz * ds
    spineX[r] = cx
    spineY[r] = cy
    spineZ[r] = cz
  }

  const ringT1 = new Vector3()
  const ringT2 = new Vector3()

  for (let r = 0; r <= axialRings; r++) {
    const t = r / axialRings
    const collarBlend = 1.0 - smoothstep(0.0, 0.20, t)
    ringT1.lerpVectors(hostT1, horizT1, 1.0 - collarBlend).normalize()
    ringT2.lerpVectors(hostT2, horizT2, 1.0 - collarBlend).normalize()

    // Profile: flared sinter collar (`t < 0.18`), fluted/pagoda body, tapered icicle tip or rounded stalagmite dome
    const collarFlare = Math.pow(Math.max(0.0, 1.0 - t / 0.20), 2.2) * (hanging ? 1.15 : 1.35)
    let profile: number
    if (hanging) {
      const shaftTaper = Math.pow(Math.max(0.0, 1.0 - t), 0.68)
      const growthBulge = 1.0 + 0.09 * Math.sin(t * ringFreq + phase) * (1.0 - t)
      profile = baseRadius * (shaftTaper * growthBulge + collarFlare) + 0.008 * (1.0 - t * 0.5)
    } else {
      const pagoda = 1.0 + 0.15 * Math.sin(t * ringFreq + phase) * (1.0 - smoothstep(0.82, 1.0, t))
      const domeCap = Math.sqrt(Math.max(0.0, 1.0 - Math.pow(Math.max(0.0, (t - 0.72) / 0.28), 2.0)))
      const bodyTaper = (1.0 - 0.52 * t) * domeCap
      profile = baseRadius * (bodyTaper * pagoda + collarFlare)
    }

    const fluteEnvelope = smoothstep(0.06, 0.28, t) * (1.0 - smoothstep(0.82, 0.99, t))
    const wetness = hanging
      ? MathUtils.clamp(0.45 + 0.55 * smoothstep(0.45, 0.95, t), 0.0, 1.0)
      : MathUtils.clamp(0.55 + 0.35 * smoothstep(0.65, 1.0, t), 0.0, 1.0)

    for (let s = 0; s < radialSegs; s++) {
      const theta = (s / radialSegs) * Math.PI * 2
      const flute = 1.0 + fluteDepth * fluteEnvelope * Math.cos(fluteCount * theta + phase + t * 0.8)
      const rad = Math.max(0.004, profile * flute)

      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      const ox = ringT1.x * cosT + ringT2.x * sinT
      const oy = ringT1.y * cosT + ringT2.y * sinT
      const oz = ringT1.z * cosT + ringT2.z * sinT

      acc.positions.push(spineX[r] + ox * rad, spineY[r] + oy * rad, spineZ[r] + oz * rad)
      // Provisional outward normal; exact smoothed vertex normals are computed over appended triangles below
      acc.normals.push(ox, oy, oz)
      // `aZone`: `[strata, travertine (calcite), rimstone, wetness]`
      acc.zones.push(0.15, 0.92, 0.0, wetness)
      acc.collars.push(collarBlend)
    }
  }

  for (let r = 0; r < axialRings; r++) {
    const rowA = baseVertex + r * radialSegs
    const rowB = rowA + radialSegs
    for (let s = 0; s < radialSegs; s++) {
      const next = (s + 1) % radialSegs
      const a = rowA + s
      const b = rowA + next
      const d = rowB + s
      const e = rowB + next
      // `horizT2 = (0, gravityDir, 0) x horizT1`, so `(ringT1, ringT2, spineDir)` is right-handed for both `hanging` signs
      acc.indices.push(a, d, b, b, d, e)
    }
  }
}

/**
 * Appends a swept, folded, vertically fluted calcite wall drapery ("cave bacon" / organ-pipe curtain) with a
 * sawtooth icicle bottom fringe.
 */
function appendFlutedDrapery(
  acc: MeshAccumulator,
  field: HollowField,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  dropScale: number,
  thickness: number,
  seed: number,
) {
  const cols = 42
  const rows = 20
  const rand = createHollowRandom(seed)
  const foldPhase = rand() * Math.PI * 2
  const flutePhase = rand() * Math.PI * 2

  // Trace ceiling/overhang anchor curve
  const anchors: Vector3[] = []
  const inwardNormals: Vector3[] = []
  const tmpN = new Vector3()
  for (let c = 0; c <= cols; c++) {
    const u = c / cols
    const sWave = Math.sin(u * Math.PI * 2.5 + foldPhase) * 0.26 + Math.sin(u * Math.PI * 6.0 + flutePhase) * 0.08
    const perpX = -(endZ - startZ)
    const perpZ = endX - startX
    const pLen = Math.hypot(perpX, perpZ) || 1.0
    const wx = MathUtils.lerp(startX, endX, u) + (perpX / pLen) * sWave
    const wz = MathUtils.lerp(startZ, endZ, u) + (perpZ / pLen) * sWave
    const ceilY = field.findCeilingY(wx, wz) ?? field.ceilingHeightAt(wx, wz, true)
    anchors.push(new Vector3(wx, ceilY + 0.05, wz))
    field.sampleNormal(wx, ceilY, wz, tmpN, false, 0.08)
    inwardNormals.push(tmpN.clone())
  }

  // Build front and back curtain faces (`side = +1` and `side = -1`)
  const stride = cols + 1
  const frontBase = acc.positions.length / 3

  for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
    const sideSign = sideIdx === 0 ? 1.0 : -1.0
    for (let r = 0; r <= rows; r++) {
      const v = r / rows
      const collar = 1.0 - smoothstep(0.0, 0.18, v)
      for (let c = 0; c <= cols; c++) {
        const u = c / cols
        const anc = anchors[c]
        // Curtain tangent along `u`
        const prev = anchors[Math.max(0, c - 1)]
        const next = anchors[Math.min(cols, c + 1)]
        const tx = next.x - prev.x
        const tz = next.z - prev.z
        const tLen = Math.hypot(tx, tz) || 1.0
        const nx = -tz / tLen
        const nz = tx / tLen

        // Sawtooth organ-pipe bottom fringe (taller in center of curtain, serrated icicle tips)
        const archEnv = Math.sin(u * Math.PI) * 0.72 + 0.28
        const sawtooth = 0.68 + 0.32 * Math.pow(0.5 + 0.5 * Math.cos(u * 34.0 + flutePhase), 1.8)
          + 0.14 * Math.sin(u * 13.0 + foldPhase)
        const colDrop = dropScale * archEnv * sawtooth

        // Organ-pipe vertical flutes growing downward
        const fluteRib = Math.pow(Math.abs(Math.cos(u * 34.0 + flutePhase * 0.5)), 0.7)
        const sheetHalfThick = (thickness * (1.0 - 0.65 * v) * (0.55 + 0.75 * fluteRib) + 0.14 * collar * collar) * 0.5
        const fluteWaveOffset = 0.055 * Math.sin(u * 19.0 + foldPhase) * smoothstep(0.05, 0.5, v)

        const px = anc.x + nx * (fluteWaveOffset + sideSign * sheetHalfThick)
        const py = anc.y - v * colDrop
        const pz = anc.z + nz * (fluteWaveOffset + sideSign * sheetHalfThick)

        acc.positions.push(px, py, pz)
        acc.normals.push(nx * sideSign, -0.08, nz * sideSign)
        acc.zones.push(0.1, 0.96, 0.0, 0.55 + 0.4 * v)
        acc.collars.push(collar)
      }
    }
  }

  const backBase = frontBase + (rows + 1) * stride
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = frontBase + r * stride + c
      const b = a + 1
      const d = a + stride
      const e = d + 1
      acc.indices.push(a, d, b, b, d, e)

      const ba = backBase + r * stride + c
      const bb = ba + 1
      const bd = ba + stride
      const be = bd + 1
      acc.indices.push(ba, bb, bd, bb, be, bd)
    }
  }
  void inwardNormals
}

/** Recomputes smooth area-weighted vertex normals across the accumulated mesh. */
function finalizeSpeleothemGeometry(acc: MeshAccumulator): BufferGeometry {
  const vertCount = acc.positions.length / 3
  const positions = new Float32Array(acc.positions)
  const normals = new Float32Array(vertCount * 3)
  const idx = acc.indices

  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i] * 3
    const i1 = idx[i + 1] * 3
    const i2 = idx[i + 2] * 3
    const ax = positions[i1] - positions[i0]
    const ay = positions[i1 + 1] - positions[i0 + 1]
    const az = positions[i1 + 2] - positions[i0 + 2]
    const bx = positions[i2] - positions[i0]
    const by = positions[i2 + 1] - positions[i0 + 1]
    const bz = positions[i2 + 2] - positions[i0 + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz
    normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz
    normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz
  }

  for (let v = 0; v < vertCount; v++) {
    const o = v * 3
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2])
    if (len > 1e-8) {
      normals[o] /= len
      normals[o + 1] /= len
      normals[o + 2] /= len
    } else {
      normals[o + 1] = 1.0
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('aZone', new BufferAttribute(new Float32Array(acc.zones), 4))
  geometry.setAttribute('aCollar', new BufferAttribute(new Float32Array(acc.collars), 1))
  geometry.setIndex(idx)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Procedurally populates the cavern with rib-guided ceiling stalactites, active over-lake droplet emitters,
 * left-gallery pagoda stalagmites, and upper-right/left fluted calcite draperies in a single merged draw call.
 */
export function buildHollowSpeleothems(field: HollowField, params: SpeleothemParams): HollowSpeleothemSet {
  const rand = createHollowRandom(field.params.seed * 53 + 701)
  const wScale = field.params.cavernWidth
  const wl = field.params.waterLevel
  const acc: MeshAccumulator = {positions: [], normals: [], zones: [], collars: [], indices: []}
  const dripCandidates: {tip: Vector3; score: number}[] = []

  const anchor = new Vector3()
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

    field.sampleNormal(x, ceilY, z, normal, false, 0.08)
    if (normal.y > -0.36) continue

    // Strongly cluster stalactites along diagonal ceiling ribs and the `z ~ -12.5` skylight arch brow
    const ribWeight = field.ceilingRibMask(x, z)
    const leftWarmCurtainBoost = x < -1.2 && z > -10.5 && z < 2.0 ? 0.35 : 0.0
    const acceptProb = MathUtils.clamp(0.12 + 0.68 * ribWeight + leftWarmCurtainBoost, 0.0, 0.96)
    if (rand() > acceptProb) continue

    const floorY = field.findFloorY(x, z, ceilY - 0.4) ?? wl
    const clearance = ceilY - Math.max(floorY, wl)
    if (clearance < 1.1) continue

    const uPower = Math.pow(rand(), 1.55)
    const length = Math.min(clearance * 0.42, (0.32 + uPower * 1.38) * (0.75 + 0.35 * Math.min(ribWeight, 1.0)))
    const baseRadius = 0.042 + length * (0.058 + rand() * 0.032)
    const flutes = 6 + Math.floor(rand() * 5)

    anchor.set(x, ceilY, z)
    appendDripstone(
      acc,
      anchor,
      normal,
      true,
      length,
      baseRadius,
      flutes,
      0.16 + rand() * 0.12,
      14.0 + rand() * 10.0,
      rand() * Math.PI * 2,
      length > 0.95 ? 14 : 10,
      length > 0.95 ? 16 : 11,
    )
    stalactiteCount++

    // Track stalactite tips directly over open lake water for Phase 2 falling droplets & ripple rings
    const lakeDepth = field.lakeDepthAt(x, z)
    if (lakeDepth > 0.26 && z > -10.2 && z < 1.6 && Math.abs(x - field.spineX(z)) < 3.6 * wScale) {
      dripCandidates.push({
        tip: new Vector3(x, ceilY - length, z),
        score: lakeDepth + (z > -6.5 ? 0.45 : 0.0) + rand() * 0.35,
      })
    }
  }

  // 2. Warm-gallery pagoda stalagmites (opposite hero boulder side) + seeded bosses
  if (params.stalagmiteDensity > 0.02) {
    const gallerySide = -field.heroSide
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
      field.sampleNormal(wx, floorY, hz, normal, false, 0.08)
      if (normal.y < 0.45) normal.set(0, 1, 0)
      anchor.set(wx, floorY, hz)
      appendDripstone(
        acc,
        anchor,
        normal,
        false,
        hLen * MathUtils.clamp(params.stalagmiteDensity, 0.5, 1.4) * dens,
        hRad * dens,
        8,
        0.09,
        18.0,
        hx * 1.7,
        16,
        18,
      )
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
      field.sampleNormal(x, floorY, z, normal, false, 0.08)
      if (normal.y < 0.70) continue

      const ceilY = field.findCeilingY(x, z) ?? 7.0
      if (ceilY - floorY < 1.3) continue

      // Favor the warm gallery (opposite hero) and rear cascade margins
      const galleryBias = (x - field.spineX(z)) * gallerySide > 1.5 ? 0.78 : 0.34
      if (rand() > galleryBias) continue

      const len = 0.28 + Math.pow(rand(), 1.5) * 0.95
      const rad = 0.085 + len * (0.14 + rand() * 0.06)
      anchor.set(x, floorY, z)
      appendDripstone(
        acc,
        anchor,
        normal,
        false,
        len,
        rad,
        7 + Math.floor(rand() * 4),
        0.08 + rand() * 0.06,
        15.0 + rand() * 9.0,
        rand() * Math.PI * 2,
        12,
        13,
      )
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
      appendFlutedDrapery(acc, field, sx, sz, ex, ez, drop, thick, field.params.seed * 41 + i * 13)
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
    geometry: finalizeSpeleothemGeometry(acc),
    dripEmitters,
    stalactiteCount,
    stalagmiteCount,
    draperyCount,
  }
}
