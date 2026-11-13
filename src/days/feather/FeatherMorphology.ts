import { Box3, Color, MathUtils, SRGBColorSpace, Vector3 } from 'three/webgpu'

/** Nodes along the single central rachis shaft (`s_r ∈ [0, 1]`). */
export const RACHIS_NODES = 32
/** Primary barbs (`rami`) branching off the rachis; power of two for single-workgroup GPU parallel sorting. */
export const BARB_COUNT = 128
/** Simulation nodes along each barb stem (`s ∈ [0, 1]`). */
export const STEM_NODES = 20
export const TOTAL_STEM_NODES = BARB_COUNT * STEM_NODES
/** Smooth cubic B-spline subdivisions rendered per barb shaft (`C^2` curvature at macro magnification). */
export const STEM_RENDER_SEGMENTS = 64
/** Arc-length-preserving curved segments rendered per microscopic barbule. */
export const BARBULE_SEGMENTS = 4
/** Contiguous barbules simulated together in one GPU workgroup along a single barb vane. */
export const WORKGROUP_BARBULES = 128
export const DESKTOP_BARBULES_PER_SIDE = 128
export const MOBILE_BARBULES_PER_SIDE = 128

/** Measured sRGB reference stops from the macro studio photograph. */
export const REFERENCE_BG_BASE_HEX = '#46658f'
export const REFERENCE_BG_TOP_HEX = '#4b6993'
export const REFERENCE_BG_GLOW_HEX = '#85a0c2'

export const MACRO_CAMERA_POSE = {
  position: new Vector3(0.42, -0.18, 5.65),
  target: new Vector3(0.42, -0.18, 0.0),
  fov: 18.0,
}

export const FULL_FEATHER_CAMERA_POSE = {
  position: new Vector3(0.65, -2.05, 16.2),
  target: new Vector3(0.65, -1.95, 0.0),
  fov: 22.0,
}

/** Deterministic 32-bit PRNG (Mulberry32). */
export function createFeatherRandom(seed: number): () => number {
  let state = (Math.imul(Math.floor(seed) | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Normalized plumulaceous barbule length envelope along a barb stem `s ∈ [0, 1]`:
 * rises smoothly from `0` at the rachis socket (`s = 0`), swells through the downy mid-vane,
 * and tapers into a delicate lance point at the barb tip (`s = 1`).
 * Shared identically by Layer 1 envelope collisions and Layer 2 procedural barbule geometry.
 */
export function barbuleEnvelopeShape(s: number): number {
  const clamped = MathUtils.clamp(s, 0, 1)
  const rootRamp = MathUtils.smoothstep(clamped, 0.01, 0.12)
  const tipLance = 1 - MathUtils.smoothstep(clamped, 0.89, 1.0)
  const bodyTaper = Math.pow(Math.max(1 - 0.76 * Math.pow(clamped, 1.28), 0.05), 0.68)
  return rootRamp * bodyTaper * tipLance
}

/** Mean branching angle (radians from the barb tangent toward the tip) along `s ∈ [0, 1]`. */
export function barbuleMeanBranchAngle(s: number): number {
  const clamped = MathUtils.clamp(s, 0, 1)
  return MathUtils.degToRad(MathUtils.lerp(36, 18, Math.pow(clamped, 0.85)))
}

/**
 * Exact analytical inverse of Three's `neutralToneMapping(color, exposure)` over `[0, 0.76)` linear sRGB,
 * so studio backdrop colors survive exposure and tone mapping with zero hue or luminance drift.
 */
export function inverseNeutralToneMappingChannel(targetLinear: number, exposure: number): number {
  const y = MathUtils.clamp(targetLinear, 0, 0.99)
  if (y < 0.76) return y / Math.max(exposure, 1e-6)
  const start = 0.76
  const d = 1 - start
  const denom = Math.max(1 - y, 1e-4)
  const peak = (d * d) / denom - (d - start)
  return peak / Math.max(exposure, 1e-6)
}

export function inverseNeutralToneMappingColor(srgbColor: Color, exposure: number, target = new Color()): Color {
  const r = Math.max(srgbColor.r, 0)
  const g = Math.max(srgbColor.g, 0)
  const b = Math.max(srgbColor.b, 0)
  const yMin = Math.min(r, g, b)
  const offset = yMin < 0.04 ? 0.4 * Math.sqrt(Math.max(yMin, 0)) - yMin : 0.04
  const peak = Math.max(r, g, b)
  if (peak < 0.76 - 1e-5) {
    return target.setRGB(
      (r + offset) / Math.max(exposure, 1e-6),
      (g + offset) / Math.max(exposure, 1e-6),
      (b + offset) / Math.max(exposure, 1e-6),
    )
  }
  const scale = inverseNeutralToneMappingChannel(peak, 1) / Math.max(peak, 1e-6)
  return target.setRGB(
    (r * scale + offset) / Math.max(exposure, 1e-6),
    (g * scale + offset) / Math.max(exposure, 1e-6),
    (b * scale + offset) / Math.max(exposure, 1e-6),
  )
}

export function srgbHexToLinear(hex: string, target = new Color()): Color {
  return target.set(hex).convertSRGBToLinear()
}

export function colorFromSrgb(r: number, g: number, b: number): Color {
  return new Color().setRGB(r, g, b, SRGBColorSpace)
}

export interface FeatherMorphologyData {
  rachisRestPos: Float32Array
  rachisRestNormal: Float32Array
  barbRootInfo: Float32Array
  barbStyleInfo: Float32Array
  stemLocalRest: Float32Array
  initialStemPos: Float32Array
  initialStemVel: Float32Array
  initialStemFrame: Float32Array
  volumeBounds: Box3
}

const _t = new Vector3()
const _n = new Vector3()
const _b = new Vector3()
const _p = new Vector3()
const _prevP = new Vector3()
const _segDir = new Vector3()
const _curN = new Vector3()
const _rotAxis = new Vector3()

/**
 * Evaluates the rest central rachis curve (`s_r ∈ [0, 1]`, `1 unit = 1 cm`).
 * Rises from the calamus quill below the lower-right (`x = +2.35, y = -5.65`) up-and-left into the soft-focus
 * lower plume heart (`x = +0.58, y = -1.22, z = -0.32`), so in `Macro` view all 128 barbs fan organically upward
 * and up-left out of the lower downy cloud (matching the reference photo), while `Full Feather` reveals the whole shaft!
 */
function sampleRachisCurve(s: number, curvatureScale: number, target: Vector3): Vector3 {
  const u = MathUtils.clamp(s, 0, 1)
  const x = 1.95 - 1.28 * Math.pow(u, 1.05) - 0.14 * curvatureScale * Math.sin(u * Math.PI * 0.85)
  const y = -5.45 + 4.18 * Math.pow(u, 0.94)
  const z = -0.46 + 0.20 * Math.sin(u * Math.PI * 0.82)
  return target.set(x, y, z)
}

/**
 * Generates the connected 3-level plumulaceous feather rest state:
 * one central rachis, `128` arched barbs welded to sockets along it, and exact barbule envelope radii `R_env(i, s)`.
 */
export function buildFeatherMorphology(seed = 12, fluffiness = 1.0, barbCurvature = 1.0): FeatherMorphologyData {
  const random = createFeatherRandom(seed)

  const rachisRestPos = new Float32Array(RACHIS_NODES * 4)
  const rachisRestNormal = new Float32Array(RACHIS_NODES * 4)

  const rachisPositions: Vector3[] = []
  const rachisTangents: Vector3[] = []
  const rachisNormals: Vector3[] = []

  for (let r = 0; r < RACHIS_NODES; r++) {
    const s = r / (RACHIS_NODES - 1)
    const pos = sampleRachisCurve(s, barbCurvature, new Vector3())
    rachisPositions.push(pos)
    const radius = MathUtils.lerp(0.048, 0.0038, Math.pow(s, 0.82))
    const stiffness = MathUtils.lerp(1.0, 0.18, Math.pow(s, 1.15))
    rachisRestPos[r * 4 + 0] = pos.x
    rachisRestPos[r * 4 + 1] = pos.y
    rachisRestPos[r * 4 + 2] = pos.z
    rachisRestPos[r * 4 + 3] = radius
    rachisRestNormal[r * 4 + 3] = stiffness
  }

  for (let r = 0; r < RACHIS_NODES; r++) {
    const prev = rachisPositions[Math.max(0, r - 1)]
    const next = rachisPositions[Math.min(RACHIS_NODES - 1, r + 1)]
    const tangent = new Vector3().subVectors(next, prev).normalize()
    let normal: Vector3
    if (r === 0) {
      normal = new Vector3(0.05, 0.08, 1.0)
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize()
    } else {
      normal = rachisNormals[r - 1].clone()
      const prevT = rachisTangents[r - 1]
      _rotAxis.crossVectors(prevT, tangent)
      const sinAngle = _rotAxis.length()
      if (sinAngle > 1e-6) {
        _rotAxis.divideScalar(sinAngle)
        normal.applyAxisAngle(_rotAxis, Math.atan2(sinAngle, prevT.dot(tangent)))
      }
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize()
    }
    rachisTangents.push(tangent)
    rachisNormals.push(normal)
    rachisRestNormal[r * 4 + 0] = normal.x
    rachisRestNormal[r * 4 + 1] = normal.y
    rachisRestNormal[r * 4 + 2] = normal.z
  }

  const interpolateRachis = (s: number) => {
    const scaled = MathUtils.clamp(s, 0, 1) * (RACHIS_NODES - 1)
    const i0 = Math.min(Math.floor(scaled), RACHIS_NODES - 2)
    const f = scaled - i0
    _p.lerpVectors(rachisPositions[i0], rachisPositions[i0 + 1], f)
    _t.lerpVectors(rachisTangents[i0], rachisTangents[i0 + 1], f).normalize()
    _n.lerpVectors(rachisNormals[i0], rachisNormals[i0 + 1], f)
    _n.addScaledVector(_t, -_n.dot(_t)).normalize()
    _b.crossVectors(_t, _n).normalize()
  }

  const barbRootInfo = new Float32Array(BARB_COUNT * 4)
  const barbStyleInfo = new Float32Array(BARB_COUNT * 4)
  const stemLocalRest = new Float32Array(TOTAL_STEM_NODES * 4)
  const initialStemPos = new Float32Array(TOTAL_STEM_NODES * 4)
  const initialStemVel = new Float32Array(TOTAL_STEM_NODES * 4)
  const initialStemFrame = new Float32Array(TOTAL_STEM_NODES * 4)

  const volumeBounds = new Box3(new Vector3(Infinity, Infinity, Infinity), new Vector3(-Infinity, -Infinity, -Infinity))

  for (let i = 0; i < BARB_COUNT; i++) {
    const u = (i + 0.5) / BARB_COUNT
    // Distribute sockets along rachis from lower downy base (0.12) up to distal crown apex (0.996)
    const rachisS = MathUtils.clamp(0.12 + 0.876 * (1 - Math.pow(1 - u, 1.38)) + (random() - 0.5) * 0.008, 0.10, 0.996)
    interpolateRachis(rachisS)

    const side = i % 2 === 0 ? 1 : -1
    const crownFactor = MathUtils.smoothstep(rachisS, 0.45, 0.98)

    // Depth stratification matching macro photography:
    // - ~20% hero sharp focal-plane barbs (z ≈ 0) fanning cleanly across the upper crown
    // - ~52% background creamy out-of-focus plume cloud (z ∈ [-0.30, -1.65])
    // - ~28% foreground out-of-focus wisps (z ∈ [+0.35, +1.35]), weighted toward lower barbs so upper hero tips stay crisp!
    const tierRoll = random()
    let targetPlaneZ: number
    let isHeroFocal = false
    if (crownFactor > 0.36 && tierRoll < 0.25) {
      isHeroFocal = true
      targetPlaneZ = (random() - 0.5) * 0.09
    } else if (tierRoll < (crownFactor > 0.55 ? 0.42 : 0.56)) {
      targetPlaneZ = 0.34 + Math.pow(random(), 0.9) * (crownFactor > 0.6 ? 0.65 : 1.05)
    } else {
      targetPlaneZ = -0.32 - Math.pow(random(), 0.82) * 1.35
    }

    // Silhouette calibration against the reference photograph (`MACRO_CAMERA_POSE` looks at `(0.32, -0.02)`, top edge `y ≈ +0.98`):
    // - Right-vane (+1) barbs fan across center-right to far-right (`x = -0.1 .. +2.15`), nearly vertical on far right (`-6°..+14°`),
    //   arching gently up-and-left toward `+28°` in the center crown, with tallest tips reaching `y ≈ +0.62..+0.78` (leaving clean top sky!).
    // - Left-vane (-1) barbs fan diagonally up-left (`+22°..+58°`), keeping top-left sky open (`x < -1.1, y > 0` clear) while
    //   sending graceful diagonal wisps into the lower-left quadrant (`y < -0.15`)!
    let baseAngleFromVertical: number
    let barbLength: number
    if (side > 0) {
      // Right-vane (+1) sweeps broadly from right-fanning (-32 deg, positive +X into cols 5..7!) up through vertical (0 deg)
      // to gentle leftward crown curves (+22 deg in cols 3..5), matching the full width of the reference plume!
      const spreadSlot = ((i >> 1) % 20) / 19
      baseAngleFromVertical = MathUtils.degToRad(
        MathUtils.lerp(-32, 22, spreadSlot) + (random() - 0.5) * 9,
      )
      const crownHeight = MathUtils.smoothstep(rachisS, 0.34, 0.88) * (1 - 0.14 * MathUtils.smoothstep(rachisS, 0.92, 1.0))
      const edgeScale = 0.86 + 0.22 * Math.sin(spreadSlot * Math.PI)
      barbLength = (1.68 + 1.05 * crownHeight + (random() - 0.45) * 0.45) * edgeScale
    } else {
      const spreadSlot = ((i >> 1) % 20) / 19
      // Left-vane (-1) fans from center-left (+12 deg) across to diagonal lower-left (+56 deg)
      baseAngleFromVertical = MathUtils.degToRad(
        MathUtils.lerp(12, 40, spreadSlot) + (1 - crownFactor) * 18 + (random() - 0.5) * 9,
      )
      const leftReach = MathUtils.smoothstep(rachisS, 0.26, 0.92)
      barbLength = 1.58 + 1.02 * leftReach + (random() - 0.45) * 0.44
    }

    if (isHeroFocal) {
      barbLength *= 1.08
    }

    // Barbule length: 0.26..0.41 cm (2.6..4.1 mm) for lush snowy overlap in the lower heart & airy needle tips above!
    const maxBarbuleLen = (0.26 + 0.14 * random() + 0.06 * (1 - crownFactor)) * fluffiness
    const baseCoreRadius = MathUtils.lerp(0.0031, 0.0021, crownFactor) * (0.9 + 0.2 * random())
    const dihedralBias = (random() - 0.5) * 0.38
    const stiffnessScale = MathUtils.lerp(0.84, 1.20, random())
    const seedHash = random()

    barbRootInfo[i * 4 + 0] = rachisS
    barbRootInfo[i * 4 + 1] = maxBarbuleLen
    barbRootInfo[i * 4 + 2] = barbLength
    barbRootInfo[i * 4 + 3] = baseCoreRadius

    barbStyleInfo[i * 4 + 0] = side
    barbStyleInfo[i * 4 + 1] = dihedralBias
    barbStyleInfo[i * 4 + 2] = stiffnessScale
    barbStyleInfo[i * 4 + 3] = seedHash

    // Natural graceful leftward/upward arch along s ∈ [0, 1]
    const archLeft = (0.14 + 0.24 * random()) * barbCurvature * (side > 0 ? 1.05 : 0.58)
    const sWave = (random() - 0.5) * 0.07 * barbCurvature

    const rootWorld = _p.clone()
    const rachisRadiusAtSocket = MathUtils.lerp(0.048, 0.0038, Math.pow(rachisS, 0.82))
    rootWorld.addScaledVector(_b, side * rachisRadiusAtSocket * 0.78)

    const deltaZ = targetPlaneZ - rootWorld.z
    const worldNodes: Vector3[] = []

    for (let j = 0; j < STEM_NODES; j++) {
      const s = j / (STEM_NODES - 1)
      if (j === 0) {
        worldNodes.push(rootWorld.clone())
      } else {
        const sMid = (j - 0.5) / (STEM_NODES - 1)
        const angle = baseAngleFromVertical + archLeft * Math.pow(sMid, 0.88) + sWave * Math.sin(sMid * Math.PI * 2.0)
        // Ease into targetPlaneZ in the lower 55% of the barb so the upper 45% glides right inside its focal depth plane!
        const zProfileDeriv = (deltaZ / Math.max(barbLength, 1.0)) * 1.85 * Math.pow(Math.max(1 - sMid, 0), 0.85)
        _segDir.set(-Math.sin(angle), Math.cos(angle), zProfileDeriv).normalize()
        const stepLen = barbLength / (STEM_NODES - 1)
        const nextNode = worldNodes[j - 1].clone().addScaledVector(_segDir, stepLen)
        worldNodes.push(nextNode)
      }
      const nodePos = worldNodes[j]
      const meanAngle = barbuleMeanBranchAngle(s)
      const envRadius = maxBarbuleLen * barbuleEnvelopeShape(s) * Math.sin(meanAngle) * 0.88
      const coreRadius = Math.max(baseCoreRadius * Math.pow(1 - 0.88 * s, 0.78), 0.00038)

      const offsetWorld = _prevP.subVectors(nodePos, _p)
      const idx = (i * STEM_NODES + j) * 4
      stemLocalRest[idx + 0] = offsetWorld.dot(_t)
      stemLocalRest[idx + 1] = offsetWorld.dot(_n)
      stemLocalRest[idx + 2] = offsetWorld.dot(_b)
      stemLocalRest[idx + 3] = envRadius

      initialStemPos[idx + 0] = nodePos.x
      initialStemPos[idx + 1] = nodePos.y
      initialStemPos[idx + 2] = nodePos.z
      initialStemPos[idx + 3] = envRadius

      initialStemVel[idx + 0] = 0
      initialStemVel[idx + 1] = 0
      initialStemVel[idx + 2] = 0
      initialStemVel[idx + 3] = coreRadius

      volumeBounds.expandByPoint(nodePos)
    }

    for (let j = 0; j < STEM_NODES; j++) {
      const prev = worldNodes[Math.max(0, j - 1)]
      const next = worldNodes[Math.min(STEM_NODES - 1, j + 1)]
      const bTangent = _segDir.subVectors(next, prev).normalize()
      if (j === 0) {
        _curN.set(Math.sin(dihedralBias) * 0.35, 0.05, Math.cos(dihedralBias))
        _curN.addScaledVector(bTangent, -_curN.dot(bTangent)).normalize()
      } else {
        const prevPrev = worldNodes[Math.max(0, j - 2)]
        const prevT = _prevP.subVectors(worldNodes[j], prevPrev).normalize()
        _rotAxis.crossVectors(prevT, bTangent)
        const sinA = _rotAxis.length()
        if (sinA > 1e-6) {
          _rotAxis.divideScalar(sinA)
          _curN.applyAxisAngle(_rotAxis, Math.atan2(sinA, prevT.dot(bTangent)))
        }
        _curN.addScaledVector(bTangent, -_curN.dot(bTangent)).normalize()
      }
      const idx = (i * STEM_NODES + j) * 4
      initialStemFrame[idx + 0] = _curN.x
      initialStemFrame[idx + 1] = _curN.y
      initialStemFrame[idx + 2] = _curN.z
      initialStemFrame[idx + 3] = 0
    }
  }

  for (const pos of rachisPositions) volumeBounds.expandByPoint(pos)
  volumeBounds.expandByScalar(0.85)

  return {
    rachisRestPos,
    rachisRestNormal,
    barbRootInfo,
    barbStyleInfo,
    stemLocalRest,
    initialStemPos,
    initialStemVel,
    initialStemFrame,
    volumeBounds,
  }
}
