import {Box3, MathUtils, Vector3} from 'three/webgpu'

/** Cavern world bounds (`1 unit = 1 m`; `y = 0` is the main lake surface; +Z includes behind-camera fire alcove). */
export const HOLLOW_MIN = new Vector3(-14.5, -2.5, -27.5)
export const HOLLOW_MAX = new Vector3(14.5, 11.0, 16.5)
export const HOLLOW_SIZE = new Vector3().subVectors(HOLLOW_MAX, HOLLOW_MIN)

/** Elevation of the stepped foreground rimstone (`gour`) water meniscus above `waterLevel`. */
export const RIMSTONE_POOL_STEP = 0.085
/** Crest height of the calcified rimstone dam lip above `waterLevel`. */
export const RIMSTONE_LIP_HEIGHT = 0.16

/** Seed-driven cinema framing pose (`1 unit = 1 m`) used by `Hollow` dolly start / look-at. */
export interface HollowCinemaPose {
  startX: number
  startZ: number
  targetX: number
  targetY: number
  targetZ: number
  height: number
  fov: number
}

export interface HollowFieldParams {
  seed: number
  cavernWidth: number
  vaultHeight: number
  meander: number
  strataStrength: number
  skylightSize: number
  terraceSteps: number
  rimstoneScale: number
  waterLevel: number
}

export const DEFAULT_HOLLOW_PARAMS: HollowFieldParams = {
  seed: 1056,
  cavernWidth: 1.0,
  vaultHeight: 1.0,
  meander: 1.0,
  strataStrength: 1.0,
  skylightSize: 1.0,
  terraceSteps: 10,
  rimstoneScale: 1.0,
  waterLevel: 0.0,
}

/** Axis-aligned `xz` extent of the open main lake (`lakeDepthAt > 0`), padded half a meter. */
export interface HollowLakeExtent {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Lithological & hydrological weights at a world point (`0..1` each). */
export interface HollowZones {
  strata: number
  travertine: number
  rimstone: number
  wetness: number
}

const LATTICE_SIZE = 32
const LATTICE_MASK = LATTICE_SIZE - 1

/** Deterministic Mulberry32 PRNG. */
export function createHollowRandom(seed: number): () => number {
  let state = (Math.imul(Math.floor(seed) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Polynomial smooth-minimum: deposits rock (`phi < 0`) into air (`phi > 0`) with a concave fillet of radius `k`. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 1e-5) return Math.min(a, b)
  const h = MathUtils.clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
  return a * h + b * (1.0 - h) - k * h * (1.0 - h)
}

/** Polynomial smooth-maximum: carves void (`phi > 0`) out of rock (`phi < 0`) with a rounded arch lip of radius `k`. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
  return t * t * (3.0 - 2.0 * t)
}

/**
 * Seeded 3D karst signed distance field (`phi > 0` = open cavern/sky air, `phi < 0` = solid limestone,
 * `grad(phi)` = surface normal pointing into open air).
 *
 * Designed for fast narrow-band CPU evaluation during Surface Nets extraction, rock and speleothem placement and the
 * lake's shore mask.
 */
export class HollowField {

  readonly bounds = new Box3(HOLLOW_MIN.clone(), HOLLOW_MAX.clone())
  params: HollowFieldParams = {...DEFAULT_HOLLOW_PARAMS}

  /** Warm fire source — always behind the cinema camera plane so only spill reads in frame. */
  readonly fireOrigin = new Vector3(-6.8, 1.85, 10.4)
  /** Center of the upper-rear karst skylight opening. */
  readonly skylightCenter = new Vector3(1.35, 9.8, -18.8)
  /** Primary direction of the cyan skylight shaft entering through the sinkhole. */
  readonly skylightDirection = new Vector3(0.12, 0.82, -0.56).normalize()
  /** Center of the foreground rimstone (`gour`) pool in `(x, 0, z)`. */
  readonly rimstoneCenter = new Vector3(-2.15, 0.0, 1.15)
  /** Seed-reshuffled cinema framing; dolly orbits this start pose. */
  readonly cinemaPose: HollowCinemaPose = {
    startX: 0.62,
    startZ: 6.95,
    targetX: -0.18,
    targetY: 1.38,
    targetZ: -12.2,
    height: 1.68,
    fov: 39,
  }
  /** `+1` = hero boulder / right bench on +X, `-1` = mirrored. */
  heroSide = 1
  /** Seed density bias for speleothem / boulder placement (`~0.45..2.0`). */
  featureDensity = 1.0
  /** Seed-picked dolly / truck / pan magnitudes applied by `Hollow` on seed change. */
  readonly cinemaTracks = {forward: 1.1, lateral: -0.42, lookDrift: 0.22}

  private readonly lattice = new Float32Array(LATTICE_SIZE * LATTICE_SIZE * LATTICE_SIZE)
  private spinePhase1 = 0
  private spinePhase2 = 0
  private spineAmp1 = 0.85
  private spineAmp2 = 1.35
  private spineFreq1 = 0.19
  private spineFreq2 = 0.14
  private spineBias = 0
  private rearSwing = 1.35
  private rimPhase1 = 0
  private rimPhase2 = 0
  private rimRotC = 0.92
  private rimRotS = 0.39
  private rimRx = 2.05
  private rimRz = 1.38
  private ribPhase = 0
  private ribDiagX = 0.78
  private ribDiagZ = 0.62
  private browZ = -12.0
  private bedOffset = 0
  private cascadeStartZ = -10.0
  private cascadeEndZ = -20.4
  private cascadeRise = 2.35
  private leftGalleryStrength = 1.0
  private rightBenchStrength = 1.0
  private thalwegBias = 0.25
  private vaultCrown = 5.05
  /** Seed-internal cavern proportion multipliers (on top of inspector params). */
  private widthBias = 1.0
  private vaultBias = 1.0
  private meanderBias = 1.0
  private wallLeftSpan = 6.6
  private wallRightSpan = 5.5
  private channelDepth = 1.55
  private fireAlcoveRx = 2.8
  private fireAlcoveRy = 2.1
  private fireAlcoveRz = 2.6
  private spillPillar = new Vector3(-3.4, 1.4, 8.2)
  private lakeExtentCache: HollowLakeExtent | null = null
  /** Last `spineX` (`z`, value) and `rimstoneCoord` (`x`, `z`, value): a sample repeats them for its column. */
  private readonly memoSpine = new Float64Array(2).fill(NaN)
  private readonly memoRim = new Float64Array(3).fill(NaN)

  constructor(params?: Partial<HollowFieldParams>) {
    this.configure(params ?? {})
  }

  /** Effective lateral scale of the cavern: the inspector's `cavernWidth` times the seed's own width bias. */
  get widthScale() {
    return this.params.cavernWidth * this.widthBias
  }

  /** Side (`±1` in x from the spine) of the warm travertine gallery: always opposite the hero boulder. */
  get gallerySide() {
    return -this.heroSide
  }

  /** Radius (`m`) that encloses the whole rimstone dam, for searches outward from `rimstoneCenter`. */
  get rimstoneReach() {
    return Math.max(this.rimRx, this.rimRz) * Math.max(0.35, this.params.rimstoneScale) * 1.6
  }

  /** z where the rear travertine cascade starts climbing out of the lake. */
  get cascadeStart() {
    return this.cascadeStartZ
  }

  configure(partial: Partial<HollowFieldParams>) {
    this.params = {...this.params, ...partial}
    const rand = createHollowRandom(this.params.seed)
    for (let i = 0; i < this.lattice.length; i++) {
      this.lattice[i] = rand() * 2.0 - 1.0
    }

    // Discrete composition archetype — changes the *kind* of cavern, not just noise phases
    const archetype = Math.floor(rand() * 5)
    // 0 classic, 1 deep throat, 2 wide grotto, 3 gallery-dominant, 4 cascade cathedral
    this.widthBias = archetype === 2 ? 1.15 + rand() * 0.35
      : archetype === 1 ? 0.72 + rand() * 0.22
        : 0.82 + rand() * 0.45
    this.vaultBias = archetype === 4 ? 1.15 + rand() * 0.4
      : archetype === 1 ? 0.78 + rand() * 0.28
        : 0.85 + rand() * 0.45
    this.meanderBias = archetype === 1 ? 0.55 + rand() * 0.55
      : 0.7 + rand() * 1.15
    this.wallLeftSpan = (archetype === 3 ? 7.4 : 5.4) + rand() * 3.2
    this.wallRightSpan = (archetype === 2 ? 6.8 : 4.4) + rand() * 2.8
    this.channelDepth = 1.05 + rand() * 1.35
    // Two retired draws (the old lake z clips): the lake now ends where its floor does. Kept so seeds don't move.
    rand()
    rand()

    // --- Seed reshuffles major composition landmarks (not just micro-noise phases) ---
    this.spinePhase1 = rand() * Math.PI * 2
    this.spinePhase2 = rand() * Math.PI * 2
    this.spineAmp1 = 0.55 + rand() * 2.4
    this.spineAmp2 = 0.55 + rand() * 1.85
    this.spineFreq1 = 0.08 + rand() * 0.26
    this.spineFreq2 = 0.06 + rand() * 0.28
    this.spineBias = (rand() - 0.5) * 8.5
    this.rearSwing = 0.6 + rand() * 3.6
    // Mirror S-bend so left/right gallery dominance flips with seed
    if (rand() < 0.5) {
      this.spineAmp1 *= -1
      this.spineAmp2 *= -1
      this.rearSwing *= -1
    }

    this.rimPhase1 = rand() * Math.PI * 2
    this.rimPhase2 = rand() * Math.PI * 2
    const rimYaw = (rand() - 0.5) * 2.4
    this.rimRotC = Math.cos(rimYaw)
    this.rimRotS = Math.sin(rimYaw)
    this.rimRx = 1.25 + rand() * 2.15
    this.rimRz = 0.85 + rand() * 1.55

    this.ribPhase = rand() * Math.PI * 2
    this.ribDiagX = 0.35 + rand() * 1.05
    this.ribDiagZ = 0.25 + rand() * 1.0
    if (rand() < 0.5) this.ribDiagX *= -1
    this.browZ = -7.5 - rand() * 10.5
    this.bedOffset = rand() * 5.0

    this.cascadeStartZ = -5.5 - rand() * 8.5
    this.cascadeEndZ = this.cascadeStartZ - (6.0 + rand() * 10.5)
    this.cascadeRise = 1.15 + rand() * 3.1
    this.leftGalleryStrength = archetype === 3 ? 1.1 + rand() * 1.2 : 0.15 + rand() * 1.75
    this.rightBenchStrength = 0.1 + rand() * 1.85
    this.thalwegBias = (rand() - 0.5) * 1.45
    this.vaultCrown = 3.6 + rand() * 3.8
    this.heroSide = rand() < 0.5 ? 1 : -1
    this.featureDensity = 0.45 + rand() * 1.55

    // Cinema pad first — fire must stay behind this plane for every seed
    this.placeCinema(rand)

    // Skylight opening wanders widely across the rear vault
    this.skylightCenter.set(
      this.spineBias + (rand() - 0.5) * 11.0,
      7.8 + rand() * 3.0,
      MathUtils.clamp(this.cascadeEndZ + (rand() - 0.5) * 4.5, -26.5, -12.0),
    )
    const skyAimX = (rand() - 0.5) * 0.85
    const skyAimZ = -0.15 - rand() * 0.7
    this.skylightDirection.set(skyAimX, 0.45 + rand() * 0.5, skyAimZ).normalize()

    // Rimstone dam: near shore, opposite hero boulder; may sit camera-left OR camera-right
    const rimSide = rand() < 0.82 ? -this.heroSide : this.heroSide
    this.rimstoneCenter.set(
      this.cinemaPose.startX + rimSide * (0.6 + rand() * 3.8) + (rand() - 0.5) * 1.8,
      this.params.waterLevel,
      MathUtils.clamp(-1.8 + rand() * 5.2, -2.4, 4.2),
    )

    this.lakeExtentCache = null
    this.clearMemos()
    this.ensureClearView()
    this.clearMemos()
  }

  /** Forgets the memoised `spineX` and `rimstoneCoord` (their inputs change while configuring). */
  private clearMemos() {
    this.memoSpine.fill(NaN)
    this.memoRim.fill(NaN)
  }

  /**
   * Seed-picks the cinema pad, look target, lens and dolly tracks, then the fire behind that camera plane, its
   * alcove and the spill pillar between them.
   */
  private placeCinema(rand: () => number) {
    const startZ = 4.2 + rand() * 5.8
    const startX = this.spineBias * 0.15 + (rand() - 0.5) * 6.5
    const lookAim = Math.floor(rand() * 3) // 0 mid-lake, 1 cascade brow, 2 skylight-biased
    const lookZ = lookAim === 0 ? -6.0 - rand() * 5.5
      : lookAim === 1 ? this.cascadeStartZ - rand() * 4.0
        : this.cascadeEndZ + 2.0 + rand() * 4.0
    const lookX = this.spineBias * (0.25 + rand() * 0.55) + (rand() - 0.5) * 5.5
    this.cinemaPose.startX = startX
    this.cinemaPose.startZ = startZ
    this.cinemaPose.targetX = lookX
    this.cinemaPose.targetY = 0.55 + rand() * 2.2
    this.cinemaPose.targetZ = Math.min(lookZ, startZ - 6.0)
    this.cinemaPose.height = 0.85 + rand() * 2.15
    this.cinemaPose.fov = 28 + rand() * 22
    this.cinemaTracks.forward = 0.35 + rand() * 2.0
    this.cinemaTracks.lateral = (rand() - 0.5) * 2.2
    this.cinemaTracks.lookDrift = (rand() - 0.5) * 1.4

    // Warm fire: strictly behind cinema look plane (never in widescreen FOV), usually camera-left
    const camY = this.params.waterLevel + this.cinemaPose.height
    const lookDx = this.cinemaPose.targetX - startX
    const lookDy = this.params.waterLevel + this.cinemaPose.targetY - camY
    const lookDz = this.cinemaPose.targetZ - startZ
    const lookLen = Math.hypot(lookDx, lookDy, lookDz) || 1
    const lx = lookDx / lookLen
    const ly = lookDy / lookLen
    const lz = lookDz / lookLen
    // Camera right ≈ look × up
    let rx = lz
    let rz = -lx
    const rLen = Math.hypot(rx, rz) || 1
    rx /= rLen
    rz /= rLen
    const fireSide = rand() < 0.72 ? -1 : 1
    const behind = 3.4 + rand() * 5.5
    const side = fireSide * (3.6 + rand() * 5.5)
    this.fireOrigin.set(
      startX - lx * behind + rx * side,
      this.params.waterLevel + 0.95 + rand() * 1.85,
      startZ - lz * behind + rz * side,
    )
    // Re-project so fire stays strictly behind the look plane even after world clamps
    this.fireOrigin.x = MathUtils.clamp(this.fireOrigin.x, HOLLOW_MIN.x + 2.5, HOLLOW_MAX.x - 2.5)
    this.fireOrigin.z = MathUtils.clamp(this.fireOrigin.z, startZ + 2.2, HOLLOW_MAX.z - 1.5)
    {
      const along = (this.fireOrigin.x - startX) * lx
        + (this.fireOrigin.y - camY) * ly
        + (this.fireOrigin.z - startZ) * lz
      if (along > -2.8) {
        const push = along + 2.8
        this.fireOrigin.x -= lx * push
        this.fireOrigin.y -= ly * push
        this.fireOrigin.z -= lz * push
        this.fireOrigin.z = Math.max(this.fireOrigin.z, startZ + 2.2)
      }
    }
    this.fireAlcoveRx = 2.0 + rand() * 2.4
    this.fireAlcoveRy = 1.45 + rand() * 1.7
    this.fireAlcoveRz = 1.8 + rand() * 2.4
    // Spill-shaping buttress between fire and framed cavern (alcove stays out of view; light floods forward)
    this.spillPillar.set(
      MathUtils.lerp(this.fireOrigin.x, startX, 0.38 + rand() * 0.28),
      this.params.waterLevel + 0.75 + rand() * 1.35,
      MathUtils.lerp(this.fireOrigin.z, startZ - 0.6, 0.28 + rand() * 0.3),
    )
  }

  /**
   * Fraction (`0..1`) of the cinema look ray's first 12 m that runs through open air, worst of the dolly's start,
   * middle and end. Below ~0.9 the camera stares into a wall or buttress.
   */
  viewClearance(): number {
    const pose = this.cinemaPose
    const tracks = this.cinemaTracks
    const wl = this.params.waterLevel
    const samples = 48
    let worst = 1
    for (const u of [0, 0.5, 1]) {
      const camX = pose.startX + tracks.lateral * (u - 0.5)
      const camZ = pose.startZ - tracks.forward * (u - 0.5)
      const camY = Math.max(wl + pose.height, this.floorHeightAt(camX, camZ, true) + 0.42)
      const dx = pose.targetX + tracks.lookDrift * (u - 0.5) - camX
      const dy = wl + pose.targetY - camY
      const dz = pose.targetZ - camZ
      const len = Math.hypot(dx, dy, dz)
      const reach = Math.min(12, len) / len
      let air = 0
      for (let i = 1; i <= samples; i++) {
        const k = (i / samples) * reach
        if (this.sample(camX + dx * k, camY + dy * k, camZ + dz * k) > 0) air++
      }
      worst = Math.min(worst, air / samples)
    }
    return worst
  }

  /**
   * Re-picks a blocked seed's camera (and the fire placed behind it) from a separate retry generator, keeping the
   * clearest; seeds that already see the cavern are left exactly as drawn.
   */
  private ensureClearView() {
    let best = this.viewClearance()
    if (best >= 0.95) return
    const snapshot = () => ({
      pose: {...this.cinemaPose},
      tracks: {...this.cinemaTracks},
      fire: this.fireOrigin.clone(),
      alcove: [this.fireAlcoveRx, this.fireAlcoveRy, this.fireAlcoveRz],
      pillar: this.spillPillar.clone(),
    })
    let bestState = snapshot()
    const retry = createHollowRandom(this.params.seed * 613 + 17)
    for (let attempt = 0; attempt < 24 && best < 0.95; attempt++) {
      this.placeCinema(retry)
      const clearance = this.viewClearance()
      if (clearance > best) {
        best = clearance
        bestState = snapshot()
      }
    }
    Object.assign(this.cinemaPose, bestState.pose)
    Object.assign(this.cinemaTracks, bestState.tracks)
    this.fireOrigin.copy(bestState.fire)
    ;[this.fireAlcoveRx, this.fireAlcoveRy, this.fireAlcoveRz] = bestState.alcove
    this.spillPillar.copy(bestState.pillar)
  }

  /** Fast periodic trilinear Hermite lattice noise in `[-1, 1]`. */
  noise3(x: number, y: number, z: number): number {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const zi = Math.floor(z)
    const xf = x - xi
    const yf = y - yi
    const zf = z - zi
    const u = xf * xf * (3.0 - 2.0 * xf)
    const v = yf * yf * (3.0 - 2.0 * yf)
    const w = zf * zf * (3.0 - 2.0 * zf)

    const x0 = xi & LATTICE_MASK
    const x1 = (xi + 1) & LATTICE_MASK
    const y0 = (yi & LATTICE_MASK) * LATTICE_SIZE
    const y1 = ((yi + 1) & LATTICE_MASK) * LATTICE_SIZE
    const z0 = (zi & LATTICE_MASK) * LATTICE_SIZE * LATTICE_SIZE
    const z1 = ((zi + 1) & LATTICE_MASK) * LATTICE_SIZE * LATTICE_SIZE

    const lat = this.lattice
    const c000 = lat[x0 + y0 + z0]
    const c100 = lat[x1 + y0 + z0]
    const c010 = lat[x0 + y1 + z0]
    const c110 = lat[x1 + y1 + z0]
    const c001 = lat[x0 + y0 + z1]
    const c101 = lat[x1 + y0 + z1]
    const c011 = lat[x0 + y1 + z1]
    const c111 = lat[x1 + y1 + z1]

    const c00 = c000 + (c100 - c000) * u
    const c10 = c010 + (c110 - c010) * u
    const c01 = c001 + (c101 - c001) * u
    const c11 = c011 + (c111 - c011) * u
    const c0 = c00 + (c10 - c00) * v
    const c1 = c01 + (c11 - c01) * v
    return c0 + (c1 - c0) * w
  }

  fbm3(x: number, y: number, z: number, octaves = 3): number {
    let sum = 0.0
    let amp = 0.55
    let fx = x
    let fy = y
    let fz = z
    let norm = 0.0
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(fx, fy, fz)
      norm += amp
      amp *= 0.5
      fx = fx * 2.03 + 7.13
      fy = fy * 2.03 + 3.71
      fz = fz * 2.03 + 11.3
    }
    return sum / norm
  }

  /** Meandering cavern centerline X coordinate along Z (`z = +8` foreground -> `z = -24` rear chamber). */
  spineX(z: number): number {
    // One sample asks for its column's spine several times (the walls, floor, ceiling and ribs)
    const memo = this.memoSpine
    if (memo[0] === z) return memo[1]
    memo[0] = z
    return memo[1] = this.computeSpineX(z)
  }

  private computeSpineX(z: number): number {
    const m = this.params.meander * this.meanderBias
    const sBend = -this.spineAmp1 * Math.sin((z + 1.5) * this.spineFreq1)
      + this.rearSwing * smoothstep(-8.0, -18.5, z)
    const seedSway = this.spineAmp2 * 0.22 * Math.sin(z * this.spineFreq2 + this.spinePhase1)
      + this.spineAmp2 * 0.11 * Math.cos(z * (this.spineFreq2 * 1.9) + this.spinePhase2)
    return this.spineBias + sBend * m + seedSway * MathUtils.clamp(m, 0.25, 1.8)
  }

  /** Normalized radial coordinate `u` of the foreground kidney-shaped rimstone (`gour`) pool (`u < 1` = inside lip). */
  rimstoneCoord(x: number, z: number): number {
    const memo = this.memoRim
    if (memo[0] === x && memo[1] === z) return memo[2]
    memo[0] = x
    memo[1] = z
    return memo[2] = this.computeRimstoneCoord(x, z)
  }

  private computeRimstoneCoord(x: number, z: number): number {
    const scale = Math.max(0.35, this.params.rimstoneScale)
    const dx = x - this.rimstoneCenter.x
    const dz = z - this.rimstoneCenter.z
    const c = this.rimRotC
    const s = this.rimRotS
    const lx = (c * dx + s * dz) / (this.rimRx * scale)
    const lz = (-s * dx + c * dz) / (this.rimRz * scale)
    // Kidney indentation on the lakeward side
    const kidneyX = lx - 0.18 * lz * lz
    const radius = Math.sqrt(kidneyX * kidneyX + lz * lz)
    // The scallops scale it by `1 / (0.818 … 1.182)`: far out it's past every threshold (`≤ 1.45`) anyway
    if (radius > 1.75) return radius
    const angle = Math.atan2(lz, kidneyX)
    const organic = 1.0
      + 0.10 * Math.cos(2.0 * angle + this.rimPhase1)
      + 0.06 * Math.sin(3.0 * angle + this.rimPhase2)
      + 0.022 * Math.cos(9.0 * angle)
    return radius / organic
  }

  /** Mask `1` strictly inside the stepped rimstone water meniscus, `0` outside its calcified lip. */
  rimstoneWaterMask(x: number, z: number): number {
    const u = this.rimstoneCoord(x, z)
    return 1.0 - smoothstep(0.86, 0.98, u)
  }

  /**
   * Unperturbed structural height of the cavern floor, shoreline, rimstone dam, foreground benches, left gallery,
   * and rear travertine cascade steps at `(x, z)`.
   */
  floorHeightAt(x: number, z: number, withDetail = true): number {
    const wl = this.params.waterLevel
    const widthScale = this.widthScale
    const cx = this.spineX(z)
    const dx = (x - cx) / widthScale

    // 1. Deep meandering lake channel: asymmetric thalweg biased by seed
    const thalwegOffset = dx - this.thalwegBias
    const channelProfile = -this.channelDepth + 0.16 * thalwegOffset * thalwegOffset
      + (dx * this.thalwegBias < 0 ? 0.045 * dx * dx : 0.11 * dx * dx)
    let floorY = wl + channelProfile

    // 2. Foreground camera pad & repoussoir benches (stronger on heroSide)
    const fgBlend = smoothstep(1.4, 4.1, z)
    if (fgBlend > 0.0) {
      const sideStep = wl + 0.22
        + 0.26 * smoothstep(0.2, 3.6, x * this.heroSide)
        + 0.16 * smoothstep(1.8, 5.6, z)
      const camPad = wl + 0.45 * smoothstep(3.8, 7.2, z)
      floorY = MathUtils.lerp(floorY, Math.max(sideStep, camPad), fgBlend)
    }

    // 3. Warm travertine gallery opposite the hero boulder (seed-weighted height)
    const galleryZ = smoothstep(-0.8, -2.8, z) * (1.0 - smoothstep(-9.8, -12.8, z))
    const galleryRise = smoothstep(-2.3, -4.3, -dx * this.heroSide)
    if (galleryZ * galleryRise * this.leftGalleryStrength > 0.0) {
      const shelfHeight = wl + (0.85 + 0.55 * this.leftGalleryStrength)
        + 0.42 * smoothstep(-4.5, -6.8, -dx * this.heroSide)
      const w = MathUtils.clamp(galleryZ * galleryRise * this.leftGalleryStrength, 0, 1)
      floorY = MathUtils.lerp(floorY, Math.max(floorY, shelfHeight), w)
    }

    // 4. Rocky bench supporting the hero boulder & drapery buttress
    const rightBenchZ = smoothstep(-8.2, -5.8, z) * (1.0 - smoothstep(2.2, 4.5, z))
    const rightRise = smoothstep(1.55, 3.05, dx * this.heroSide)
    if (rightBenchZ * rightRise * this.rightBenchStrength > 0.0) {
      const benchY = wl + 0.18 + 0.56 * this.rightBenchStrength * smoothstep(2.3, 4.4, dx * this.heroSide)
      const w = MathUtils.clamp(rightBenchZ * rightRise * this.rightBenchStrength, 0, 1)
      floorY = MathUtils.lerp(floorY, Math.max(floorY, benchY), w)
    }

    // 5. Rear terraced travertine cascade climbing into the skylight chamber
    const cascadeT = smoothstep(this.cascadeStartZ, this.cascadeEndZ, z)
    if (cascadeT > 0.0) {
      const arcZ = z + 0.065 * (x - cx) * (x - cx)
      const rawClimb = smoothstep(this.cascadeStartZ - 0.2, this.cascadeEndZ + 0.2, arcZ)
      const steps = Math.max(3, Math.round(this.params.terraceSteps))
      const stepCoord = rawClimb * steps
      const stepIndex = Math.floor(stepCoord)
      const stepFrac = stepCoord - stepIndex
      const terraced = (stepIndex + smoothstep(0.68, 0.96, stepFrac)) / steps
      const bankSlope = 0.065 * Math.max(0.0, Math.abs(dx) - 2.1) * Math.max(0.0, Math.abs(dx) - 2.1)
      const cascadeY = wl + 0.05 + terraced * this.cascadeRise + bankSlope
      const blendZ0 = this.cascadeStartZ + 0.2
      const blendZ1 = this.cascadeStartZ - 1.2
      floorY = MathUtils.lerp(floorY, Math.max(floorY, cascadeY), smoothstep(blendZ0, blendZ1, z))
    }

    // 6. Foreground stepped rimstone (`gour`) dam & shallow sinter basin (either shore — seed-placed)
    // Interior always stays a shallow meniscus above `waterLevel` (overrides benches that might otherwise lift it).
    if (this.params.rimstoneScale > 0.05) {
      const u = this.rimstoneCoord(x, z)
      if (u < 1.45) {
        const basinFloor = wl + 0.025
        // Scalloped calcified rim crest around `u = 0.92`
        const lipBell = Math.exp(-Math.pow((u - 0.92) / 0.11, 2.0))
        const crenulation = withDetail ? 0.012 * this.noise3(x * 3.2, 0.5, z * 3.2) : 0.0
        const damSurface = basinFloor + (RIMSTONE_LIP_HEIGHT - 0.025 + crenulation) * lipBell
        const apronFade = 1.0 - smoothstep(0.95, 1.38, u)
        if (u < 0.92) {
          // Inside dam: blend toward shallow basin / lip crest, never inherit elevated bench floors
          floorY = MathUtils.lerp(basinFloor, damSurface, MathUtils.clamp(lipBell, 0, 1))
        } else {
          const targetRimY = MathUtils.lerp(floorY, damSurface, apronFade)
          const blendIn = 1.0 - smoothstep(1.02, 1.40, u)
          floorY = MathUtils.lerp(floorY, Math.max(floorY, targetRimY), blendIn)
        }
      }
    }

    if (withDetail) {
      // Subtle karst bedrock undulation (damped inside the flat rimstone basin and cascade treads)
      const uRim = this.rimstoneCoord(x, z)
      const rimDamp = smoothstep(0.85, 1.15, uRim)
      const bedNoise = this.fbm3(x * 0.28 + 3.1, 1.7, z * 0.28 - 2.4, 3)
      floorY += 0.22 * bedNoise * rimDamp
    }

    return floorY
  }

  /**
   * Water depth (`> 0` where open main-lake water covers the bed; `0` on dry land, inside the stepped rimstone dam,
   * and where the water plane would lie inside the cavern walls).
   */
  lakeDepthAt(x: number, z: number): number {
    if (this.params.rimstoneScale > 0.05 && this.rimstoneCoord(x, z) < 1.02) return 0.0
    const depth = this.params.waterLevel - this.floorHeightAt(x, z, true)
    if (depth <= 0.0) return 0.0
    if (this.macroSample(x, this.params.waterLevel + 0.05, z) <= 0.0) return 0.0
    return depth
  }

  /** `xz` bounds of the open lake (cached per `configure`). */
  get lakeExtent(): HollowLakeExtent {
    if (this.lakeExtentCache) return this.lakeExtentCache
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    const step = 0.25
    for (let z = HOLLOW_MIN.z; z <= HOLLOW_MAX.z; z += step) {
      for (let x = HOLLOW_MIN.x; x <= HOLLOW_MAX.x; x += step) {
        if (this.lakeDepthAt(x, z) <= 0.0) continue
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
      }
    }
    if (minX > maxX) {
      const cx = this.spineX(-4.0)
      minX = cx - 1; maxX = cx + 1; minZ = -5; maxZ = -3
    }
    this.lakeExtentCache = {minX: minX - 0.5, maxX: maxX + 0.5, minZ: minZ - 0.5, maxZ: maxZ + 0.5}
    return this.lakeExtentCache
  }

  /** z at the middle of the lake. */
  get lakeCenterZ() {
    const e = this.lakeExtent
    return 0.5 * (e.minZ + e.maxZ)
  }

  /**
   * Diagonal ceiling rib factor (`0..1`) guiding stalactite curtains along sweeping left-to-center limestone arches
   * and the rear skylight brow while keeping the central ceiling vault open as in the reference photo.
   */
  ceilingRibMask(x: number, z: number): number {
    const diag = (this.ribDiagX * x + this.ribDiagZ * z) * 0.85 + this.ribPhase
    const wave = 0.5 + 0.5 * Math.cos(diag)
    const wave2 = wave * wave
    const ribWaves = wave2 * wave2 * wave2
    const cx = this.spineX(z)
    const centerOpenVault = 0.22 + 0.78 * (
      smoothstep(cx + 1.2, cx - 2.4, x) + smoothstep(cx + 2.2, cx + 4.2, x)
    )
    const brow = Math.exp(-Math.pow((z - this.browZ) / 1.55, 2.0)) * 0.95
    return MathUtils.clamp(ribWaves * centerOpenVault + brow, 0.0, 1.25)
  }

  /** Height of the main cavern ceiling vault at `(x, z)` (excluding the skylight chimney cutout). */
  ceilingHeightAt(x: number, z: number, withDetail = true): number {
    const vh = this.params.vaultHeight * this.vaultBias
    const widthScale = this.widthScale
    const cx = this.spineX(z)
    const dx = (x - cx) / (6.6 * widthScale)

    const browPinch = 1.0 - 0.19 * Math.exp(-Math.pow((z - this.browZ) / 2.5, 2.0))
    const rearVaultRise = 2.1 * smoothstep(this.browZ - 0.5, this.skylightCenter.z - 0.2, z)
    let ceilY = (this.vaultCrown * browPinch + rearVaultRise - 1.50 * dx * dx) * vh

    const rib = this.ceilingRibMask(x, z) * (1.0 - smoothstep(this.browZ - 2.0, this.browZ - 5.0, z))
    ceilY -= 0.72 * rib * vh

    if (withDetail) {
      const cupola = this.fbm3(x * 0.22 - 5.2, 4.3, z * 0.22 + 1.9, 3)
      ceilY += 0.45 * cupola
    }
    return ceilY
  }

  /** Fast smooth macro SDF (`phi > 0` = air, `phi < 0` = rock) used to cull far-rock voxels before noise evaluation. */
  macroSample(x: number, y: number, z: number): number {
    const widthScale = this.widthScale
    const cx = this.spineX(z)

    // Lateral wall envelope — seed spans + gallery flare; opens toward rear cascade chamber
    const galleryFlare = 1.7 * smoothstep(-0.5, -5.0, z) * (1.0 - smoothstep(-9.5, -13.5, z))
      * MathUtils.clamp(this.leftGalleryStrength, 0.2, 1.6)
    // Gallery flares on its own side (opposite the hero boulder), the hero bench on the other
    const heroBench = 0.9 * MathUtils.clamp(this.rightBenchStrength - 0.5, 0, 1.2)
    const leftSpan = (this.wallLeftSpan + (this.heroSide > 0 ? galleryFlare : heroBench)) * widthScale
    const rightSpan = (this.wallRightSpan - 0.7 * smoothstep(-9.0, -16.0, z)
      + (this.heroSide > 0 ? heroBench : galleryFlare)) * widthScale
    const wallLeft = x - (cx - leftSpan)
    const wallRight = (cx + rightSpan) - x
    const zBack = z - (-24.8)
    const zFront = HOLLOW_MAX.z - 0.6 - z
    const horiz = smin(smin(wallLeft, wallRight, 1.4), smin(zBack, zFront, 1.8), 1.4)

    const floorD = y - this.floorHeightAt(x, z, false)
    const ceilD = this.ceilingHeightAt(x, z, false) - y
    let phi = smin(horiz, smin(floorD, ceilD, 1.1), 1.15)

    // Warm fire alcove behind the cinema camera plane — open air around `fireOrigin`, spilling light forward
    const fx = (x - this.fireOrigin.x) / this.fireAlcoveRx
    const fy = (y - (this.fireOrigin.y + 0.25)) / this.fireAlcoveRy
    const fz = (z - this.fireOrigin.z) / this.fireAlcoveRz
    const alcoveVoid = (1.0 - Math.sqrt(fx * fx + fy * fy + fz * fz)) * 2.9
    phi = smax(phi, alcoveVoid, 1.05)

    // Spill-shaping buttress between fire and framed cavern (alcove stays out of widescreen; light floods forward)
    const px = (x - this.spillPillar.x) / 1.35
    const pz = (z - this.spillPillar.z) / 1.15
    const spillButtress = (Math.sqrt(px * px + pz * pz) - 1.0) * 1.35
    phi = smin(phi, spillButtress, 0.65)

    // Foreground hero-side repoussoir buttress near the camera pad
    const pose = this.cinemaPose
    const bx = (x - (pose.startX + this.heroSide * 4.1 * widthScale)) / 1.75
    const bz = (z - (pose.startZ - 5.4)) / 1.55
    const sideButtress = (Math.sqrt(bx * bx + bz * bz) - 1.0) * 1.5
    phi = smin(phi, sideButtress, 0.75)

    // Upper-rear karst skylight chimney punching cleanly out through `HOLLOW_MAX.y`
    const skyScale = Math.max(0.45, this.params.skylightSize)
    const tSky = MathUtils.clamp((y - 2.8) / 8.0, 0.0, 1.0)
    const shaftMouthZ = this.skylightCenter.z + 2.2
    const shaftCenterX = MathUtils.lerp(cx + 0.25, this.skylightCenter.x, tSky)
    const shaftCenterZ = MathUtils.lerp(shaftMouthZ, this.skylightCenter.z, tSky)
    const sx = (x - shaftCenterX) / (3.65 * skyScale * (1.08 - 0.16 * tSky))
    const sz = (z - shaftCenterZ) / (3.05 * skyScale * (1.08 - 0.14 * tSky))
    const shaftVoid = (1.0 - Math.sqrt(sx * sx + sz * sz)) * 3.2 * skyScale
    const shaftBottomFade = smoothstep(1.4, 3.8, y)
    phi = smax(phi, shaftVoid - (1.0 - shaftBottomFade) * 6.0, 1.15)

    return phi
  }

  /** Full geological karst SDF (`phi > 0` = open air, `phi < 0` = solid rock). */
  sample(x: number, y: number, z: number): number {
    let phi = this.macroSample(x, y, z)

    // Narrow-band geological relief: macro limestone beds (`~0.95 m`, well above voxel Nyquist) & karst scallops
    if (Math.abs(phi) < 2.15) {
      const strataAmp = this.params.strataStrength
      const bedWarp = 0.42 * this.fbm3(x * 0.16, y * 0.18, z * 0.16, 2)
      const bedCoord = (y + 0.035 * x - 0.025 * z + this.bedOffset + bedWarp) / 0.96
      const bedIdx = Math.floor(bedCoord)
      const bedF = bedCoord - bedIdx
      const competence = 0.5 + 0.5 * Math.sin(bedIdx * 2.17 + 1.3)
      // Pinch out strata laterally with slow noise so beds form natural broken rock benches, not continuous stripes
      const pinchOut = 0.45 + 0.55 * smoothstep(-0.35, 0.45, this.noise3(x * 0.19 + 4.2, bedIdx * 0.7, z * 0.19 - 1.8))
      const ledgeProfile = Math.sin(bedF * Math.PI * 2.0) * (0.08 + 0.13 * competence) * pinchOut

      const uRim = this.rimstoneCoord(x, z)
      const notRimstone = smoothstep(0.95, 1.32, uRim)
      const wallHeightMask = smoothstep(-0.1, 0.5, y - this.params.waterLevel) * (1.0 - smoothstep(3.6, 5.8, y))
      const strataDisplacement = ledgeProfile * strataAmp * wallHeightMask * notRimstone

      const karstMacro = this.fbm3(x * 0.30 + 1.7, y * 0.36 - 3.1, z * 0.30 + 5.4, 3)
      const rimProtect = MathUtils.lerp(0.15, 1.0, notRimstone)

      phi += karstMacro * 0.38 * rimProtect - strataDisplacement
    }

    return phi
  }

  /** Normalized surface normal pointing from solid rock into open cavern air (`+grad(phi)`). */
  sampleNormal(x: number, y: number, z: number, target = new Vector3(), eps = 0.06): Vector3 {
    const gx = this.sample(x + eps, y, z) - this.sample(x - eps, y, z)
    const gy = this.sample(x, y + eps, z) - this.sample(x, y - eps, z)
    const gz = this.sample(x, y, z + eps) - this.sample(x, y, z - eps)
    const len = Math.hypot(gx, gy, gz)
    if (len < 1e-7) return target.set(0, 1, 0)
    return target.set(gx / len, gy / len, gz / len)
  }

  /** Finds ceiling surface height `y` (`phi = 0`, `normal.y < 0`) at `(x, z)`, or `null` if open sky / solid column. */
  findCeilingY(x: number, z: number): number | null {
    const startY = MathUtils.clamp((this.floorHeightAt(x, z, false) + this.ceilingHeightAt(x, z, false)) * 0.5, 0.8, 5.0)
    if (this.sample(x, startY, z) <= 0.05) return null
    let prevY = startY
    for (let y = startY + 0.35; y <= HOLLOW_MAX.y - 0.25; y += 0.35) {
      const phi = this.sample(x, y, z)
      if (phi <= 0.0) {
        let lo = prevY
        let hi = y
        for (let iter = 0; iter < 7; iter++) {
          const mid = 0.5 * (lo + hi)
          if (this.sample(x, mid, z) > 0.0) lo = mid
          else hi = mid
        }
        return 0.5 * (lo + hi)
      }
      prevY = y
    }
    return null
  }

  /** Finds floor/ledge surface height `y` (`phi = 0`, `normal.y > 0`) near `(x, z)`, or `null` if none. */
  findFloorY(x: number, z: number, maxSearchY = 4.2): number | null {
    let prevY = HOLLOW_MIN.y + 0.15
    let prevPhi = this.sample(x, prevY, z)
    for (let y = prevY + 0.3; y <= maxSearchY; y += 0.3) {
      const phi = this.sample(x, y, z)
      if (prevPhi <= 0.0 && phi > 0.0) {
        let lo = prevY
        let hi = y
        for (let iter = 0; iter < 7; iter++) {
          const mid = 0.5 * (lo + hi)
          if (this.sample(x, mid, z) <= 0.0) lo = mid
          else hi = mid
        }
        return 0.5 * (lo + hi)
      }
      prevY = y
      prevPhi = phi
    }
    return null
  }

  /** Lithological & hydrological facies weights at `(x, y, z)` for blockout review and Phase 2 clearcoat materials. */
  zonesAt(x: number, y: number, z: number, normalY: number): HollowZones {
    const wl = this.params.waterLevel
    const uRim = this.rimstoneCoord(x, z)
    const rimstone = (1.0 - smoothstep(0.85, 1.32, uRim)) * (1.0 - smoothstep(wl + 0.35, wl + 0.85, y))
    const cascadeTravertine = smoothstep(this.cascadeStartZ + 0.2, this.cascadeStartZ - 2.5, z)
      * (1.0 - smoothstep(wl + this.cascadeRise + 0.5, wl + this.cascadeRise + 1.7, y)) * smoothstep(0.25, 0.75, normalY)
    const galleryFlowstone = smoothstep(2.8, 5.2, (x - this.spineX(z)) * this.gallerySide)
      * smoothstep(wl + 0.6, wl + 1.3, y) * (1.0 - smoothstep(wl + 3.0, wl + 4.2, y)) * 0.65
    const travertine = MathUtils.clamp(Math.max(cascadeTravertine, galleryFlowstone, rimstone * 0.85), 0.0, 1.0)
    const strata = MathUtils.clamp((1.0 - Math.abs(normalY) * 0.75) * (1.0 - rimstone * 0.8), 0.0, 1.0)

    const shorelineCapillary = 1.0 - smoothstep(wl - 0.05, wl + 0.72, y)
    const seepStreaks = smoothstep(0.2, 0.75, this.noise3(x * 0.85, y * 0.18, z * 0.85)) * 0.45
    const wetness = MathUtils.clamp(Math.max(shorelineCapillary, rimstone * 0.9, cascadeTravertine * 0.75, seepStreaks), 0.0, 1.0)
    return {strata, travertine, rimstone, wetness}
  }
}
