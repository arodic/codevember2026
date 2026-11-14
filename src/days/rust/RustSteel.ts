import type { Node } from 'three/webgpu'
import { Fn, If, abs, clamp, cos, dot, float, floor, fract, hash, int, length, max, min, mix, sin, smoothstep, uint, vec2, vec4 } from 'three/tsl'

/** Mean ferrite grain size (µm, ~ASTM 8). */
export const GRAIN_SIZE = 18
/** Spacing (µm) of the ferrite–cementite lamellae in pearlite. */
export const LAMELLA_SPACING = 0.3
/** Share of pearlite that is cementite (lever rule: 0.77% C between ferrite and Fe3C at 6.67%). */
export const CEMENTITE_SHARE = 0.11
/** Side (µm) of the lattice cells that each hold at most one MnS inclusion (~1 per 2,000 µm²). */
export const INCLUSION_CELL = 45
/** Direction (rad) of the grinding marks, and their mean spacing (µm). */
const SCRATCH_ANGLE = 0.38
const SCRATCH_SPACING = 2.2

/** Share of the steel that is pearlite at `carbon` % C (lever rule between 0.02 and 0.77% C). */
export function pearliteShare(carbon: number) {
  return Math.min(Math.max((carbon - 0.02) / 0.75, 0), 1)
}

/** A hash (0–1) of an integer lattice cell, a salt and the seed. */
function cellHash(cell: Node<'vec2'>, salt: number, seed: Node<'float'>) {
  const x = uint(int(cell.x).add(8192)).mul(73856093)
  const y = uint(int(cell.y).add(8192)).mul(19349663)
  return hash(x.bitXor(y).bitXor(uint(seed).mul(2654435761)).bitXor(uint(salt * 40503 + 1)))
}

/** Smooth value noise (0–1) at `p` in lattice units, salted. */
function valueNoise(p: Node<'vec2'>, salt: number, seed: Node<'float'>) {
  const base = floor(p)
  const t = p.sub(base)
  const s = t.mul(t).mul(float(3).sub(t.mul(2)))
  const corner = (dx: number, dy: number) => cellHash(base.add(vec2(dx, dy)), salt, seed)
  return mix(mix(corner(0, 0), corner(1, 0), s.x), mix(corner(0, 1), corner(1, 1), s.x), s.y)
}

/**
 * Ferrite grains as a jittered Voronoi tessellation of `GRAIN_SIZE`, looked up through a smooth warp (two octaves of
 * value noise, ~0.35 grain): real grains are irregular polygons with curving boundaries, never a straight-edged
 * tessellation. `(distance to the nearest grain centre, to the second nearest, hash A, hash B)` of the grain at `p`
 * (µm), the hashes picking its constituent and orientation. A hidden driver: only its soft effect on dissolution
 * ever shows.
 */
export const steelGrain = Fn(([p, seed]: [Node<'vec2'>, Node<'float'>]) => {
  const q = p.div(GRAIN_SIZE * 0.6)
  const warp = vec2(
    valueNoise(q, 31, seed).add(valueNoise(q.mul(2.3), 33, seed).mul(0.5)),
    valueNoise(q, 32, seed).add(valueNoise(q.mul(2.3), 34, seed).mul(0.5)),
  ).sub(0.75).mul(GRAIN_SIZE * 0.45)
  const g = p.add(warp).div(GRAIN_SIZE)
  const base = floor(g)
  const f1 = float(1e9).toVar()
  const f2 = float(1e9).toVar()
  const idA = float(0).toVar()
  const idB = float(0).toVar()
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = base.add(vec2(dx, dy))
      const point = cell.add(vec2(cellHash(cell, 1, seed), cellHash(cell, 2, seed)).sub(0.5).mul(0.85).add(0.5))
      const d = length(g.sub(point))
      If(d.lessThan(f1), () => {
        f2.assign(f1)
        f1.assign(d)
        idA.assign(cellHash(cell, 3, seed))
        idB.assign(cellHash(cell, 4, seed))
      }).ElseIf(d.lessThan(f2), () => {
        f2.assign(d)
      })
    }
  }
  return vec4(f1.mul(GRAIN_SIZE), f2.mul(GRAIN_SIZE), idA, idB)
}, {p: 'vec2', seed: 'float', return: 'vec4'})

/**
 * MnS stringers, elongated along the rolling direction (x): the signed distance (µm, negative inside) from `p` to the
 * nearest inclusion. Each `INCLUSION_CELL` cell holds one with probability `0.9 × density`, 2–20 µm long and 0.5–2 µm
 * wide, turned up to ±5°.
 */
export const steelInclusion = Fn(([p, seed, density]: [Node<'vec2'>, Node<'float'>, Node<'float'>]) => {
  const base = floor(p.div(INCLUSION_CELL))
  const best = float(1e9).toVar()
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = base.add(vec2(dx, dy))
      const present = cellHash(cell, 11, seed).lessThan(density.mul(0.9))
      const center = cell.add(vec2(cellHash(cell, 12, seed), cellHash(cell, 13, seed)).mul(0.6).add(0.2)).mul(INCLUSION_CELL)
      const halfLength = mix(1, 10, cellHash(cell, 14, seed).pow(2))
      const halfWidth = mix(0.25, 1, cellHash(cell, 15, seed))
      const angle = cellHash(cell, 16, seed).sub(0.5).mul(0.17)
      const d = p.sub(center)
      const c = cos(angle)
      const s = sin(angle)
      const local = vec2(d.x.mul(c).add(d.y.mul(s)), d.y.mul(c).sub(d.x.mul(s)))
      const q = local.div(vec2(halfLength, halfWidth))
      const signed = length(q).sub(1).mul(min(halfWidth, halfLength))
      If(present, () => {
        best.assign(min(best, signed))
      })
    }
  }
  return best
}, {p: 'vec2', seed: 'float', density: 'float', return: 'float'})

/**
 * Depth (µm) of the polishing scratches at `p`: a family of parallel grooves (`SCRATCH_ANGLE`, ~2 µm apart, a third of
 * the bands scored, 0.1–1.5 µm wide, 20–200 nm deep) and sparse strays across them.
 */
export const steelScratch = Fn(([p, seed]: [Node<'vec2'>, Node<'float'>]) => {
  const depth = float(0).toVar()
  const families: [number, number, number][] = [[SCRATCH_ANGLE, SCRATCH_SPACING, 0.34], [SCRATCH_ANGLE + 1.1, 9, 0.12]]
  families.forEach(([angle, spacing, share], f) => {
    const normal = vec2(-Math.sin(angle), Math.cos(angle))
    const u = dot(p, normal).div(spacing)
    const band = floor(u)
    const cell = vec2(band, f)
    const present = cellHash(cell, 21, seed).lessThan(share)
    const width = mix(0.1, 1.5, cellHash(cell, 22, seed).pow(2)).div(spacing)
    const center = cellHash(cell, 23, seed).mul(0.6).add(0.2)
    const across = abs(fract(u).sub(center))
    const groove = smoothstep(width.mul(0.5), float(0), across).mul(mix(0.02, 0.2, cellHash(cell, 24, seed)))
    If(present, () => {
      depth.assign(max(depth, groove))
    })
  })
  return depth
}, {p: 'vec2', seed: 'float', return: 'float'})

/**
 * The steel at `p` (µm) as the bake needs it: `(anodic multiplier, MnS, trench, cementite)`. The multiplier is the
 * grain's orientation (0.9–1.12, crystallographic dissolution: gentle, so grains etch in relief rather than as
 * terraces), boundaries up to 1.15× within ~1.5 µm, ferrite in pearlite 1.25× (galvanic against the cementite,
 * which does not dissolve) and scratched steel a little faster. MnS is 1 inside an inclusion; the trench is the ~1 µm
 * of steel around it, where pits start (Muto, Chiba et al.).
 */
export const steelSample = Fn(([p, seed, pearlite, inclusions]: [
  Node<'vec2'>, Node<'float'>, Node<'float'>, Node<'float'>,
]) => {
  const grain = steelGrain(p, seed)
  const orientation = mix(0.9, 1.12, grain.w)
  const boundary = float(1).add(smoothstep(3.0, 0.2, grain.y.sub(grain.x)).mul(0.15))
  const angle = fract(grain.w.mul(7.31)).mul(Math.PI)
  const phase = fract(dot(p, vec2(cos(angle), sin(angle))).div(LAMELLA_SPACING))
  const inPearlite = grain.z.lessThan(pearlite)
  const cementite = smoothstep(1 - CEMENTITE_SHARE - 0.02, 1 - CEMENTITE_SHARE + 0.02, phase).mul(float(inPearlite))
  const constituent = mix(float(1), float(1.25), float(inPearlite)).mul(float(1).sub(cementite))
  const scratch = steelScratch(p, seed)
  const inclusion = steelInclusion(p, seed, inclusions)
  const mns = smoothstep(0.12, -0.12, inclusion)
  const trench = smoothstep(1.2, 0, inclusion).mul(float(1).sub(mns))
  const anodic = orientation.mul(boundary).mul(constituent).mul(float(1).add(scratch.mul(2)))
  return vec4(anodic, mns, trench, cementite)
}, {p: 'vec2', seed: 'float', pearlite: 'float', inclusions: 'float', return: 'vec4'})

/**
 * The steel averaged over a bake cell of side `cell` µm centred at `p`, from 3 × 3 samples: the mean multiplier and
 * shares, the trench's largest value (a pit starts anywhere along it).
 */
export function steelCell(p: Node<'vec2'>, cell: number, seed: Node<'float'>, pearlite: Node<'float'>, inclusions: Node<'float'>) {
  const sum = vec4(0).toVar()
  const trench = float(0).toVar()
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const sample = steelSample(p.add(vec2(i, j).mul(cell / 3)), seed, pearlite, inclusions)
      sum.addAssign(sample)
      trench.assign(max(trench, sample.z))
    }
  }
  const mean = sum.div(9)
  return vec4(mean.x, mean.y, clamp(trench, 0, 1), mean.w)
}
