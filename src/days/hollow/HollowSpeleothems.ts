import {MathUtils, Vector3} from 'three/webgpu'
import {HollowField, createHollowRandom} from './HollowField.js'
import {
  type FlowstoneLobe, type HollowDraperyBody, type HollowFlowstoneBody, type HollowStalactiteBody,
  type HollowStalagmiteBody, type StalactiteForm, type StalagmiteForm,
  draperyBody, flowstoneBody, stalactiteBody, stalagmiteBody,
} from './HollowSculpt.js'

export interface SpeleothemParams {
  stalactiteDensity: number
  stalagmiteDensity: number
  draperyScale: number
  flowstoneDensity: number
}

export type HollowSpeleothemBody = HollowFlowstoneBody | HollowStalactiteBody | HollowStalagmiteBody | HollowDraperyBody

export interface HollowSpeleothemSet {
  /** Flowstones, stalactites, stalagmites and draperies: bodies of the cave's field (`HollowSculpt`). */
  bodies: HollowSpeleothemBody[]
  dripEmitters: Vector3[]
  stalactiteCount: number
  stalagmiteCount: number
  draperyCount: number
  flowstoneCount: number
}

/** Columns along a drapery's anchor curve. */
const DRAPERY_COLUMNS = 64
/** Step (`m`) of a flow traced down the cave; how far it runs at most, and spreads once it levels out. */
const FLOW_STEP = 0.06
const FLOW_MAX = 7
const FLOW_APRON = 0.5
/** Longest soda straw (`m`): longer, a straw thickens into a carrot. */
const STRAW_LENGTH = 0.3
/** Distance (`m`) from the cinema camera past which a dripstone's cells coarsen (with the distance, up to `3×`). */
const DETAIL_DISTANCE = 5

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

/** The field's gradient at `p` (`out`, unnormalised: the field isn't a true distance everywhere). */
function gradient(field: HollowField, p: Vector3, out: Vector3, e = 0.04) {
  return out.set(
    field.sample(p.x + e, p.y, p.z) - field.sample(p.x - e, p.y, p.z),
    field.sample(p.x, p.y + e, p.z) - field.sample(p.x, p.y - e, p.z),
    field.sample(p.x, p.y, p.z + e) - field.sample(p.x, p.y, p.z - e),
  ).divideScalar(2 * e)
}

/** Where the cave's wall stands at height `y`, out from its spine at `z` toward `side` (`±1` in `x`), or `null`. */
function findWall(field: HollowField, z: number, y: number, side: number): Vector3 | null {
  const cx = field.spineX(z)
  if (field.sample(cx, y, z) <= 0) return null
  let open = 0
  for (let s = 0.25; s < 10; s += 0.25) {
    if (field.sample(cx + side * s, y, z) > 0) {
      open = s
      continue
    }
    let rock = s
    for (let i = 0; i < 8; i++) {
      const mid = 0.5 * (open + rock)
      if (field.sample(cx + side * mid, y, z) > 0) open = mid
      else rock = mid
    }
    return new Vector3(cx + side * 0.5 * (open + rock), y, z)
  }
  return null
}

interface FlowPath {
  points: Vector3[]
  normals: Vector3[]
  /** Down the flow, in the surface. */
  downs: Vector3[]
  length: number
}

/**
 * Where water from a seep at `start` (on the cave's surface) runs: down the slope, over the ledges, till it levels
 * out (and spreads a little), meets the lake or drips off an overhang.
 */
function traceFlow(field: HollowField, start: Vector3): FlowPath {
  const wl = field.params.waterLevel
  const p = start.clone()
  const g = new Vector3()
  const n = new Vector3()
  const down = new Vector3()
  const prev = new Vector3()
  const path: FlowPath = {points: [], normals: [], downs: [], length: 0}
  let flat = 0
  for (let i = 0; i * FLOW_STEP < FLOW_MAX; i++) {
    const slope = gradient(field, p, g).length()
    if (slope < 1e-6) break
    n.copy(g).divideScalar(slope)
    if (n.y < -0.3) break
    // Gravity in the surface
    down.set(n.x * n.y, n.y * n.y - 1, n.z * n.y)
    const fall = down.length()
    if (fall > 0.2) {
      down.divideScalar(fall)
      if (i > 0) down.lerp(prev, 0.6).addScaledVector(n, -down.dot(n)).normalize()
    } else {
      // Level: it spreads on the way it came
      if (i === 0) break
      down.copy(prev).addScaledVector(n, -prev.dot(n))
      if (down.lengthSq() < 1e-6) break
      down.normalize()
      flat += FLOW_STEP
    }
    path.points.push(p.clone())
    path.normals.push(n.clone())
    path.downs.push(down.clone())
    if (flat > FLOW_APRON || (p.y < wl + 0.03 && field.lakeDepthAt(p.x, p.z) > 0)) break
    prev.copy(down)
    p.addScaledVector(down, FLOW_STEP)
    // Back onto the surface (Newton along the gradient)
    for (let k = 0; k < 2; k++) p.addScaledVector(g, -field.sample(p.x, p.y, p.z) / (slope * slope))
    path.length += FLOW_STEP
  }
  return path
}

/**
 * Lobes of flowstone down a traced flow, as the specimen's cascade stacks them, scaled to the cave: overlapping into
 * one sheet down the steep, thicker toward the foot, bulging into pillows where it pours over a ledge, flat and wide
 * where it spreads into an apron; smaller lobes staggered beside them now and then, so its edges run ragged.
 */
function flowstoneLobes(path: FlowPath, rand: () => number): FlowstoneLobe[] {
  const lobes: FlowstoneLobe[] = []
  const width = 0.7 + rand() * 0.5
  const count = path.points.length
  let next = 0
  for (let i = 0; i < count; i++) {
    const arc = i * FLOW_STEP
    if (arc < next) continue
    const s = path.length > 0 ? arc / path.length : 0
    const out = path.normals[i]
    const down = path.downs[i]
    const across = new Vector3().crossVectors(down, out).normalize()
    // `1` on walls, `0` on floors
    const steep = 1 - MathUtils.smoothstep(out.y, 0.6, 0.9)
    // Over a ledge the normal turns down the flow (`rad/m`)
    const j0 = Math.max(0, i - 3)
    const j1 = Math.min(count - 1, i + 3)
    const turn = j1 > j0 ? path.normals[j1].clone().sub(path.normals[j0]).dot(down) / ((j1 - j0) * FLOW_STEP) : 0
    const ledge = MathUtils.smoothstep(turn, 0.4, 2.0)
    const spacing = MathUtils.lerp(0.4, 0.3, steep) * (0.8 + 0.4 * rand())
    const radii = new Vector3(
      width * (0.65 + 0.6 * s) * (0.85 + 0.3 * rand()) * (1.4 - 0.4 * steep) * (1 + 0.2 * ledge),
      spacing * 1.4,
      (MathUtils.lerp(0.12, 0.25 + 0.12 * s, steep) + 0.1 * ledge) * (0.9 + 0.2 * rand()),
    )
    const protrude = MathUtils.lerp(0.05, 0.08 + 0.2 * s, steep) + 0.15 * ledge
    const centre = path.points[i].clone().addScaledVector(out, protrude - radii.z)
    lobes.push({centre, across, down: down.clone(), out: out.clone(), radii, t: s})
    if (rand() < 0.4) {
      // A smaller lobe staggered to one side and a little lower
      const side = (rand() < 0.5 ? -1 : 1) * radii.x * (0.5 + 0.35 * rand())
      const small = radii.clone().multiplyScalar(0.45 + 0.25 * rand())
      lobes.push({
        centre: centre.clone().addScaledVector(across, side).addScaledVector(down, 0.3 * radii.y)
          .addScaledVector(out, -0.25 * small.z),
        across,
        down: down.clone(),
        out: out.clone(),
        radii: small,
        t: s,
      })
    }
    next = arc + spacing
  }
  return lobes
}

/**
 * Populates the cave with its formations, as bodies of its field: flowstone cascades down the walls (most in the
 * warm gallery), ceiling stalactites in four forms (often in clusters along a crack), stalagmites in four forms
 * (some under the stalactites that feed them, some twinned), fluted draperies; and the droplet emitters over the lake.
 */
export function buildHollowSpeleothems(field: HollowField, params: SpeleothemParams): HollowSpeleothemSet {
  const rand = createHollowRandom(field.params.seed * 53 + 701)
  const wScale = field.widthScale
  const wl = field.params.waterLevel
  const flowstones: HollowFlowstoneBody[] = []
  const stalactites: HollowStalactiteBody[] = []
  const stalagmites: HollowStalagmiteBody[] = []
  const draperies: HollowDraperyBody[] = []
  const dripCandidates: {tip: Vector3; score: number}[] = []
  /** Tips over dry floor, where a stalagmite may grow under the drip. */
  const dryTips: Vector3[] = []

  const normal = new Vector3()
  const dens = field.featureDensity
  const pose = field.cinemaPose
  const camera = new Vector3(pose.startX, wl + pose.height, pose.startZ)
  /** How much coarser a dripstone at `p` may be meshed: the camera sees its detail at its distance. */
  const coarsen = (p: Vector3) => MathUtils.clamp(p.distanceTo(camera) / DETAIL_DISTANCE, 1, 3)

  // 1. Flowstone cascades from seeps high on the walls, facing the camera, most on the warm gallery's side
  const flowTarget = Math.round(MathUtils.clamp(params.flowstoneDensity, 0, 2) * (2 + 1.5 * Math.min(dens, 1.4)))
  if (flowTarget > 0) {
    const flowRand = createHollowRandom(field.params.seed * 71 + 313)
    const candidates: {path: FlowPath; score: number}[] = []
    for (let attempt = 0; attempt < flowTarget * 16; attempt++) {
      const z = -15 + flowRand() * 17
      const side = flowRand() < 0.65 ? field.gallerySide : -field.gallerySide
      const seep = findWall(field, z, wl + 1.4 + flowRand() * 2.6, side)
      if (!seep) continue
      if (seep.z > pose.startZ - 3.5 && Math.abs(seep.x - pose.startX) < 2.6) continue
      field.sampleNormal(seep.x, seep.y, seep.z, normal, 0.06)
      if (Math.abs(normal.y) > 0.6 || normal.x * side > -0.3) continue
      const facing = normal.dot(new Vector3().subVectors(camera, seep).normalize())
      if (facing < 0.1) continue
      const path = traceFlow(field, seep)
      if (path.points.length < 2) continue
      const drop = seep.y - path.points[path.points.length - 1].y
      if (path.length < 1.0 || drop < 0.7) continue
      candidates.push({path, score: drop * (0.5 + facing) * (0.7 + 0.6 * flowRand())})
    }
    candidates.sort((a, b) => b.score - a.score)
    const seeps: Vector3[] = []
    for (const {path} of candidates) {
      if (flowstones.length >= flowTarget) break
      const seep = path.points[0]
      if (seeps.some(other => other.distanceTo(seep) < 2.2)) continue
      seeps.push(seep)
      const footY = Math.min(...path.points.map(p => p.y))
      flowstones.push(flowstoneBody(flowstoneLobes(path, flowRand), footY, flowRand() * Math.PI * 2))
    }
  }

  // 2. Rib-guided ceiling stalactites, often in clusters along a crack: carrots, icicles, short soda straws
  const stalactiteForm = (length: number): StalactiteForm => {
    const roll = rand()
    if (length < STRAW_LENGTH && roll < 0.3) return 'straw'
    return roll < 0.75 ? 'carrot' : 'icicle'
  }
  const addStalactite = (x: number, z: number, ceilY: number, host: Vector3, length: number, form: StalactiteForm) => {
    const straw = form === 'straw'
    const anchor = new Vector3(x, ceilY, z)
    stalactites.push(stalactiteBody({
      anchor,
      hostNormal: host.clone(),
      form,
      length: straw ? Math.min(length, STRAW_LENGTH) : length,
      baseRadius: straw ? 0.026 : 0.045 + length * (0.07 + rand() * 0.035),
      flutes: 6 + Math.floor(rand() * 5),
      fluteDepth: 0.07 + rand() * 0.07,
      ringFreq: 14.0 + rand() * 10.0,
      phase: rand() * Math.PI * 2,
      coarsen: coarsen(anchor),
    }))
    const tip = new Vector3(x, ceilY - (straw ? Math.min(length, STRAW_LENGTH) : length), z)
    // Tips directly over open lake water may drip into it; over dry floor, feed a stalagmite
    const lakeDepth = field.lakeDepthAt(x, z)
    if (lakeDepth > 0.26 && Math.abs(x - field.spineX(z)) < 3.6 * wScale) {
      dripCandidates.push({tip, score: lakeDepth + (z > -6.5 ? 0.45 : 0.0) + rand() * 0.35})
    } else if (lakeDepth <= 0) {
      dryTips.push(tip)
    }
  }

  const targetStalactites = Math.round(310 * Math.max(0.0, params.stalactiteDensity) * dens)
  let attempts = 0
  while (stalactites.length < targetStalactites && attempts < targetStalactites * 12) {
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
    addStalactite(x, z, ceilY, normal, length, stalactiteForm(length))

    // Siblings along the same crack, shorter, many of them straws
    const siblings = rand() < 0.4 ? 1 + Math.floor(rand() * 4) : 0
    const crack = rand() * Math.PI * 2
    for (let s = 0; s < siblings && stalactites.length < targetStalactites; s++) {
      const offset = (0.1 + rand() * 0.35) * (rand() < 0.5 ? -1 : 1)
      const sx = x + Math.cos(crack) * offset + (rand() - 0.5) * 0.06
      const sz = z + Math.sin(crack) * offset + (rand() - 0.5) * 0.06
      const sCeil = field.findCeilingY(sx, sz)
      if (sCeil === null || Math.abs(sCeil - ceilY) > 0.4) continue
      field.sampleNormal(sx, sCeil, sz, normal, 0.08)
      if (normal.y > -0.36) continue
      const sLength = length * (0.25 + 0.6 * rand())
      addStalactite(sx, sz, sCeil, normal, sLength, sLength < STRAW_LENGTH && rand() < 0.5 ? 'straw' : stalactiteForm(sLength))
    }
  }

  // 3. Stalagmites: pagodas on the warm gallery's shelf, then pagodas, candles, cones and bosses about the floor,
  // some twinned, some under the stalactites dripping on them
  const stalagmiteSize = (form: StalagmiteForm): [number, number] => {
    switch (form) {
      case 'pagoda': {
        const h = 0.35 + Math.pow(rand(), 1.5) * 0.95
        return [h, 0.1 + h * (0.1 + rand() * 0.06)]
      }
      case 'candle': return [0.3 + rand() * 1.0, 0.035 + rand() * 0.035]
      case 'cone': {
        const h = 0.3 + Math.pow(rand(), 1.5) * 0.8
        return [h, 0.1 + h * (0.12 + rand() * 0.06)]
      }
      case 'boss': return [0.08 + rand() * 0.18, 0.12 + rand() * 0.18]
    }
  }
  const stalagmiteForm = (): StalagmiteForm => {
    const roll = rand()
    return roll < 0.35 ? 'pagoda' : roll < 0.6 ? 'candle' : roll < 0.8 ? 'cone' : 'boss'
  }
  const addStalagmite = (x: number, y: number, z: number, form: StalagmiteForm, height: number, radius: number) => {
    const foot = new Vector3(x, y, z)
    stalagmites.push(stalagmiteBody({
      foot,
      form,
      height,
      baseRadius: radius,
      lean: form === 'boss' ? 0 : height * rand() * 0.07,
      azimuth: rand() * Math.PI * 2,
      seed: Math.floor(rand() * 1e6),
      coarsen: coarsen(foot),
    }))
  }
  /** A stalagmite of `form` at `(x, z)` on the floor (with a twin now and then), if the floor there holds one. */
  const standStalagmite = (x: number, z: number, form: StalagmiteForm, height: number, radius: number, floorY: number) => {
    addStalagmite(x, floorY, z, form, height, radius)
    if (form === 'boss' || rand() > 0.2) return
    const angle = rand() * Math.PI * 2
    const gap = radius * (1.2 + rand() * 1.4)
    const tx = x + Math.cos(angle) * gap
    const tz = z + Math.sin(angle) * gap
    const twinFloor = field.findFloorY(tx, tz, floorY + 0.5)
    if (twinFloor === null || Math.abs(twinFloor - floorY) > 0.2) return
    const scale = 0.4 + rand() * 0.35
    addStalagmite(tx, twinFloor, tz, form, height * scale, radius * (0.6 + 0.3 * scale))
  }

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
      addStalagmite(wx, floorY, hz, 'pagoda', hLen * MathUtils.clamp(params.stalagmiteDensity, 0.5, 1.4) * dens, hRad * dens)
      // Bosses about its foot
      const bosses = Math.floor(rand() * 3)
      for (let b = 0; b < bosses; b++) {
        const angle = rand() * Math.PI * 2
        const gap = hRad * dens * (1.4 + rand() * 1.2)
        const bx = wx + Math.cos(angle) * gap
        const bz = hz + Math.sin(angle) * gap
        const bossFloor = field.findFloorY(bx, bz, floorY + 0.5)
        if (bossFloor === null || Math.abs(bossFloor - floorY) > 0.25) continue
        addStalagmite(bx, bossFloor, bz, 'boss', 0.06 + rand() * 0.1, 0.08 + rand() * 0.08)
      }
    }

    const targetStalagmites = Math.round(34 * Math.max(0.0, params.stalagmiteDensity) * dens)
    let placed = 0
    let mAttempts = 0
    while (placed < targetStalagmites && mAttempts < targetStalagmites * 16) {
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

      const form = stalagmiteForm()
      const [height, radius] = stalagmiteSize(form)
      standStalagmite(x, z, form, height, radius, floorY)
      placed++
    }

    // Under the drips of stalactites over dry floor
    const fed = Math.round(10 * MathUtils.clamp(params.stalagmiteDensity, 0, 2))
    let under = 0
    for (const tip of dryTips) {
      if (under >= fed) break
      if (rand() > 0.25) continue
      if (field.rimstoneCoord(tip.x, tip.z) < 1.25) continue
      const floorY = field.findFloorY(tip.x, tip.z, tip.y - 0.3)
      if (floorY === null || floorY < wl + 0.1 || tip.y - floorY < 0.7) continue
      field.sampleNormal(tip.x, floorY, tip.z, normal, 0.08)
      if (normal.y < 0.7) continue
      const roll = rand()
      const form: StalagmiteForm = roll < 0.5 ? 'boss' : roll < 0.8 ? 'candle' : 'pagoda'
      const [height, radius] = stalagmiteSize(form)
      standStalagmite(tip.x, tip.z, form, Math.min(height, 0.45 * (tip.y - floorY)), radius, floorY)
      under++
    }
  }

  // 4. Fluted wall draperies / organ-pipe curtains (hero-side curtains + warm-gallery + skylight brow)
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
      draperies.push(flutedDrapery(field, sx, sz, ex, ez, drop, thick, field.params.seed * 41 + i * 13))
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
    bodies: [...flowstones, ...stalactites, ...stalagmites, ...draperies],
    dripEmitters,
    stalactiteCount: stalactites.length,
    stalagmiteCount: stalagmites.length,
    draperyCount: draperies.length,
    flowstoneCount: flowstones.length,
  }
}
