import {
  BufferAttribute, BufferGeometry, Euler, MathUtils, Matrix4, Quaternion, Vector3,
} from 'three/webgpu'
import { BoulderProxy, HollowField, createHollowRandom, smin } from './HollowField.js'

export interface HollowRockSet {
  geometry: BufferGeometry
  proxies: BoulderProxy[]
}

interface RockSpec {
  center: Vector3
  radii: Vector3
  euler: Euler
  fillet: number
  cleavageSharpness: number
  seed: number
}

interface SphereTemplate {
  dirs: Float32Array
  indices: Uint16Array
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
  return t * t * (3.0 - 2.0 * t)
}

/** Builds a welded, evenly-spaced normalized cube-sphere (`6 * n * n` quads, zero seam duplicates). */
function createWeldedSphereTemplate(subdivisions = 14): SphereTemplate {
  const n = subdivisions
  const coordMap = new Map<string, number>()
  const dirs: number[] = []
  const indices: number[] = []

  const getVert = (ix: number, iy: number, iz: number): number => {
    const key = `${ix},${iy},${iz}`
    const existing = coordMap.get(key)
    if (existing !== undefined) return existing
    // Spherified cube projection (`tan` warp for uniform angular texel area)
    const tx = Math.tan(((ix / n) * 2.0 - 1.0) * (Math.PI * 0.25))
    const ty = Math.tan(((iy / n) * 2.0 - 1.0) * (Math.PI * 0.25))
    const tz = Math.tan(((iz / n) * 2.0 - 1.0) * (Math.PI * 0.25))
    const len = Math.hypot(tx, ty, tz)
    const idx = dirs.length / 3
    dirs.push(tx / len, ty / len, tz / len)
    coordMap.set(key, idx)
    return idx
  }

  // 6 cube faces with outward right-handed winding
  const faces: readonly [
    (u: number, v: number) => [number, number, number],
    boolean,
  ][] = [
    [(u, v) => [n, v, n - u], false],
    [(u, v) => [0, v, u], false],
    [(u, v) => [u, n, n - v], false],
    [(u, v) => [u, 0, v], false],
    [(u, v) => [u, v, n], false],
    [(u, v) => [n - u, v, 0], false],
  ]

  for (const [mapUV, flip] of faces) {
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        const a = getVert(...mapUV(u, v))
        const b = getVert(...mapUV(u + 1, v))
        const c = getVert(...mapUV(u + 1, v + 1))
        const d = getVert(...mapUV(u, v + 1))
        if (!flip) {
          indices.push(a, b, c, a, c, d)
        } else {
          indices.push(a, c, b, a, d, c)
        }
      }
    }
  }

  return {
    dirs: new Float32Array(dirs),
    indices: new Uint16Array(indices),
  }
}

/**
 * Appends one Voronoi/planar-cleaved limestone boulder into the world-space rock buffers, flaring its base into a
 * grazing tangent skirt (`aCollar` -> `1`) on the host `HollowField` surface.
 */
function appendCleavedRock(
  field: HollowField,
  spec: RockSpec,
  template: SphereTemplate,
  outPos: number[],
  outNorm: number[],
  outZone: number[],
  outCollar: number[],
  outIndices: number[],
) {
  const rand = createHollowRandom(spec.seed)
  const vertCount = template.dirs.length / 3
  const baseVertex = outPos.length / 3

  // Conjugate geological fracture planes (sub-horizontal bedding cleavage + steep joint sets)
  const planeCount = 14
  const planeNormals: Vector3[] = []
  const planeOffsets: number[] = []
  for (let i = 0; i < planeCount; i++) {
    const isBedding = i < 3
    const theta = rand() * Math.PI * 2
    const ny = isBedding
      ? (i === 0 ? 0.94 : i === 1 ? -0.92 : 0.82) + (rand() - 0.5) * 0.14
      : (rand() - 0.35) * 0.85
    const horiz = Math.sqrt(Math.max(0.02, 1.0 - ny * ny))
    planeNormals.push(new Vector3(Math.cos(theta) * horiz, ny, Math.sin(theta) * horiz).normalize())
    planeOffsets.push(0.68 + rand() * 0.34)
  }

  const quat = new Quaternion().setFromEuler(spec.euler)
  const mat = new Matrix4().compose(spec.center, quat, spec.radii)

  const localPositions = new Float32Array(vertCount * 3)
  const localNormals = new Float32Array(vertCount * 3)
  const localCollars = new Float32Array(vertCount)

  const dir = new Vector3()
  const worldPos = new Vector3()
  const caveGrad = new Vector3()
  const bevel = MathUtils.lerp(0.16, 0.045, spec.cleavageSharpness)

  for (let i = 0; i < vertCount; i++) {
    dir.set(template.dirs[i * 3], template.dirs[i * 3 + 1], template.dirs[i * 3 + 2])

    let radius = 1.12
    for (let p = 0; p < planeCount; p++) {
      const d = dir.dot(planeNormals[p])
      if (d > 0.08) {
        radius = smin(radius, planeOffsets[p] / d, bevel)
      }
    }

    radius += 0.075 * field.fbm3(dir.x * 2.3 + spec.seed * 0.13, dir.y * 2.8 - spec.seed * 0.07, dir.z * 2.3 + spec.seed * 0.19, 3)

    const baseT = smoothstep(-0.22, -0.78, dir.y)
    const radialFlare = 1.0 + 0.24 * baseT

    worldPos.set(dir.x * radius * radialFlare, dir.y * radius, dir.z * radius * radialFlare).applyMatrix4(mat)

    // Sedimentary horizontal bedding notches aligned with cavern stratigraphy
    const bedWave = Math.sin((worldPos.y + 0.04 * worldPos.x) * 13.5)
    const horizFactor = Math.hypot(dir.x, dir.z)
    worldPos.x -= dir.x * 0.022 * bedWave * horizFactor
    worldPos.z -= dir.z * 0.022 * bedWave * horizFactor

    const hostPhi = field.sample(worldPos.x, worldPos.y, worldPos.z, false)
    if (baseT > 0.05 && hostPhi < 0.35 && hostPhi > -0.45) {
      field.sampleNormal(worldPos.x, worldPos.y, worldPos.z, caveGrad, false, 0.08)
      const snap = MathUtils.clamp(-hostPhi * 0.45 * baseT, -0.18, 0.18)
      worldPos.addScaledVector(caveGrad, snap)
    }

    localPositions[i * 3] = worldPos.x
    localPositions[i * 3 + 1] = worldPos.y
    localPositions[i * 3 + 2] = worldPos.z
    localCollars[i] = MathUtils.clamp(Math.max(baseT * 0.85, 1.0 - smoothstep(-0.08, 0.36, hostPhi)), 0.0, 1.0)
  }

  // Compute smooth area-weighted vertex normals for this rock
  const tIdx = template.indices
  for (let i = 0; i < tIdx.length; i += 3) {
    const i0 = tIdx[i] * 3
    const i1 = tIdx[i + 1] * 3
    const i2 = tIdx[i + 2] * 3
    const ax = localPositions[i1] - localPositions[i0]
    const ay = localPositions[i1 + 1] - localPositions[i0 + 1]
    const az = localPositions[i1 + 2] - localPositions[i0 + 2]
    const bx = localPositions[i2] - localPositions[i0]
    const by = localPositions[i2 + 1] - localPositions[i0 + 1]
    const bz = localPositions[i2 + 2] - localPositions[i0 + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    localNormals[i0] += nx; localNormals[i0 + 1] += ny; localNormals[i0 + 2] += nz
    localNormals[i1] += nx; localNormals[i1 + 1] += ny; localNormals[i1 + 2] += nz
    localNormals[i2] += nx; localNormals[i2 + 1] += ny; localNormals[i2 + 2] += nz
  }

  for (let i = 0; i < vertCount; i++) {
    const o = i * 3
    const px = localPositions[o]
    const py = localPositions[o + 1]
    const pz = localPositions[o + 2]
    const nLen = Math.hypot(localNormals[o], localNormals[o + 1], localNormals[o + 2]) || 1.0
    const nx = localNormals[o] / nLen
    const ny = localNormals[o + 1] / nLen
    const nz = localNormals[o + 2] / nLen

    outPos.push(px, py, pz)
    outNorm.push(nx, ny, nz)

    const zInfo = field.zonesAt(px, py, pz, ny)
    outZone.push(Math.max(zInfo.strata, 0.55), zInfo.travertine, zInfo.rimstone, zInfo.wetness)
    outCollar.push(localCollars[i])
  }

  for (let i = 0; i < tIdx.length; i++) {
    outIndices.push(baseVertex + tIdx[i])
  }
}

/**
 * Places hero compositional boulders (the iconic angular monolith jutting into the right side of the lake, foreground
 * fractured wet limestone benches, right buttress outcrops, and seeded shoreline/ledge talus) and returns both the
 * merged `BufferGeometry` and SDF proxy ellipsoids for `HollowField`.
 */
export function buildHollowRocks(field: HollowField, extraBoulderCount = 10): HollowRockSet {
  const rand = createHollowRandom(field.params.seed * 31 + 109)
  const wl = field.params.waterLevel
  const wScale = field.params.cavernWidth
  const template = createWeldedSphereTemplate(14)

  const specs: RockSpec[] = []

  const side = field.heroSide
  const dens = field.featureDensity

  // 1. Hero angular monolith jutting into the mirror pool on the seed-chosen side
  const heroAlong = -2.2 - rand() * 5.5
  const heroX = field.spineX(heroAlong) + side * (1.55 + rand() * 1.65) * wScale
  const heroZ = heroAlong
  const heroFloor = field.findFloorY(heroX, heroZ) ?? (wl - 0.15)
  const heroScale = (0.85 + rand() * 0.55) * dens
  specs.push({
    center: new Vector3(heroX, Math.max(wl + 0.42, heroFloor + 0.52), heroZ),
    radii: new Vector3(1.05 * heroScale, 0.95 * heroScale, 0.92 * heroScale),
    euler: new Euler(-0.18 + (rand() - 0.5) * 0.2, side * (0.35 + rand() * 0.45), 0.28 * side),
    fillet: 0.42,
    cleavageSharpness: 0.92,
    seed: field.params.seed * 17 + 1,
  })

  // 2. Companion stepped shelf slab behind/beside the hero boulder
  specs.push({
    center: new Vector3(heroX + side * (0.9 + rand() * 0.7), wl + 0.32, heroZ + 0.7 + rand() * 0.9),
    radii: new Vector3(1.15 * heroScale, 0.48 * heroScale, 1.05 * heroScale),
    euler: new Euler(0.06, -0.35 * side, 0.08 * side),
    fillet: 0.48,
    cleavageSharpness: 0.85,
    seed: field.params.seed * 17 + 2,
  })

  // 3. Foreground wet fractured limestone slabs (repoussoir benches, seeded offsets)
  const fgCount = 3 + Math.floor(rand() * 3)
  for (let idx = 0; idx < fgCount; idx++) {
    const az = 1.6 + rand() * 3.2
    const ax = field.cinemaPose.startX + side * (0.4 + rand() * 3.4) + (rand() - 0.5) * 1.2
    const wx = ax * (0.85 + 0.15 * wScale)
    const rx = 0.85 + rand() * 0.7
    const ry = 0.22 + rand() * 0.4
    const rz = 0.75 + rand() * 0.55
    const base = field.findFloorY(wx, az) ?? (wl + 0.12)
    specs.push({
      center: new Vector3(wx, base + ry * 0.32, az),
      radii: new Vector3(rx, ry, rz),
      euler: new Euler((rand() - 0.5) * 0.12, (rand() - 0.5) * 0.8, (rand() - 0.5) * 0.12),
      fillet: 0.38,
      cleavageSharpness: 0.88,
      seed: field.params.seed * 17 + 10 + idx,
    })
  }

  // 4. Seeded shoreline, left-gallery, and rear-cascade flank boulders
  let placed = 0
  let attempts = 0
  while (placed < extraBoulderCount && attempts < extraBoulderCount * 14) {
    attempts++
    const onLeft = rand() < 0.52
    const z = -18.5 + rand() * 19.5
    const cx = field.spineX(z)
    const sideOffset = onLeft ? -(2.8 + rand() * 3.2) : (2.3 + rand() * 2.6)
    const x = cx + sideOffset * wScale

    if (field.rimstoneCoord(x, z) < 1.28) continue
    if (z > 4.2 && Math.abs(x - 0.55) < 2.2) continue

    const floorY = field.findFloorY(x, z, 3.6)
    if (floorY === null || floorY < wl - 0.55 || floorY > wl + 2.8) continue

    const scale = 0.42 + rand() * 0.68
    const ry = scale * (0.48 + rand() * 0.45)
    specs.push({
      center: new Vector3(x, floorY + ry * 0.38, z),
      radii: new Vector3(scale * (0.85 + rand() * 0.45), ry, scale * (0.8 + rand() * 0.45)),
      euler: new Euler((rand() - 0.5) * 0.24, rand() * Math.PI * 2, (rand() - 0.5) * 0.24),
      fillet: 0.34,
      cleavageSharpness: 0.7 + rand() * 0.25,
      seed: field.params.seed * 29 + 100 + attempts,
    })
    placed++
  }

  const outPos: number[] = []
  const outNorm: number[] = []
  const outZone: number[] = []
  const outCollar: number[] = []
  const outIndices: number[] = []

  for (const spec of specs) {
    appendCleavedRock(field, spec, template, outPos, outNorm, outZone, outCollar, outIndices)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(outPos), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(outNorm), 3))
  geometry.setAttribute('aZone', new BufferAttribute(new Float32Array(outZone), 4))
  geometry.setAttribute('aCollar', new BufferAttribute(new Float32Array(outCollar), 1))
  geometry.setIndex(outIndices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const proxies: BoulderProxy[] = specs.map(spec => ({
    center: spec.center.clone(),
    radii: spec.radii.clone(),
    rotationY: spec.euler.y,
    fillet: spec.fillet,
  }))

  return {geometry, proxies}
}
