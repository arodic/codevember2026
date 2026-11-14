import {
  Box3, BufferAttribute, BufferGeometry, MathUtils, Matrix4, Quaternion, Sphere, Vector3,
} from 'three/webgpu'
import {HOLLOW_MAX, HOLLOW_MIN, HollowField, smax, smin} from './HollowField.js'
import {
  type OctreeContour, type OctreeSlab, type OctreeVisit, contourOctree, stitchSlabs, triangulateQuads,
} from './HollowOctree.js'

interface HollowBodyBase {
  /** World bounds of the body. */
  min: Vector3
  max: Vector3
  /** Width (`m`) of its smooth union with the cave and the bodies before it (its fillet). */
  blend: number
  /** Cell size (`m`) its surface is meshed at, and the smallest its creases and thin features split into. */
  cell: number
  feature: number
}

/** A cleaved boulder: an ellipsoid cut by cleavage planes with bevelled edges, a little relief and bedding notches. */
export interface HollowRockBody extends HollowBodyBase {
  kind: 'rock'
  center: Vector3
  /** World -> body rotation (row-major `3×3`). */
  rotation: Float32Array
  /** Its unit sphere's radii (the relief's and the notches' frame). */
  radii: Vector3
  /** Cleavage planes in the body frame: unit normal `xyz`, offset `w` (`m`). */
  planes: Float32Array
  /** Bevel (`m`) of the cleaved edges. */
  bevel: number
  /** Relief (`m`) over the faces. */
  relief: number
  seed: number
}

/** A stalactite or stalagmite: a chain of round cones along its spine, fluted where its cells resolve flutes. */
export interface HollowDripstoneBody extends HollowBodyBase {
  kind: 'dripstone'
  hanging: boolean
  /** Rings from the root (buried in the cave) to the tip: `x y z` and radius. */
  spine: Float32Array
  /** Bounding sphere of each segment between rings (`x y z`, radius with its flutes). */
  segments: Float32Array
  /** Horizontal frame (`xz`) the flutes turn in. */
  frame: Float32Array
  flutes: number
  /** Flute amplitude per ring (`m`, `0` where they are too fine for its cells). */
  fluteDepth: Float32Array
  phase: number
}

/**
 * A calcite curtain: a sheet a few centimetres thick hanging from a folded curve under the ceiling, organ-pipe fluted,
 * its growing edge a sawtooth fringe (`u` runs along the curve, `v` down the sheet).
 */
export interface HollowDraperyBody extends HollowBodyBase {
  kind: 'drapery'
  /** The anchor curve, a point per column (`u = i / (n - 1)`): `x y z`, `y` a little inside the ceiling. */
  curve: Float32Array
  /** Each segment's horizontal unit tangent (`x z`) and length; the curve's length (`m`). */
  tangents: Float32Array
  length: number
  /** Drop (`m`) of the sheet at the curve's middle, and its thickness scale. */
  drop: number
  thickness: number
  foldPhase: number
  flutePhase: number
}

export type HollowBody = HollowRockBody | HollowDripstoneBody | HollowDraperyBody

/** Cell size (`m`) of the cave walls; the bodies and the rimstone dam get finer cells. */
const CAVE_CELL = 0.2
/** Cell size (`m`) around the rimstone dam, whose lip is thinner than a cave cell. */
const RIM_CELL = 0.05
/** Growth of the cell size (`m` per `m`) away from a body, so cells coarsen gradually. */
const CELL_GRADE = 0.5
/** Finest cell (`m`) and octree depth: the root cube spans `FINEST_CELL × 2^DEPTH = 51.2 m`. */
const FINEST_CELL = 0.0125
const DEPTH = 12
/** Thickness of a slab (`hollowSlabs`) in finest cells (`0.8 m`: the workers share the load evenly); no leaf is larger. */
const SLAB_CELLS = 64
/**
 * Bound on how fast the field changes: a node whose centre is farther than this × its half-diagonal from the surface
 * holds none. The cave's field is no true distance: on its terraces' risers it changes up to `~8.5` per metre.
 */
const LIPSCHITZ = 9
/**
 * A node that no corner shows crossed, each sample (centre, corners) farther than this × its half-diagonal from the
 * surface and than the field changes across it, is probably empty: a leaf, but contoured.
 */
const LIKELY_EMPTY = 1.2
/**
 * A crossed node splits (down to its feature cell) where its surface bends more than a flat facet follows: where the
 * field's mean over its corners strays from its centre by more than this × its size (the sagitta of a facet, `~1/8`
 * of the angle the surface turns through across it: here `~45°`), or where two sheets pass through it (a thin
 * feature, the field folding back).
 */
const FEATURE_BEND = 0.1
/** Smallest cell (`m`) a crease of the cave splits into; of the rimstone dam's lip. Bodies go down to `FINEST_CELL`. */
const CAVE_FEATURE_CELL = 0.05
const RIM_FEATURE_CELL = 0.025
/** A body's material spreads this × its fillet onto the cave (flowstone around a stalagmite's foot). */
const MATERIAL_SPREAD = 2
/** The volume's sides close the cave this far (`m`) inside it. */
const BOX_INSET = 0.1
/** Grid cell (`m`) of the body lookup. */
const GRID_CELL = 1.0
/**
 * Relaxation of the vertices over the surface (`sculptSlab`): steps, the share of the way to their neighbours' mean
 * each takes, and how far out of its cell (× its size) a vertex may go.
 */
const RELAX_STEPS = 3
const RELAX = 0.5
const RELAX_MARGIN = 0.5
/** `aSheet` thickness (`m`) of solid rock: no light gets through. */
const OPAQUE_SHEET = 1.0
/**
 * Thinnest drapery sheet (`m`): wider than a vertical sheet's span across a cell (`√2 DRAPERY_CELL`), so its two faces
 * never share one. Its thickness scale (`thickness` × this ≈ 4–7 cm), and its root collar (`m`).
 */
const DRAPERY_MIN_SHEET = 0.038
const DRAPERY_SHEET = 0.3
const DRAPERY_COLLAR = 0.1
/** How far (`m`) a drapery's sheet runs up into the rock above its anchors. */
const DRAPERY_ROOT = 0.25
/**
 * A drapery's fillet with the ceiling (`m`) and its cell: also its feature cell but within `DRAPERY_RIM` (`m`) of its
 * rim (the ends and the fringe, rounded tighter than a cell), where cells go down to `FINEST_CELL`. Elsewhere its
 * mid-surface would read as a crease.
 */
const DRAPERY_BLEND = 0.08
const DRAPERY_CELL = 0.025
const DRAPERY_RIM = 0.06

/**
 * Ambient-occlusion probe distances (`m`) along the normal and their weights: sub-voxel scale only (the VXGI light
 * maps resolve ~23 cm and up).
 */
const AO_STEPS = [0.04, 0.1, 0.2, 0.34] as const
const AO_WEIGHTS = [0.4, 0.3, 0.2, 0.1] as const

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
  return t * t * (3.0 - 2.0 * t)
}

/** Distance from `(x, y, z)` to a body's bounds (`0` inside): a lower bound of its distance. */
function boundsDistance(b: HollowBody, x: number, y: number, z: number) {
  const gx = Math.max(0, b.min.x - x, x - b.max.x)
  const gy = Math.max(0, b.min.y - y, y - b.max.y)
  const gz = Math.max(0, b.min.z - z, z - b.max.z)
  return Math.sqrt(gx * gx + gy * gy + gz * gz)
}

/** Quílez's round cone: spheres `(a, ra)` and `(b, rb)` and their tangent cone. */
export function roundCone(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, ra: number,
  bx: number, by: number, bz: number, rb: number,
): number {
  const bax = bx - ax
  const bay = by - ay
  const baz = bz - az
  const l2 = bax * bax + bay * bay + baz * baz
  const rr = ra - rb
  const a2 = l2 - rr * rr
  const pax = px - ax
  const pay = py - ay
  const paz = pz - az
  // One sphere holds the other: the larger one
  if (a2 <= 1e-12) return Math.min(Math.hypot(pax, pay, paz) - ra, Math.hypot(px - bx, py - by, pz - bz) - rb)
  const il2 = 1 / l2
  const y = pax * bax + pay * bay + paz * baz
  const z = y - l2
  const qx = pax * l2 - bax * y
  const qy = pay * l2 - bay * y
  const qz = paz * l2 - baz * y
  const x2 = qx * qx + qy * qy + qz * qz
  const y2 = y * y * l2
  const z2 = z * z * l2
  const k = Math.sign(rr) * rr * rr * x2
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra
}

/** Cleavage planes and the radius they cut, from the unit-sphere planes of a boulder of `radii`. */
export function rockBody(
  center: Vector3, quaternion: Quaternion, radii: Vector3, unitPlanes: Float32Array, unitBevel: number, seed: number,
): HollowRockBody {
  const m = new Matrix4().makeRotationFromQuaternion(quaternion.clone().invert()).elements
  // Column-major `Matrix4` -> row-major `3×3`
  const rotation = new Float32Array([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]])
  const planes = new Float32Array(unitPlanes.length)
  for (let p = 0; p < unitPlanes.length; p += 4) {
    // `n · (l / radii) = w`: the body-frame normal `n / radii`, normalised
    const nx = unitPlanes[p] / radii.x
    const ny = unitPlanes[p + 1] / radii.y
    const nz = unitPlanes[p + 2] / radii.z
    const len = Math.hypot(nx, ny, nz)
    planes.set([nx / len, ny / len, nz / len, unitPlanes[p + 3] / len], p)
  }
  const mean = Math.cbrt(radii.x * radii.y * radii.z)
  const minRadius = Math.min(radii.x, radii.y, radii.z)
  // Relief over the faces, well under the cleavage (or the facets melt into lumps)
  const relief = 0.035 * mean
  // World half-extents of the ellipsoid (`1.12` radii): `sqrt(sum_j (R_ij a_j)^2)` with `R` body -> world
  const extent = new Vector3()
  const a = [1.12 * radii.x, 1.12 * radii.y, 1.12 * radii.z]
  for (let i = 0; i < 3; i++) {
    // `R = rotation^T`: `R_ij = rotation[j * 3 + i]`
    const e = Math.hypot(rotation[i] * a[0], rotation[3 + i] * a[1], rotation[6 + i] * a[2])
    extent.setComponent(i, e + relief + 0.05)
  }
  return {
    kind: 'rock',
    min: center.clone().sub(extent),
    max: center.clone().add(extent),
    blend: MathUtils.clamp(0.7 * minRadius, 0.12, 0.5),
    cell: MathUtils.clamp(minRadius / 8, 0.025, 0.05),
    feature: FINEST_CELL,
    center: center.clone(),
    rotation,
    radii: radii.clone(),
    planes,
    bevel: unitBevel * mean,
    relief,
    seed,
  }
}

/** Radius (`m`) of a dripstone's tip: past one finest cell, so its two sides never share one. */
const DRIPSTONE_TIP = 0.015

export interface DripstoneSpec {
  anchor: Vector3
  /** The host's normal at the anchor (the root grows along it, bending plumb by a fifth of the length). */
  hostNormal: Vector3
  hanging: boolean
  length: number
  baseRadius: number
  flutes: number
  /** Flute depth relative to the radius. */
  fluteDepth: number
  /** Growth-ring frequency along the length and its phase. */
  ringFreq: number
  phase: number
}

/** Rings along the spine of a fluted stalactite (tapered icicle tip) or pagoda stalagmite (rounded dome). */
export function dripstoneBody(spec: DripstoneSpec): HollowDripstoneBody {
  const {anchor, hostNormal, hanging, length, baseRadius, flutes, fluteDepth, ringFreq, phase} = spec
  const gravity = hanging ? -1 : 1
  const cell = MathUtils.clamp(baseRadius / 3, 0.025, 0.1)
  const tip = DRIPSTONE_TIP
  const rings = MathUtils.clamp(Math.ceil(length / 0.06), 8, 24)

  const spine = new Float32Array((rings + 2) * 4)
  const depth = new Float32Array(rings + 2)
  // The root ring is buried in the host
  const rootDepth = 0.5 * baseRadius + 0.035
  let cx = anchor.x - hostNormal.x * rootDepth
  let cy = anchor.y - hostNormal.y * rootDepth
  let cz = anchor.z - hostNormal.z * rootDepth
  spine.set([cx, cy, cz, baseRadius], 0)
  cx = anchor.x
  cy = anchor.y
  cz = anchor.z
  const ds = length / rings
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (let r = 0; r <= rings; r++) {
    const t = r / rings
    if (r > 0) {
      // Along the host normal at the root, plumb by `t = 0.22`
      const plumb = smoothstep(0.0, 0.22, t)
      let dx = MathUtils.lerp(hostNormal.x, 0.0, plumb)
      let dy = MathUtils.lerp(hostNormal.y, gravity, plumb)
      let dz = MathUtils.lerp(hostNormal.z, 0.0, plumb)
      const len = Math.hypot(dx, dy, dz) || 1.0
      dx /= len
      dy /= len
      dz /= len
      cx += dx * ds
      cy += dy * ds
      cz += dz * ds
    }
    let radius: number
    if (hanging) {
      const taper = Math.pow(Math.max(0.0, 1.0 - t), 0.68)
      const bulge = 1.0 + 0.09 * Math.sin(t * ringFreq + phase) * (1.0 - t)
      radius = baseRadius * taper * bulge + 0.008 * (1.0 - t * 0.5)
    } else {
      const pagoda = 1.0 + 0.15 * Math.sin(t * ringFreq + phase) * (1.0 - smoothstep(0.82, 1.0, t))
      const dome = Math.sqrt(Math.max(0.0, 1.0 - Math.pow(Math.max(0.0, (t - 0.72) / 0.28), 2.0)))
      radius = baseRadius * (1.0 - 0.52 * t) * dome * pagoda
    }
    radius = Math.max(tip, radius)
    // Flutes only where the cells resolve them (a wavelength of four cells and up)
    const envelope = smoothstep(0.06, 0.28, t) * (1.0 - smoothstep(0.82, 0.99, t))
    const wavelength = (2 * Math.PI * radius) / flutes
    depth[r + 1] = fluteDepth * radius * envelope * smoothstep(2 * cell, 4 * cell, wavelength)
    spine.set([cx, cy, cz, radius], (r + 1) * 4)
  }
  for (let i = 0; i < spine.length; i += 4) {
    const reach = spine[i + 3] + depth[i / 4] + 0.01
    min.min(new Vector3(spine[i] - reach, spine[i + 1] - reach, spine[i + 2] - reach))
    max.max(new Vector3(spine[i] + reach, spine[i + 1] + reach, spine[i + 2] + reach))
  }
  const segments = new Float32Array((rings + 1) * 4)
  for (let i = 0; i <= rings; i++) {
    const o = i * 4
    const half = 0.5 * Math.hypot(spine[o + 4] - spine[o], spine[o + 5] - spine[o + 1], spine[o + 6] - spine[o + 2])
    const radius = Math.max(spine[o + 3] + depth[i], spine[o + 7] + depth[i + 1])
    segments.set([
      0.5 * (spine[o] + spine[o + 4]), 0.5 * (spine[o + 1] + spine[o + 5]), 0.5 * (spine[o + 2] + spine[o + 6]),
      half + radius,
    ], o)
  }

  // The flutes' azimuth turns in a horizontal frame aligned with the host's slope
  let fx = hostNormal.x
  let fz = hostNormal.z
  const fl = Math.hypot(fx, fz)
  if (fl < 1e-3) {
    fx = 1
    fz = 0
  } else {
    fx /= fl
    fz /= fl
  }
  return {
    kind: 'dripstone',
    min,
    max,
    blend: MathUtils.clamp(baseRadius, 0.05, 0.3),
    cell,
    feature: FINEST_CELL,
    hanging,
    spine,
    segments,
    frame: new Float32Array([fx, fz, -fz, fx]),
    flutes,
    fluteDepth: depth,
    phase,
  }
}

export interface DraperySpec {
  /** The anchor curve under the ceiling, a point per column (`x y z`). */
  curve: Float32Array
  drop: number
  thickness: number
  foldPhase: number
  flutePhase: number
}

/** A drapery hanging from its anchor curve (see `HollowDraperyBody`). */
export function draperyBody(spec: DraperySpec): HollowDraperyBody {
  const {curve, drop, thickness} = spec
  const n = curve.length / 3
  const tangents = new Float32Array((n - 1) * 3)
  let length = 0
  for (let i = 0; i < n - 1; i++) {
    const dx = curve[i * 3 + 3] - curve[i * 3]
    const dz = curve[i * 3 + 5] - curve[i * 3 + 2]
    const len = Math.hypot(dx, dz) || 1e-6
    tangents.set([dx / len, dz / len, len], i * 3)
    length += len
  }
  // Its sheet's reach off the curve: folds, flutes, collar
  const reach = 0.055 + 0.5 * (thickness * DRAPERY_SHEET * 1.3 + DRAPERY_MIN_SHEET + DRAPERY_COLLAR) + 0.02
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i < n; i++) {
    const x = curve[i * 3]
    const y = curve[i * 3 + 1]
    const z = curve[i * 3 + 2]
    min.min(new Vector3(x - reach, y - drop * 1.15 - 0.05, z - reach))
    max.max(new Vector3(x + reach, y + DRAPERY_ROOT + 0.02, z + reach))
  }
  return {
    kind: 'drapery',
    min,
    max,
    blend: DRAPERY_BLEND,
    cell: DRAPERY_CELL,
    feature: DRAPERY_CELL,
    curve,
    tangents,
    length,
    drop,
    thickness,
    foldPhase: spec.foldPhase,
    flutePhase: spec.flutePhase,
  }
}

/** Zones (`aZone`) of dripstone calcite, wetter toward the tip. */
function dripstoneZones(body: HollowDripstoneBody, t: number, out: Float32Array) {
  const wetness = body.hanging
    ? MathUtils.clamp(0.45 + 0.55 * smoothstep(0.45, 0.95, t), 0.0, 1.0)
    : MathUtils.clamp(0.55 + 0.35 * smoothstep(0.65, 1.0, t), 0.0, 1.0)
  out[0] = 0.15
  out[1] = 0.92
  out[2] = 0.0
  out[3] = wetness
}

/**
 * The cave and its bodies as one signed distance field (`> 0` in the open): the cave closed by the volume's sides
 * and floor, each body smoothly united with the cave and the bodies before it, so boulders and dripstones grow out
 * of the rock with fillets. The material zones blend with the same weights, a little wider, so texture and wetness
 * run across the fillets too. Meshed by `contourOctree`: cave cells of `CAVE_CELL`, finer ones around the bodies and
 * the rimstone dam.
 */
export class HollowSculpt {

  readonly field: HollowField
  readonly bodies: HollowBody[]
  /** Reach (`m`) of each body: its fillet and its material spread. */
  private readonly reach: Float32Array
  private readonly nx: number
  private readonly ny: number
  private readonly nz: number
  private readonly cells: Int32Array[]
  private readonly rimMin = new Vector3()
  private readonly rimMax = new Vector3()
  /** The dam's smallest radius (`m`, where `rimstoneCoord` is `1`). */
  private readonly rimRadius: number
  /** Every body's index: the octree's root context. */
  private readonly all: Int32Array
  /** Spine parameter `t` of the last dripstone distance, or `v` (down the sheet) of the last drapery distance. */
  private lastT = 0
  /** Thickness (`m`) and height above the growing edge (`m`) of the last drapery distance's sheet. */
  private readonly lastSheet = new Float32Array(2)
  /** How far (`m`, along the sheet) the last drapery distance's point is from the sheet's rim. */
  private lastRim = 0
  private readonly own = new Float32Array(4)
  /** The feature cell `cellFor` found with its cell. */
  private featureCell = CAVE_FEATURE_CELL

  constructor(field: HollowField, bodies: HollowBody[]) {
    this.field = field
    this.bodies = bodies
    this.reach = new Float32Array(bodies.map(b => Math.max(1.5, MATERIAL_SPREAD) * b.blend))
    this.nx = Math.ceil((HOLLOW_MAX.x - HOLLOW_MIN.x) / GRID_CELL)
    this.ny = Math.ceil((HOLLOW_MAX.y - HOLLOW_MIN.y) / GRID_CELL)
    this.nz = Math.ceil((HOLLOW_MAX.z - HOLLOW_MIN.z) / GRID_CELL)
    const lists: number[][] = Array.from({length: this.nx * this.ny * this.nz}, () => [])
    bodies.forEach((b, id) => {
      const r = this.reach[id]
      const i0 = this.cellIndex(b.min.x - r, 0, this.nx)
      const j0 = this.cellIndex(b.min.y - r, 1, this.ny)
      const k0 = this.cellIndex(b.min.z - r, 2, this.nz)
      const i1 = this.cellIndex(b.max.x + r, 0, this.nx)
      const j1 = this.cellIndex(b.max.y + r, 1, this.ny)
      const k1 = this.cellIndex(b.max.z + r, 2, this.nz)
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) lists[i + this.nx * (j + this.ny * k)].push(id)
        }
      }
    })
    this.cells = lists.map(l => new Int32Array(l))
    this.all = new Int32Array(bodies.map((_, i) => i))

    // The rimstone dam: `rimstoneCoord < 1.45` within half a metre of the water
    const wl = field.params.waterLevel
    this.rimRadius = Math.max(0.3, (field.rimstoneReach / 1.6) * 0.5)
    const reach = field.rimstoneReach * 1.15 + 0.5
    this.rimMin.set(field.rimstoneCenter.x - reach, wl - 0.4, field.rimstoneCenter.z - reach)
    this.rimMax.set(field.rimstoneCenter.x + reach, wl + 0.55, field.rimstoneCenter.z + reach)
  }

  private cellIndex(v: number, axis: number, n: number) {
    return MathUtils.clamp(Math.floor((v - HOLLOW_MIN.getComponent(axis)) / GRID_CELL), 0, n - 1)
  }

  private bodiesAt(x: number, y: number, z: number) {
    return this.cells[this.cellIndex(x, 0, this.nx) + this.nx * (this.cellIndex(y, 1, this.ny) + this.ny * this.cellIndex(z, 2, this.nz))]
  }

  /** Whether `(x, y, z)` is within body `id`'s reach (its bounds grown by it). */
  private reaches(id: number, x: number, y: number, z: number) {
    const b = this.bodies[id]
    const r = this.reach[id]
    return x > b.min.x - r && x < b.max.x + r && y > b.min.y - r && y < b.max.y + r && z > b.min.z - r && z < b.max.z + r
  }

  /** The cave alone, closed by the volume's sides and floor (open at the top, the skylight's shaft). */
  caveDistance(x: number, y: number, z: number): number {
    // Inset off the lattice planes at the volume's sides (the octree prunes beyond them unevaluated)
    const box = Math.min(x - HOLLOW_MIN.x, HOLLOW_MAX.x - x, z - HOLLOW_MIN.z, HOLLOW_MAX.z - z, y - HOLLOW_MIN.y)
      - BOX_INSET
    // Well outside the volume it's rock: the box alone bounds it
    if (box < -0.5) return box
    return Math.min(this.field.sample(x, y, z), box)
  }

  /**
   * Signed distance (`m`) from `(x, y, z)` to `body` (sets `lastT` for a dripstone), exact below `limit`: beyond it,
   * any value at least `limit`.
   */
  bodyDistance(body: HollowBody, x: number, y: number, z: number, limit = Infinity): number {
    if (body.kind === 'dripstone') return this.dripstoneDistance(body, x, y, z, limit)
    if (body.kind === 'drapery') return this.draperyDistance(body, x, y, z)
    return this.rockDistance(body, x, y, z)
  }

  private rockDistance(body: HollowRockBody, x: number, y: number, z: number): number {
    const R = body.rotation
    const dx = x - body.center.x
    const dy = y - body.center.y
    const dz = z - body.center.z
    const lx = R[0] * dx + R[1] * dy + R[2] * dz
    const ly = R[3] * dx + R[4] * dy + R[5] * dz
    const lz = R[6] * dx + R[7] * dy + R[8] * dz
    // Quílez's ellipsoid bound
    const ax = 1.12 * body.radii.x
    const ay = 1.12 * body.radii.y
    const az = 1.12 * body.radii.z
    const ex = lx / ax
    const ey = ly / ay
    const ez = lz / az
    const k0 = Math.sqrt(ex * ex + ey * ey + ez * ez)
    const k1 = Math.sqrt((ex * ex) / (ax * ax) + (ey * ey) / (ay * ay) + (ez * ez) / (az * az))
    let d = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(ax, ay, az)
    const P = body.planes
    for (let p = 0; p < P.length; p += 4) d = smax(d, P[p] * lx + P[p + 1] * ly + P[p + 2] * lz - P[p + 3], body.bevel)
    // Relief and bedding notches over the unit-sphere direction
    const qx = lx / body.radii.x
    const qy = ly / body.radii.y
    const qz = lz / body.radii.z
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz)
    if (ql > 1e-6) {
      const s = body.seed
      d -= body.relief * this.field.fbm3((qx / ql) * 2.3 + s * 0.13, (qy / ql) * 2.8 - s * 0.07, (qz / ql) * 2.3 + s * 0.19, 3)
      d += 0.022 * Math.sin((y + 0.04 * x) * 13.5) * (Math.sqrt(qx * qx + qz * qz) / ql)
    }
    return d
  }

  private dripstoneDistance(body: HollowDripstoneBody, x: number, y: number, z: number, limit: number): number {
    const S = body.spine
    const B = body.segments
    const rings = S.length / 4 - 1
    let d = limit
    let best = -1
    // Start at the segment level with the point (along root -> tip): the bound then rules out most of the others
    const tx = S[S.length - 4] - S[4]
    const ty = S[S.length - 3] - S[5]
    const tz = S[S.length - 2] - S[6]
    const along = ((x - S[4]) * tx + (y - S[5]) * ty + (z - S[6]) * tz) / (tx * tx + ty * ty + tz * tz)
    const start = MathUtils.clamp(Math.round(along * (rings - 1)) + 1, 0, rings - 1)
    for (let k = 0; k < rings; k++) {
      const i = k === 0 ? start : k <= start ? k - 1 : k
      const o = i * 4
      // The segment's bounding sphere bounds its distance from below
      const reach = d + B[o + 3]
      if (reach >= 0) {
        const bx = x - B[o]
        const by = y - B[o + 1]
        const bz = z - B[o + 2]
        if (bx * bx + by * by + bz * bz >= reach * reach) continue
      }
      const di = roundCone(x, y, z, S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4], S[o + 5], S[o + 6], S[o + 7])
      if (di < d) {
        d = di
        best = i
      }
    }
    if (best < 0) return limit
    // Where along the closest segment, and its flutes
    const o = best * 4
    const sx = S[o + 4] - S[o]
    const sy = S[o + 5] - S[o + 1]
    const sz = S[o + 6] - S[o + 2]
    const s2 = sx * sx + sy * sy + sz * sz
    const bestH = s2 > 0 ? MathUtils.clamp(((x - S[o]) * sx + (y - S[o + 1]) * sy + (z - S[o + 2]) * sz) / s2, 0, 1) : 0
    // Ring `0` is the buried root, ring `1` the anchor (`t = 0`)
    this.lastT = MathUtils.clamp((best - 1 + bestH) / (rings - 1), 0, 1)
    const depth = MathUtils.lerp(body.fluteDepth[best], body.fluteDepth[best + 1], bestH)
    if (depth > 1e-4) {
      const cx = S[o] + sx * bestH
      const cz = S[o + 2] + sz * bestH
      const F = body.frame
      const ox = x - cx
      const oz = z - cz
      const theta = Math.atan2(F[2] * ox + F[3] * oz, F[0] * ox + F[1] * oz)
      d -= depth * Math.cos(body.flutes * theta + body.phase + this.lastT * 0.8)
    }
    return d
  }

  /** The drapery's sheet (sets `lastT` to `v` and `lastSheet`): rounded at its fringe and ends, buried at its root. */
  private draperyDistance(body: HollowDraperyBody, x: number, y: number, z: number): number {
    const C = body.curve
    const T = body.tangents
    const segments = T.length / 3
    // The closest segment of the curve (in `xz`)
    let best = Infinity
    let bi = 0
    for (let i = 0; i < segments; i++) {
      const px = x - C[i * 3]
      const pz = z - C[i * 3 + 2]
      const t = MathUtils.clamp(px * T[i * 3] + pz * T[i * 3 + 1], 0, T[i * 3 + 2])
      const qx = px - T[i * 3] * t
      const qz = pz - T[i * 3 + 1] * t
      const d2 = qx * qx + qz * qz
      if (d2 < best) {
        best = d2
        bi = i
      }
    }
    const tx = T[bi * 3]
    const tz = T[bi * 3 + 1]
    const len = T[bi * 3 + 2]
    const px = x - C[bi * 3]
    const pz = z - C[bi * 3 + 2]
    const along = px * tx + pz * tz
    // Across the curve (along its normal `(-tz, tx)`), and past its ends
    const across = pz * tx - px * tz
    let past = 0
    if (bi === 0 && along < 0) past = -along
    else if (bi === segments - 1 && along > len) past = along - len
    const f = MathUtils.clamp(along / len, 0, 1)
    const u = (bi + f) / segments
    const anchorY = C[bi * 3 + 1] + (C[bi * 3 + 4] - C[bi * 3 + 1]) * f

    // Lowest in the middle, a sawtooth of organ pipes along the fringe; the growing edge without it
    const arch = Math.sin(u * Math.PI) * 0.72 + 0.28
    const fold = Math.sin(u * 13.0 + body.foldPhase)
    const tooth = 0.5 + 0.5 * Math.cos(u * 34.0 + body.flutePhase)
    const drop = body.drop * arch * (0.68 + 0.32 * Math.pow(tooth, 1.8) + 0.14 * fold)
    const edgeDrop = body.drop * arch * (0.84 + 0.14 * fold)
    const v = MathUtils.clamp((anchorY - y) / drop, 0, 1)
    // A few centimetres, thicker along the pipes and into the root collar
    const pipe = Math.abs(Math.sin(u * 34.0 + body.flutePhase * 0.5))
    const rib = 1 - pipe * pipe * pipe
    const collar = 1 - smoothstep(0, 0.18, v)
    const sheet = smax(body.thickness * DRAPERY_SHEET * (1 - 0.65 * v) * (0.55 + 0.75 * rib), DRAPERY_MIN_SHEET, 0.01)
      + DRAPERY_COLLAR * collar * collar
    const h = 0.5 * sheet
    const lateral = across - 0.055 * Math.sin(u * 19.0 + body.foldPhase) * smoothstep(0.05, 0.5, v)
    // The mid-surface runs from the fringe (its rounded edge's lowest point `drop` down) up into the rock
    const dy = Math.max(anchorY - drop + h - y, y - anchorY - DRAPERY_ROOT, 0)
    this.lastT = v
    this.lastSheet[0] = sheet
    this.lastSheet[1] = y - (anchorY - edgeDrop)
    this.lastRim = Math.min(y - (anchorY - drop), u * body.length, (1 - u) * body.length) - past
    return Math.sqrt(lateral * lateral + dy * dy + past * past) - h
  }

  /**
   * The field through the bodies of `ids` that reach `(x, y, z)` (the same for any list holding those). A body
   * farther than its blend beyond the field so far leaves it unchanged: its bounds rule most out unevaluated.
   */
  private distanceWith(x: number, y: number, z: number, ids: ArrayLike<number>): number {
    let d = this.caveDistance(x, y, z)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!this.reaches(id, x, y, z)) continue
      const body = this.bodies[id]
      const limit = d + body.blend
      if (boundsDistance(body, x, y, z) >= limit) continue
      d = smin(d, this.bodyDistance(body, x, y, z, limit), body.blend)
    }
    return d
  }

  /** Signed distance (`m`) of the cave with its bodies. */
  distance(x: number, y: number, z: number): number {
    return this.distanceWith(x, y, z, this.bodiesAt(x, y, z))
  }

  /**
   * `aZone` (`out`) and `aSheet` (`sheet`) at a surface point with normal `ny` up: the cave's, blended toward each
   * body's across its fillet.
   */
  zonesAt(x: number, y: number, z: number, ny: number, out: Float32Array, sheet: Float32Array) {
    const cave = this.field.zonesAt(x, y, z, ny)
    out[0] = cave.strata
    out[1] = cave.travertine
    out[2] = cave.rimstone
    out[3] = cave.wetness
    sheet[0] = OPAQUE_SHEET
    sheet[1] = 0
    const ids = this.bodiesAt(x, y, z)
    if (!ids.length) return
    const own = this.own
    let d = this.caveDistance(x, y, z)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!this.reaches(id, x, y, z)) continue
      const body = this.bodies[id]
      const limit = d + MATERIAL_SPREAD * body.blend
      if (boundsDistance(body, x, y, z) >= limit) continue
      const di = this.bodyDistance(body, x, y, z, limit)
      const w = MathUtils.clamp(0.5 + (0.5 * (d - di)) / (MATERIAL_SPREAD * body.blend), 0, 1)
      if (body.kind === 'dripstone') dripstoneZones(body, this.lastT, own)
      else if (body.kind === 'drapery') own.set([0.1, 0.96, 0.0, 0.55 + 0.4 * this.lastT])
      else own.set([Math.max(cave.strata, 0.55), cave.travertine, cave.rimstone, cave.wetness])
      for (let c = 0; c < 4; c++) out[c] += (own[c] - out[c]) * w
      if (body.kind === 'drapery') {
        sheet[0] += (this.lastSheet[0] - sheet[0]) * w
        sheet[1] += (this.lastSheet[1] - sheet[1]) * w
      } else {
        sheet[0] += (OPAQUE_SHEET - sheet[0]) * w
      }
      d = smin(d, di, body.blend)
    }
  }

  /**
   * Target cell size (`m`) for a box (`min`, edge `size`) near the bodies of `ids`; and (`featureCell`) the smallest
   * its creases and thin features may split into.
   */
  private cellFor(x: number, y: number, z: number, size: number, ids: ArrayLike<number>) {
    let cell = CAVE_CELL
    let feature = CAVE_FEATURE_CELL
    const rm = this.rimMin
    const rM = this.rimMax
    if (x < rM.x && x + size > rm.x && y < rM.y && y + size > rm.y && z < rM.z && z + size > rm.z) {
      // The dam itself (`rimstoneCoord < 1.45`), give or take the box (the coordinate runs `~1` per dam radius)
      const u = this.field.rimstoneCoord(x + 0.5 * size, z + 0.5 * size)
      if (u < 1.45 + (2 * size) / this.rimRadius) {
        cell = RIM_CELL
        feature = RIM_FEATURE_CELL
      }
    }
    const h = 0.5 * size
    const r = h * Math.sqrt(3)
    for (let i = 0; i < ids.length; i++) {
      const b = this.bodies[ids[i]]
      const gx = Math.max(0, b.min.x - (x + size), x - b.max.x)
      const gy = Math.max(0, b.min.y - (y + size), y - b.max.y)
      const gz = Math.max(0, b.min.z - (z + size), z - b.max.z)
      // Its bounds, then (when they'd refine) the body itself, bound how far the box is from it
      let gap = Math.sqrt(gx * gx + gy * gy + gz * gz)
      if (b.cell + CELL_GRADE * gap >= cell && gap >= b.blend) continue
      gap = Math.max(gap, Math.abs(this.bodyDistance(b, x + h, y + h, z + h)) - r)
      cell = Math.min(cell, b.cell + CELL_GRADE * gap)
      if (gap >= b.blend) continue
      const rim = b.kind === 'drapery' && this.lastRim < DRAPERY_RIM + r
      feature = Math.min(feature, rim ? FINEST_CELL : b.feature)
    }
    this.featureCell = feature
    return cell
  }

  private visit(
    x: number, y: number, z: number, size: number, parent: Int32Array, corners: () => Float32Array,
  ): OctreeVisit<Int32Array> | null {
    if (x >= HOLLOW_MAX.x || y >= HOLLOW_MAX.y || z >= HOLLOW_MAX.z) return null
    const ids: number[] = []
    for (let i = 0; i < parent.length; i++) {
      const id = parent[i]
      const b = this.bodies[id]
      const r = this.reach[id]
      if (x < b.max.x + r && x + size > b.min.x - r && y < b.max.y + r && y + size > b.min.y - r
        && z < b.max.z + r && z + size > b.min.z - r) ids.push(id)
    }
    const h = size * 0.5
    const d = this.distanceWith(x + h, y + h, z + h, ids)
    const r = h * Math.sqrt(3)
    if (Math.abs(d) > LIPSCHITZ * r) return null
    const context = ids.length === parent.length ? parent : new Int32Array(ids)
    // Crossed where a corner's side differs from the centre's. Else probably empty where every sample is farther from
    // the surface than its half-diagonal, and than the field changes across it (it bends: no slope extrapolates it)
    const c = corners()
    const inside = d < 0
    let crossed = false
    let sum = 0
    let low = Math.abs(d)
    let lo = d
    let hi = d
    for (let i = 0; i < 8; i++) {
      if ((c[i] < 0) !== inside) crossed = true
      sum += c[i]
      low = Math.min(low, Math.abs(c[i]))
      lo = Math.min(lo, c[i])
      hi = Math.max(hi, c[i])
    }
    if (!crossed && low > Math.max(LIKELY_EMPTY * r, hi - lo)) return {split: false, context}
    if (size > this.cellFor(x, y, z, size, ids) * 1.001) return {split: true, context}
    if (!crossed || size <= this.featureCell * 1.001) return {split: false, context}
    // A flat facet's sagitta across the node: the surface's bend, or two sheets (the slope cancels between them)
    const gx = c[1] - c[0] + c[3] - c[2] + c[5] - c[4] + c[7] - c[6]
    const gy = c[2] - c[0] + c[3] - c[1] + c[6] - c[4] + c[7] - c[5]
    const gz = c[4] - c[0] + c[5] - c[1] + c[6] - c[2] + c[7] - c[3]
    const slope = Math.sqrt(gx * gx + gy * gy + gz * gz) / (4 * size)
    const sagitta = Math.abs(sum / 8 - d) / Math.max(slope, 1e-3)
    return {split: sagitta > FEATURE_BEND * size, context}
  }

  /**
   * Meshes one slab of the cave (`hollowSlabs`): vertices projected onto the surface and relaxed over it, normals
   * from its gradient (the light maps bake from them, so body and cave light as one surface), blended
   * zones (`aZone`) and ambient occlusion (`aOcclusion`, `1` open … `0` buried: the creases finer than the VXGI
   * voxels). `assembleSculpt` joins the slabs.
   */
  sculptSlab(slab: OctreeSlab): HollowSculptPart {
    const contour = contourOctree(
      {
        distance: (x, y, z) => this.distance(x, y, z),
        visit: (x, y, z, size, parent: Int32Array, corners) => this.visit(x, y, z, size, parent, corners),
        emit: (_x, y) => y < HOLLOW_MAX.y,
      },
      HOLLOW_MIN,
      FINEST_CELL * (1 << DEPTH),
      DEPTH,
      this.all,
      slab,
    )
    const {positions, cells} = contour
    const count = positions.length / 3
    const normals = new Float32Array(count * 3)
    const zones = new Float32Array(count * 4)
    const sheets = new Float32Array(count * 2)
    const occlusion = new Float32Array(count)
    const zone = new Float32Array(4)
    const sheet = new Float32Array(2)
    const g = [0, 0, 0]

    /** Tetrahedral gradient (`g`) at `(x, y, z)`; returns the distance there (not the samples' mean: creases bias it). */
    const gradient = (x: number, y: number, z: number, e: number) => {
      const a = this.distance(x + e, y - e, z - e)
      const b = this.distance(x - e, y - e, z + e)
      const c = this.distance(x - e, y + e, z - e)
      const d = this.distance(x + e, y + e, z + e)
      g[0] = (a - b - c + d) / (4 * e)
      g[1] = (-a - b + c + d) / (4 * e)
      g[2] = (-a + b - c + d) / (4 * e)
      return this.distance(x, y, z)
    }

    /** The field's slope at each vertex (with its normal: the gradient). */
    const slopes = new Float32Array(count).fill(1)
    /**
     * A Newton step of vertex `v` onto the surface, kept within its cell grown by `margin` × its size: along a fresh
     * gradient (`fresh`, which becomes its normal: it barely changes over the step), else along its normal.
     */
    const project = (v: number, margin: number, fresh: boolean) => {
      let x = positions[v * 3]
      let y = positions[v * 3 + 1]
      let z = positions[v * 3 + 2]
      const s = cells[v * 4 + 3]
      let d: number
      if (fresh) {
        d = gradient(x, y, z, MathUtils.clamp(0.15 * s, 0.004, 0.02))
        const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2])
        if (gl > 1e-5) {
          normals[v * 3] = g[0] / gl
          normals[v * 3 + 1] = g[1] / gl
          normals[v * 3 + 2] = g[2] / gl
          slopes[v] = gl
        }
      } else {
        d = this.distance(x, y, z)
      }
      const t = MathUtils.clamp(d / slopes[v], -0.5 * s, 0.5 * s)
      const m = margin * s
      x = MathUtils.clamp(x - normals[v * 3] * t, cells[v * 4] - m, cells[v * 4] + s + m)
      y = MathUtils.clamp(y - normals[v * 3 + 1] * t, cells[v * 4 + 1] - m, cells[v * 4 + 1] + s + m)
      z = MathUtils.clamp(z - normals[v * 3 + 2] * t, cells[v * 4 + 2] - m, cells[v * 4 + 2] + s + m)
      positions[v * 3] = x
      positions[v * 3 + 1] = y
      positions[v * 3 + 2] = z
    }

    // 1. From the mass points (within a fraction of their cells of the surface) onto it
    for (let v = 0; v < count; v++) {
      normals[v * 3 + 1] = 1
      project(v, 0, true)
    }

    // 2. Relaxed over the surface: each vertex toward its neighbours' mean along its tangent plane, then back onto
    // the surface. Unfolds the polygons where the surface grazes a cell's face (its crossings there land anywhere
    // along their edges) and evens out the triangles. Vertices on the slab's faces stay: their neighbours across
    // aren't all here
    const {quads} = contour
    const start = new Int32Array(count + 1)
    const fixed = new Uint8Array(count)
    for (const v of contour.boundaryVertices) fixed[v] = 1
    const eachSide = (visit: (a: number, b: number) => void) => {
      for (let q = 0; q < quads.length; q += 4) {
        const k = quads[q + 3] === -1 ? 3 : 4
        for (let i = 0; i < k; i++) visit(quads[q + i], quads[q + (i + 1) % k])
      }
    }
    eachSide((a, b) => {
      if (a >= 0 && b >= 0) {
        start[a + 1]++
        start[b + 1]++
      } else {
        if (a >= 0) fixed[a] = 1
        if (b >= 0) fixed[b] = 1
      }
    })
    for (let v = 0; v < count; v++) start[v + 1] += start[v]
    const next = start.slice(0, count)
    const ring = new Int32Array(start[count])
    eachSide((a, b) => {
      if (a < 0 || b < 0) return
      ring[next[a]++] = b
      ring[next[b]++] = a
    })
    for (let step = 0; step < RELAX_STEPS; step++) {
      const from = positions.slice()
      for (let v = 0; v < count; v++) {
        if (fixed[v] || start[v + 1] === start[v]) continue
        let mx = 0
        let my = 0
        let mz = 0
        for (let i = start[v]; i < start[v + 1]; i++) {
          mx += from[ring[i] * 3]
          my += from[ring[i] * 3 + 1]
          mz += from[ring[i] * 3 + 2]
        }
        const k = 1 / (start[v + 1] - start[v])
        const dx = mx * k - from[v * 3]
        const dy = my * k - from[v * 3 + 1]
        const dz = mz * k - from[v * 3 + 2]
        const nx = normals[v * 3]
        const ny = normals[v * 3 + 1]
        const nz = normals[v * 3 + 2]
        const dn = dx * nx + dy * ny + dz * nz
        positions[v * 3] = from[v * 3] + RELAX * (dx - dn * nx)
        positions[v * 3 + 1] = from[v * 3 + 1] + RELAX * (dy - dn * ny)
        positions[v * 3 + 2] = from[v * 3 + 2] + RELAX * (dz - dn * nz)
        project(v, RELAX_MARGIN, false)
      }
    }
    // Their normals where they ended
    for (let v = 0; v < count; v++) project(v, RELAX_MARGIN, true)

    // 3. Material zones, sheet and contact occlusion where they ended
    for (let v = 0; v < count; v++) {
      const x = positions[v * 3]
      const y = positions[v * 3 + 1]
      const z = positions[v * 3 + 2]
      const nx = normals[v * 3]
      const ny = normals[v * 3 + 1]
      const nz = normals[v * 3 + 2]
      this.zonesAt(x, y, z, ny, zone, sheet)
      zones.set(zone, v * 4)
      sheets.set(sheet, v * 2)

      let occluded = 0
      for (let i = 0; i < AO_STEPS.length; i++) {
        const h = AO_STEPS[i]
        const d = this.distance(x + nx * h, y + ny * h, z + nz * h)
        occluded += AO_WEIGHTS[i] * MathUtils.clamp((h - d) / h, 0, 1)
      }
      occlusion[v] = 1 - occluded
    }

    return {contour, normals, zones, sheets, occlusion}
  }

  /** The whole cave, slab after slab on this thread (`HollowSculptPool` meshes them in parallel). */
  buildGeometry(): BufferGeometry {
    return assembleSculpt(hollowSlabs().map(slab => this.sculptSlab(slab)))
  }
}

/** One slab of the cave's mesh, its vertices finished. */
export interface HollowSculptPart {
  contour: OctreeContour
  normals: Float32Array
  zones: Float32Array
  sheets: Float32Array
  occlusion: Float32Array
}

/** Material groups of the cave's geometry: the rock, and the translucent calcite of the drapery sheets. */
export const SCULPT_ROCK_GROUP = 0
export const SCULPT_CALCITE_GROUP = 1
/** A triangle with a vertex on calcite thinner than this (`aSheet`, `m`) draws with the calcite. */
const TRANSLUCENT_SHEET = 0.5

/** The cave in slabs along `z` (`SLAB_CELLS` thick), meshed apart. */
export function hollowSlabs(): OctreeSlab[] {
  const slabs: OctreeSlab[] = []
  const end = Math.ceil((HOLLOW_MAX.z - HOLLOW_MIN.z) / FINEST_CELL)
  for (let from = 0; from < end; from += SLAB_CELLS) slabs.push({from, to: from + SLAB_CELLS, maxLeaf: SLAB_CELLS})
  return slabs
}

/**
 * The cave's geometry from its slabs (in `hollowSlabs` order): the rock's triangles (`SCULPT_ROCK_GROUP`), then those
 * of the drapery sheets and their fillets (`SCULPT_CALCITE_GROUP`).
 */
export function assembleSculpt(parts: HollowSculptPart[]): BufferGeometry {
  const {offsets, count, quads} = stitchSlabs(parts.map(part => part.contour))
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const zones = new Float32Array(count * 4)
  const sheets = new Float32Array(count * 2)
  const occlusion = new Float32Array(count)
  parts.forEach((part, i) => {
    positions.set(part.contour.positions, offsets[i] * 3)
    normals.set(part.normals, offsets[i] * 3)
    zones.set(part.zones, offsets[i] * 4)
    sheets.set(part.sheets, offsets[i] * 2)
    occlusion.set(part.occlusion, offsets[i])
  })
  const triangles = triangulateQuads(positions, quads, normals)
  const index = new Uint32Array(triangles.length)
  let rock = 0
  let calcite = triangles.length
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i]
    const b = triangles[i + 1]
    const c = triangles[i + 2]
    let o = rock
    if (Math.min(sheets[a * 2], sheets[b * 2], sheets[c * 2]) < TRANSLUCENT_SHEET) o = calcite -= 3
    else rock += 3
    index[o] = a
    index[o + 1] = b
    index[o + 2] = c
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('aZone', new BufferAttribute(zones, 4))
  geometry.setAttribute('aSheet', new BufferAttribute(sheets, 2))
  geometry.setAttribute('aOcclusion', new BufferAttribute(occlusion, 1))
  geometry.setIndex(new BufferAttribute(index, 1))
  geometry.addGroup(0, rock, SCULPT_ROCK_GROUP)
  geometry.addGroup(rock, triangles.length - rock, SCULPT_CALCITE_GROUP)
  const bounds = new Box3(HOLLOW_MIN.clone(), HOLLOW_MAX.clone())
  geometry.boundingBox = bounds
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere())
  return geometry
}

/**
 * A coarser stand-in for a surface (`position` and index only): its vertices clustered into cubes of `cell` (`m`), at
 * their clusters' means, and the triangles that don't collapse. For the VXGI voxelizer, which packs every triangle in
 * one storage buffer (`128 MB` by default): it voxelizes far coarser than the surface's cells anyway.
 */
export function clusterSurface(geometry: BufferGeometry, cell: number): BufferGeometry {
  const pos = geometry.getAttribute('position').array
  const index = geometry.getIndex()!.array
  const count = pos.length / 3
  const remap = new Int32Array(count)
  const clusters = new Map<number, number>()
  const sums: number[] = []
  const sizeX = Math.ceil((HOLLOW_MAX.x - HOLLOW_MIN.x) / cell) + 3
  const sizeY = Math.ceil((HOLLOW_MAX.y - HOLLOW_MIN.y) / cell) + 3
  for (let v = 0; v < count; v++) {
    const ix = Math.floor((pos[v * 3] - HOLLOW_MIN.x) / cell) + 1
    const iy = Math.floor((pos[v * 3 + 1] - HOLLOW_MIN.y) / cell) + 1
    const iz = Math.floor((pos[v * 3 + 2] - HOLLOW_MIN.z) / cell) + 1
    const key = ix + sizeX * (iy + sizeY * iz)
    let c = clusters.get(key)
    if (c === undefined) {
      c = sums.length / 4
      clusters.set(key, c)
      sums.push(0, 0, 0, 0)
    }
    sums[c * 4] += pos[v * 3]
    sums[c * 4 + 1] += pos[v * 3 + 1]
    sums[c * 4 + 2] += pos[v * 3 + 2]
    sums[c * 4 + 3]++
    remap[v] = c
  }
  const positions = new Float32Array(sums.length / 4 * 3)
  for (let c = 0; c < sums.length / 4; c++) {
    positions[c * 3] = sums[c * 4] / sums[c * 4 + 3]
    positions[c * 3 + 1] = sums[c * 4 + 1] / sums[c * 4 + 3]
    positions[c * 3 + 2] = sums[c * 4 + 2] / sums[c * 4 + 3]
  }
  const triangles = new Uint32Array(index.length)
  let o = 0
  for (let i = 0; i < index.length; i += 3) {
    const a = remap[index[i]]
    const b = remap[index[i + 1]]
    const c = remap[index[i + 2]]
    if (a === b || b === c || c === a) continue
    triangles[o++] = a
    triangles[o++] = b
    triangles[o++] = c
  }
  const proxy = new BufferGeometry()
  proxy.setAttribute('position', new BufferAttribute(positions, 3))
  proxy.setIndex(new BufferAttribute(triangles.slice(0, o), 1))
  proxy.boundingBox = geometry.boundingBox?.clone() ?? null
  proxy.boundingSphere = geometry.boundingSphere?.clone() ?? null
  return proxy
}

/** A body as structured-cloned to a worker (its vectors lost their class): with its vectors back. */
export function reviveBody(body: HollowBody): HollowBody {
  const v = (p: {x: number; y: number; z: number}) => new Vector3(p.x, p.y, p.z)
  if (body.kind === 'rock') {
    return {...body, min: v(body.min), max: v(body.max), center: v(body.center), radii: v(body.radii)}
  }
  return {...body, min: v(body.min), max: v(body.max)}
}
