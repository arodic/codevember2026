import {BufferAttribute, BufferGeometry, PlaneGeometry, SphereGeometry, Vector3} from 'three/webgpu'
import {smax, smin} from './HollowField.js'
import {contourOctree, triangulateQuads} from './HollowOctree.js'
import {ellipsoid, roundCone} from './HollowSculpt.js'

/** `aSheet` thickness (`m`) of solid rock (as `HollowSculpt`'s). */
const OPAQUE_SHEET = 1.0
/** Zones blend across this many fillet radii (as `HollowSculpt`'s). */
const MATERIAL_SPREAD = 2
/** Bound on a field's slope (unless the specimen says): a cell farther than this many half-diagonals holds no surface. */
const LIPSCHITZ = 2
/** Contact occlusion (`aOcclusion`): probe distances (`m`) along the normal and their weights (as `HollowSculpt`'s). */
const AO_STEPS = [0.04, 0.1, 0.2, 0.34] as const
const AO_WEIGHTS = [0.4, 0.3, 0.2, 0.1] as const
/** Newton steps that take a cell's mass point onto the surface. */
const PROJECT_STEPS = 3

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x))
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** A lattice value (`-1 … 1`). */
function lattice(ix: number, iy: number, iz: number) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x61c88647)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1
}

/** Smooth value noise (`-1 … 1`). */
function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  return lerp(
    lerp(lerp(lattice(ix, iy, iz), lattice(ix + 1, iy, iz), u), lerp(lattice(ix, iy + 1, iz), lattice(ix + 1, iy + 1, iz), u), v),
    lerp(
      lerp(lattice(ix, iy, iz + 1), lattice(ix + 1, iy, iz + 1), u),
      lerp(lattice(ix, iy + 1, iz + 1), lattice(ix + 1, iy + 1, iz + 1), u),
      v,
    ),
    w,
  )
}

/** Octaves of `noise3`, normalised to `-1 … 1`. */
function fbm3(x: number, y: number, z: number, octaves: number) {
  let sum = 0
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const f = 2.03 ** i
    sum += amp * noise3(x * f + i * 7.1, y * f - i * 3.3, z * f + i * 5.7)
    norm += amp
    amp *= 0.5
  }
  return sum / norm
}

function roundBox(x: number, y: number, z: number, bx: number, by: number, bz: number, r: number) {
  const qx = Math.abs(x) - bx + r
  const qy = Math.abs(y) - by + r
  const qz = Math.abs(z) - bz + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r
}

/** How much the beds of a face with normal `ny` up show (`aZone.x`, as `HollowField.zonesAt`). */
function bedding(ny: number) {
  return clamp01(1 - Math.abs(ny) * 0.75)
}

/**
 * Unites a specimen's parts as `HollowSculpt` unites the cave's bodies: a smooth minimum (fillets of `blend`), and
 * with `zones` on, their zones (`aZone`) and sheets (`aSheet`) blended with the same weights, a little wider.
 */
class Union {
  d = Infinity
  /** The normal's `y` where the zones are sampled. */
  ny = 0
  zones = false
  readonly zone = new Float32Array(4)
  readonly sheet = new Float32Array(2)

  begin(zones: boolean, ny = 0) {
    this.d = Infinity
    this.zones = zones
    this.ny = ny
    return this
  }

  add(
    d: number, blend: number, strata: number, calcite: number, rimstone: number, wetness: number,
    thickness = OPAQUE_SHEET, edge = 0,
  ) {
    if (this.d === Infinity) {
      this.d = d
      if (this.zones) {
        this.zone.set([strata, calcite, rimstone, wetness])
        this.sheet.set([thickness, edge])
      }
      return
    }
    if (this.zones) {
      const w = clamp01(0.5 + (0.5 * (this.d - d)) / (MATERIAL_SPREAD * Math.max(blend, 1e-3)))
      const z = this.zone
      z[0] += (strata - z[0]) * w
      z[1] += (calcite - z[1]) * w
      z[2] += (rimstone - z[2]) * w
      z[3] += (wetness - z[3]) * w
      this.sheet[0] += (thickness - this.sheet[0]) * w
      this.sheet[1] += (edge - this.sheet[1]) * w
    }
    this.d = smin(this.d, d, blend)
  }
}

/**
 * A cave formation in miniature, sculpted as the cave is (`HollowSculpt`): one signed distance field (`> 0` in the
 * open) whose parts carry the zones the surface material reads. Local frame: the cave floor at `y = 0`.
 */
export interface HollowSpecimen {
  name: string
  /** Bounds of the surface. */
  min: Vector3
  max: Vector3
  /** Cell size (`m`) of the mesh. */
  cell: number
  /** Where the camera looks, and the radius it frames. */
  focus: Vector3
  radius: number
  /** Hangs from a ceiling: the camera looks up at it. */
  hanging: boolean
  /** Bound on the field's slope, when steeper than `LIPSCHITZ`. */
  lipschitz?: number
  /** Unites the specimen's parts at a point into `u`. */
  sample(x: number, y: number, z: number, u: Union): void
}

/** A low slab of floor the floor specimens stand on (top at `y = 0.02`). */
function plinth(x: number, y: number, z: number, hx: number, hz: number) {
  return roundBox(x, y + 0.08, z, hx, 0.1, hz, 0.04) - 0.008 * fbm3(x * 3, y * 3, z * 3, 2)
}

/** A slab of ceiling (underside at `y ≈ CEILING`), lumpy underneath. */
function ceilingSlab(x: number, y: number, z: number, hx: number, hz: number) {
  return roundBox(x, y - 2.12, z, hx, 0.24, hz, 0.08) - 0.035 * fbm3(x * 2.1 + 1.3, y * 2.1, z * 2.1 - 0.7, 3)
}

const CEILING = 1.88

// --- Wall: bedded limestone, ledges and partings, a flowstone tongue down from a seep

const WALL_BEDS = [0.3, 0.62, 0.94, 1.27, 1.6]
/** How far each bed's face stands out (`m`), bottom up. */
const WALL_FACE = [0.02, -0.05, 0.07, -0.01, 0.09, -0.03]

function wallFace(x: number, y: number) {
  let z = WALL_FACE[0]
  for (let i = 0; i < WALL_BEDS.length; i++) {
    const b = WALL_BEDS[i]
    z += (WALL_FACE[i + 1] - WALL_FACE[i]) * smoothstep(b - 0.035, b + 0.035, y)
    const u = (y - b) / 0.03
    z -= 0.03 * Math.exp(-u * u)
  }
  return z + 0.05 * fbm3(x * 1.4, y * 1.4, 0.37, 3) + 0.018 * noise3(x * 4.1 + 2.3, y * 4.1, 5.1)
}

/** Thickness (`m`) of the flowstone over the wall: ribbed, bulging where it pours over a ledge. */
function wallFlowstone(x: number, y: number) {
  if (y > 1.78) return 0
  const xc = 0.18 + 0.07 * Math.sin(y * 2.7)
  const half = 0.11 + 0.17 * clamp01((1.75 - y) / 1.75)
  const u = (x - xc) / half
  if (Math.abs(u) >= 1) return 0
  const lateral = (1 - u * u) ** 2
  const ribs = 0.72 + 0.28 * Math.cos((x - xc) * 40 + y * 1.5)
  let lobes = 1
  for (const b of WALL_BEDS) {
    const v = (y - b + 0.05) / 0.05
    lobes += 0.7 * Math.exp(-v * v)
  }
  return 0.05 * lateral * ribs * lobes * smoothstep(1.78, 1.55, y)
}

const wall: HollowSpecimen = {
  name: 'Wall',
  min: new Vector3(-0.95, -0.2, -0.67),
  max: new Vector3(0.95, 1.95, 0.33),
  cell: 0.015,
  focus: new Vector3(0, 0.95, 0),
  radius: 1.1,
  hanging: false,
  sample(x, y, z, u) {
    const coat = wallFlowstone(x, y)
    // A height field over the wall's plane, its slope bounded by `2.4`
    const front = (z - wallFace(x, y) - coat) / 2.4
    const d = smax(front, roundBox(x, y - 0.875, z + 0.17, 0.9, 1.03, 0.45, 0.06), 0.05)
    const calcite = smoothstep(0.003, 0.02, coat)
    const seep = Math.exp(-(((x - 0.2) / 0.3) ** 2)) * smoothstep(1.95, 1.3, y)
    const capillary = 1 - smoothstep(-0.05, 0.4, y)
    u.add(d, 0, bedding(u.ny) * (1 - calcite), calcite * 0.9, 0, Math.max(calcite * 0.7, seep * 0.55, capillary * 0.8))
  },
}

// --- Stalactites: carrots and soda straws under a slab of ceiling

interface Hanging {
  x: number
  z: number
  length: number
  radius: number
  /** Flutes around it (`0`: a soda straw, a tube). */
  flutes: number
  phase: number
}

const STALACTITES: Hanging[] = [
  {x: -0.3, z: 0.05, length: 0.95, radius: 0.075, flutes: 7, phase: 0.3},
  {x: 0.12, z: -0.18, length: 0.62, radius: 0.06, flutes: 6, phase: 1.1},
  {x: 0.4, z: 0.16, length: 0.36, radius: 0.045, flutes: 8, phase: 2.0},
  {x: -0.04, z: 0.3, length: 0.22, radius: 0.035, flutes: 6, phase: 0.7},
  {x: 0.56, z: -0.26, length: 0.5, radius: 0.05, flutes: 7, phase: 2.6},
  {x: -0.56, z: -0.24, length: 0.3, radius: 0.04, flutes: 6, phase: 1.7},
  {x: 0.26, z: 0.34, length: 0.26, radius: 0.016, flutes: 0, phase: 0},
  {x: -0.16, z: -0.36, length: 0.18, radius: 0.016, flutes: 0, phase: 0},
]
/** Radius (`m`) of a stalactite's tip (as `HollowSculpt`'s). */
const TIP = 0.015
/** Root (`y`) of the stalactites, inside the slab. */
const ROOT = 1.97

/** A stalactite's distance; `along.t` runs from `0` at its root to `1` at its tip. */
function stalactite(s: Hanging, x: number, y: number, z: number, along: {t: number}) {
  const tipY = CEILING - s.length
  along.t = clamp01((CEILING - y) / s.length)
  const bound = Math.max(Math.hypot(x - s.x, z - s.z) - 1.4 * s.radius, tipY - y, y - ROOT - 1.3 * s.radius)
  // Far enough that neither its fillet nor its zones reach
  if (bound > 0.25) return bound
  if (s.flutes === 0) return roundCone(x, y, z, s.x, ROOT, s.z, s.radius, s.x, tipY + s.radius, s.z, s.radius)
  const r0 = s.radius
  const b = CEILING - 0.15 * s.length
  const c = CEILING - 0.6 * s.length
  const rc = 0.45 * r0 + 0.008
  let d = Math.min(
    roundCone(x, y, z, s.x, ROOT, s.z, 1.25 * r0, s.x, b, s.z, r0),
    roundCone(x, y, z, s.x, b, s.z, r0, s.x, c, s.z, rc),
    roundCone(x, y, z, s.x, c, s.z, rc, s.x, tipY + TIP, s.z, TIP),
  )
  const local = r0 + (TIP - r0) * along.t ** 0.8
  d -= 0.09 * local * Math.cos(s.flutes * Math.atan2(z - s.z, x - s.x) + s.phase)
  d -= 0.002 * Math.sin(y * 90 + s.phase) * (1 - along.t)
  return d
}

const along = {t: 0}

const stalactites: HollowSpecimen = {
  name: 'Stalactites',
  min: new Vector3(-0.9, 0.85, -0.7),
  max: new Vector3(0.9, 2.45, 0.7),
  cell: 0.0125,
  focus: new Vector3(0, 1.45, 0),
  radius: 0.95,
  hanging: true,
  sample(x, y, z, u) {
    u.add(ceilingSlab(x, y, z, 0.8, 0.6), 0, bedding(u.ny), 0, 0, 0.2)
    for (const s of STALACTITES) {
      const d = stalactite(s, x, y, z, along)
      u.add(d, 0.03 + 0.5 * s.radius, 0.15, 0.92, 0, 0.45 + 0.55 * smoothstep(0.45, 0.95, along.t))
    }
  },
}

// --- Drapery: a folded, ribbed calcite curtain with a toothed fringe

function curtainCurve(x: number) {
  return 0.11 * Math.sin(x * 6.2 + 0.5) + 0.035 * Math.sin(x * 15 + 1.3)
}

/** How far (`m`) the curtain hangs: a toothed fringe, shorter toward its ends (slope under `3`). */
function curtainDrop(x: number) {
  const tooth = Math.abs((((x * 9 + 0.3) % 1) + 1) % 1 - 0.5) * 2
  return (0.72 + 0.07 * Math.sin(x * 11) + 0.08 * tooth) * (0.55 + 0.45 * smoothstep(0.56, 0.2, Math.abs(x)))
}

const curtain = {v: 0, thickness: 0, edge: 0}

/** The curtain's distance (sets `curtain`): a sheet about a folded mid-surface, rounded at its fringe and ends. */
function curtainDistance(x: number, y: number, z: number) {
  const e = 1e-3
  const c = curtainCurve(x)
  const dc = (curtainCurve(x + e) - curtainCurve(x - e)) / (2 * e)
  const drop = curtainDrop(x)
  const edgeY = CEILING - drop
  const rib = 1 - Math.abs(Math.sin(x * Math.PI * 7)) ** 3
  const half = 0.019 + 0.012 * rib + 0.02 * smoothstep(CEILING - 0.35, CEILING + 0.05, y)
  // Distance to the mid-surface, cut a half thickness short of the fringe and ends: then the sheet around it. Across
  // the fringe's slope (`drop'`, kinked at the teeth) it's the vertical distance, steeper than true (`lipschitz`)
  const lateral = Math.abs(z - c) / Math.sqrt(1 + dc * dc)
  const below = edgeY + half - y
  const side = Math.abs(x) - 0.56 + half
  const top = y - 2.02
  curtain.v = drop > 1e-3 ? clamp01((CEILING - y) / drop) : 0
  curtain.thickness = 2 * half
  curtain.edge = y - edgeY
  return Math.hypot(lateral, Math.max(below, 0), Math.max(side, 0), Math.max(top, 0)) - half
}

const drapery: HollowSpecimen = {
  name: 'Drapery',
  min: new Vector3(-0.85, 0.95, -0.6),
  max: new Vector3(0.85, 2.45, 0.6),
  cell: 0.0125,
  focus: new Vector3(0, 1.45, 0),
  radius: 0.9,
  hanging: true,
  lipschitz: 4,
  sample(x, y, z, u) {
    u.add(ceilingSlab(x, y, z, 0.75, 0.5), 0, bedding(u.ny), 0, 0, 0.2)
    const d = curtainDistance(x, y, z)
    u.add(d, 0.08, 0.1, 0.96, 0, 0.55 + 0.4 * curtain.v, curtain.thickness, curtain.edge)
  },
}

// --- Flowstone: a frozen cascade of lobes over a rock step, spreading into an apron of gours

const FLOW_LOBES = [
  [0.05, 0.92, -0.2, 0.42, 0.14, 0.28],
  [-0.12, 0.72, -0.04, 0.38, 0.17, 0.24],
  [0.15, 0.55, 0.04, 0.36, 0.16, 0.24],
  [-0.05, 0.36, 0.13, 0.42, 0.17, 0.26],
  [0.1, 0.17, 0.24, 0.5, 0.15, 0.3],
  [0.0, 0.04, 0.38, 0.62, 0.07, 0.36],
] as const

const flowstone: HollowSpecimen = {
  name: 'Flowstone',
  min: new Vector3(-0.92, -0.22, -0.8),
  max: new Vector3(0.92, 1.15, 0.8),
  cell: 0.015,
  focus: new Vector3(0, 0.5, 0.05),
  radius: 0.95,
  hanging: false,
  sample(x, y, z, u) {
    const step = roundBox(x, y - 0.45, z + 0.38, 0.75, 0.55, 0.32, 0.1) - 0.03 * fbm3(x * 1.8, y * 1.8, z * 1.8 + 4, 2)
    u.add(step, 0, bedding(u.ny), 0, 0, 0.3)
    u.add(plinth(x, y, z, 0.85, 0.7), 0.06, 0, 0, 0, 0.45)
    let flow = Infinity
    for (const l of FLOW_LOBES) {
      const e = ellipsoid(x - l[0], y - l[1], z - l[2], l[3], l[4], l[5])
      flow = flow === Infinity ? e : smin(flow, e, 0.1)
    }
    flow -= 0.008 * Math.cos(x * 30 + 2 * Math.sin(y * 5)) * smoothstep(0.05, 0.25, y)
    const apron = 1 - smoothstep(0.02, 0.18, y)
    u.add(flow, 0.06, 0.05, 0.88, 0.45 * apron, 0.6 + 0.3 * (1 - clamp01(y)))
  },
}

// --- Stalagmite: a pagoda of stacked bosses with a splash cup, smaller bosses beside it

const STALAGMITE = [
  [0, 0.1, 0, 0.23, 0.14, 0.22],
  [0.015, 0.29, 0.005, 0.185, 0.13, 0.18],
  [0.03, 0.47, 0, 0.155, 0.12, 0.15],
  [0.04, 0.63, -0.005, 0.125, 0.1, 0.125],
  [0.045, 0.77, -0.01, 0.1, 0.09, 0.1],
  [0.05, 0.88, -0.01, 0.075, 0.06, 0.075],
] as const
const BOSSES = [
  [-0.42, 0.05, 0.22, 0.11, 0.08, 0.1],
  [-0.42, 0.15, 0.22, 0.07, 0.07, 0.07],
  [0.38, 0.04, -0.25, 0.09, 0.06, 0.09],
] as const

function stack(x: number, y: number, z: number, parts: readonly (readonly number[])[], k: number) {
  let d = Infinity
  for (const l of parts) {
    const e = ellipsoid(x - l[0], y - l[1], z - l[2], l[3], l[4], l[5])
    d = d === Infinity ? e : smin(d, e, k)
  }
  return d
}

const stalagmite: HollowSpecimen = {
  name: 'Stalagmite',
  min: new Vector3(-0.8, -0.22, -0.65),
  max: new Vector3(0.8, 1.0, 0.65),
  cell: 0.0125,
  focus: new Vector3(0, 0.45, 0),
  radius: 0.8,
  hanging: false,
  sample(x, y, z, u) {
    const splash = Math.exp(-((x - 0.15) ** 2 + (z - 0.25) ** 2) / 0.09)
    u.add(plinth(x, y, z, 0.75, 0.6), 0, bedding(u.ny) * 0.3, 0, 0, 0.3 + 0.55 * splash)
    let d = stack(x, y, z, STALAGMITE, 0.06) - 0.003 * Math.sin(y * 70)
    // The splash cup the drip keeps hollow on top
    d = smax(d, 0.045 - Math.hypot(x - 0.05, y - 0.955, z + 0.01), 0.015)
    u.add(d, 0.08, 0.1, 0.92, 0, 0.55 + 0.35 * smoothstep(0.65, 1, y / 0.95))
    u.add(stack(x, y, z, BOSSES, 0.04), 0.05, 0.1, 0.9, 0, 0.5)
  },
}

// --- Rimstone: pools stepping down behind dams with proud lips

function gourEdge0(x: number) {
  return -0.25 + 0.07 * Math.sin(x * 5.3 + 0.4) + 0.03 * Math.sin(x * 13 + 2)
}

function gourEdge1(x: number) {
  return 0.18 + 0.06 * Math.sin(x * 4.1 + 2.2) + 0.03 * Math.sin(x * 11.5 + 0.7)
}

/** Water levels (`m`) of the pools, back to front. */
const GOUR_LEVELS = [0.2, 0.11, 0.03] as const

/** How deep (`m`) a point lies in a pool's dish: `0` on the dams and their faces. */
const gour = {dish: 0}

function gourHeight(x: number, z: number) {
  const e0 = gourEdge0(x)
  const e1 = gourEdge1(x)
  let h = GOUR_LEVELS[0]
    + (GOUR_LEVELS[1] - GOUR_LEVELS[0]) * smoothstep(e0, e0 + 0.07, z)
    + (GOUR_LEVELS[2] - GOUR_LEVELS[1]) * smoothstep(e1, e1 + 0.07, z)
  // The dams stand proud of the pools behind them, which dish a little
  const l0 = (z - e0 + 0.005) / 0.02
  const l1 = (z - e1 + 0.005) / 0.02
  h += 0.03 * Math.exp(-l0 * l0) + 0.028 * Math.exp(-l1 * l1)
  gour.dish = 0.012 * smoothstep(0.02, 0.15, e0 - z)
    + 0.012 * smoothstep(0.02, 0.12, z - e0 - 0.07) * smoothstep(0.02, 0.12, e1 - z)
    + 0.01 * smoothstep(0.02, 0.12, z - e1 - 0.07)
  return h - gour.dish + 0.004 * noise3(x * 9, 0.5, z * 9)
}

const rimstone: HollowSpecimen = {
  name: 'Rimstone',
  min: new Vector3(-0.9, -0.22, -0.7),
  max: new Vector3(0.9, 0.42, 0.7),
  cell: 0.0125,
  focus: new Vector3(0, 0.1, 0),
  radius: 0.85,
  hanging: false,
  sample(x, y, z, u) {
    // A height field whose slope stays under `2.5` (the dams' faces): scaled to a bound, not to the local slope (whose
    // change over the lips would make the field far steeper away from them)
    const top = (y - gourHeight(x, z)) / 2
    const d = smax(top, roundBox(x, y - 0.1, z, 0.85, 0.27, 0.65, 0.04), 0.03)
    // Pools hold water; the dams' crests dry between overflows
    u.add(d, 0, bedding(u.ny) * 0.2, 0.5, 0.9, 0.5 + 0.5 * smoothstep(0.002, 0.008, gour.dish))
  },
}

// --- Boulder: a block of breakdown, cleaved and dry, with a smaller one beside it

const BOULDER_PLANES = [
  [0, -1, 0, 0.36],
  [0.15, 1, 0.1, 0.38],
  [1, 0.1, 0.2, 0.55],
  [-1, 0.15, 0.1, 0.5],
  [0.2, 0.05, 1, 0.42],
  [0.1, 0.2, -1, 0.45],
  [0.8, 0.7, 0.3, 0.6],
  [-0.7, 0.75, -0.4, 0.55],
  [0.6, -0.2, -0.8, 0.55],
  [-0.6, 0.4, 0.75, 0.55],
].map(([x, y, z, w]) => {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l, w] as const
})

function polytope(x: number, y: number, z: number) {
  let d = -Infinity
  for (const [nx, ny, nz, w] of BOULDER_PLANES) {
    const p = nx * x + ny * y + nz * z - w
    d = d === -Infinity ? p : smax(d, p, 0.035)
  }
  return d
}

const boulder: HollowSpecimen = {
  name: 'Boulder',
  min: new Vector3(-1.0, -0.22, -0.8),
  max: new Vector3(1.0, 0.85, 0.8),
  cell: 0.015,
  focus: new Vector3(0, 0.3, 0),
  radius: 0.9,
  hanging: false,
  sample(x, y, z, u) {
    u.add(plinth(x, y, z, 0.95, 0.75), 0, bedding(u.ny) * 0.3, 0, 0, 0.15)
    u.add(polytope(x, y - 0.33, z) - 0.012 * fbm3(x * 3, y * 3, z * 3, 2), 0.03, bedding(u.ny), 0, 0, 0.05)
    // The smaller block turned a quarter about `y`, a third the size
    const s = 0.35
    u.add(polytope((z - 0.32) / s, (y - 0.11) / s, (0.62 - x) / s) * s, 0.02, bedding(u.ny), 0, 0, 0.08)
  },
}

/** The specimens, in the order they stand. */
export const HOLLOW_SPECIMENS: readonly HollowSpecimen[] = [
  wall, stalactites, drapery, flowstone, stalagmite, rimstone, boulder,
]

const union = new Union()

/** A specimen's signed distance (`m`, `> 0` in the open). */
export function specimenDistance(s: HollowSpecimen, x: number, y: number, z: number) {
  s.sample(x, y, z, union.begin(false))
  return union.d
}

/** A specimen's mesh as arrays (to pass from a worker): positions, normals, triangles and the cave's attributes. */
export interface HollowSpecimenMesh {
  positions: Float32Array
  normals: Float32Array
  index: Uint32Array
  zones: Float32Array
  sheets: Float32Array
  occlusion: Float32Array
}

/**
 * Meshes a specimen as the cave is meshed (`contourOctree`, cells of `s.cell` wherever the surface runs), its
 * vertices taken onto the surface, with the cave's attributes: `aZone`, `aSheet` and `aOcclusion`.
 */
export function sculptSpecimen(s: HollowSpecimen): HollowSpecimenMesh {
  const cell = s.cell
  const span = Math.max(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z) + 2 * cell
  const depth = Math.ceil(Math.log2(span / cell))
  const size = cell * 2 ** depth
  const reach = ((s.lipschitz ?? LIPSCHITZ) * Math.sqrt(3)) / 2
  const distance = (x: number, y: number, z: number) => specimenDistance(s, x, y, z)
  const contour = contourOctree<null>({
    distance,
    visit(x, y, z, edge) {
      const d = distance(x + edge / 2, y + edge / 2, z + edge / 2)
      if (Math.abs(d) > reach * edge) return null
      return {split: edge > cell * 1.001, context: null}
    },
  }, {x: s.min.x - cell, y: s.min.y - cell, z: s.min.z - cell}, size, depth, null)

  const positions = Float32Array.from(contour.positions)
  const count = positions.length / 3
  const normals = new Float32Array(count * 3)
  const zones = new Float32Array(count * 4)
  const sheets = new Float32Array(count * 2)
  const occlusion = new Float32Array(count)
  const g = new Float32Array(3)
  /** The gradient (`g`) by a tetrahedron of samples `e` apart; returns its length squared. */
  const gradient = (x: number, y: number, z: number, e: number) => {
    const a = distance(x + e, y - e, z - e)
    const b = distance(x - e, y - e, z + e)
    const c = distance(x - e, y + e, z - e)
    const d = distance(x + e, y + e, z + e)
    g[0] = (a - b - c + d) / (4 * e)
    g[1] = (-a - b + c + d) / (4 * e)
    g[2] = (-a + b - c + d) / (4 * e)
    return g[0] * g[0] + g[1] * g[1] + g[2] * g[2]
  }
  for (let v = 0; v < count; v++) {
    let x = positions[v * 3]
    let y = positions[v * 3 + 1]
    let z = positions[v * 3 + 2]
    for (let i = 0; i < PROJECT_STEPS; i++) {
      const d = distance(x, y, z)
      const g2 = gradient(x, y, z, cell * 0.1)
      if (g2 < 1e-10) break
      // Newton along the gradient, never past a cell
      const step = Math.max(-cell, Math.min(cell, d / Math.sqrt(g2))) / Math.sqrt(g2)
      x -= g[0] * step
      y -= g[1] * step
      z -= g[2] * step
    }
    positions.set([x, y, z], v * 3)
    const len = Math.sqrt(gradient(x, y, z, cell * 0.25)) || 1
    const nx = g[0] / len
    const ny = g[1] / len
    const nz = g[2] / len
    normals.set([nx, ny, nz], v * 3)

    s.sample(x, y, z, union.begin(true, ny))
    zones.set(union.zone, v * 4)
    sheets.set(union.sheet, v * 2)
    let occluded = 0
    for (let k = 0; k < AO_STEPS.length; k++) {
      const h = AO_STEPS[k]
      occluded += AO_WEIGHTS[k] * clamp01((h - distance(x + nx * h, y + ny * h, z + nz * h)) / h)
    }
    occlusion[v] = 1 - occluded
  }

  const index = triangulateQuads(positions, contour.quads, normals)
  return {positions, normals, index, zones, sheets, occlusion}
}

export function specimenGeometry(mesh: HollowSpecimenMesh): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('aZone', new BufferAttribute(mesh.zones, 4))
  geometry.setAttribute('aSheet', new BufferAttribute(mesh.sheets, 2))
  geometry.setAttribute('aOcclusion', new BufferAttribute(mesh.occlusion, 1))
  geometry.setIndex(new BufferAttribute(mesh.index, 1))
  geometry.computeBoundingSphere()
  return geometry
}

export function meshSpecimen(s: HollowSpecimen): BufferGeometry {
  return specimenGeometry(sculptSpecimen(s))
}

/**
 * Meshes every specimen on worker threads (a second or so each, in parallel), handing each geometry to `done` as it
 * arrives (`index` into `HOLLOW_SPECIMENS`). Returns a function that stops the workers.
 */
export function meshSpecimensOnWorkers(done: (index: number, geometry: BufferGeometry) => void): () => void {
  const count = Math.max(1, Math.min(HOLLOW_SPECIMENS.length, (navigator.hardwareConcurrency || 4) - 1))
  const workers = Array.from({length: count}, () =>
    new Worker(new URL('./HollowSpecimenWorker.ts', import.meta.url), {type: 'module', name: 'Hollow Specimen'}))
  let next = 0
  let left = HOLLOW_SPECIMENS.length
  const stop = () => {
    for (const worker of workers) worker.terminate()
  }
  for (const worker of workers) {
    worker.onmessage = (event: MessageEvent<{index: number; mesh: HollowSpecimenMesh}>) => {
      done(event.data.index, specimenGeometry(event.data.mesh))
      if (next < HOLLOW_SPECIMENS.length) worker.postMessage(next++)
      if (--left === 0) stop()
    }
    worker.onerror = event => console.error(`Hollow specimen worker: ${event.message}`)
    if (next < HOLLOW_SPECIMENS.length) worker.postMessage(next++)
  }
  return stop
}

/** The cave's attributes, the same at every vertex of `geometry`. */
function uniformZones(geometry: BufferGeometry, zone: readonly [number, number, number, number], occlusion = 1) {
  const count = geometry.getAttribute('position').count
  const zones = new Float32Array(count * 4)
  const sheets = new Float32Array(count * 2)
  for (let v = 0; v < count; v++) {
    zones.set(zone, v * 4)
    sheets[v * 2] = OPAQUE_SHEET
  }
  geometry.setAttribute('aZone', new BufferAttribute(zones, 4))
  geometry.setAttribute('aSheet', new BufferAttribute(sheets, 2))
  geometry.setAttribute('aOcclusion', new BufferAttribute(new Float32Array(count).fill(occlusion), 1))
  return geometry
}

/** A sphere (`radius`) of one zone: a swatch of a surface type. */
export function swatchGeometry(radius: number, zone: readonly [number, number, number, number]): BufferGeometry {
  return uniformZones(new SphereGeometry(radius, 128, 64), zone)
}

/**
 * The cave floor around the specimens (`width × depth`, centred), a few centimetres under their plinths: lumpy, damp
 * in broad patches. Positions in world space (the noise follows them).
 */
export function floorGeometry(width: number, depth: number, segment = 0.04): BufferGeometry {
  const geometry = new PlaneGeometry(width, depth, Math.round(width / segment), Math.round(depth / segment))
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position')
  const count = position.count
  const zones = new Float32Array(count * 4)
  for (let v = 0; v < count; v++) {
    const x = position.getX(v)
    const z = position.getZ(v)
    position.setY(v, -0.06 + 0.025 * fbm3(x * 0.8, 0.3, z * 0.8, 3) + 0.006 * noise3(x * 5, 1.7, z * 5))
    zones[v * 4 + 3] = 0.8 * smoothstep(0.0, 0.5, fbm3(x * 0.35 + 3.1, 2.2, z * 0.35, 2))
  }
  geometry.computeVertexNormals()
  uniformZones(geometry, [0, 0, 0, 0])
  geometry.setAttribute('aZone', new BufferAttribute(zones, 4))
  return geometry
}
