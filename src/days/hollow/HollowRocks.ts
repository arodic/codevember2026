import {Euler, MathUtils, Quaternion, Vector3} from 'three/webgpu'
import {HollowField, createHollowRandom} from './HollowField.js'
import {type HollowRockBody, rockBody} from './HollowSculpt.js'

interface RockSpec {
  center: Vector3
  radii: Vector3
  euler: Euler
  cleavageSharpness: number
  seed: number
}

/**
 * A Voronoi/planar-cleaved limestone boulder: its unit sphere cut by conjugate fracture planes (sub-horizontal bedding
 * cleavage and steep joint sets), with bevelled edges.
 */
function cleavedRock(spec: RockSpec): HollowRockBody {
  const rand = createHollowRandom(spec.seed)
  const planeCount = 14
  const planes = new Float32Array(planeCount * 4)
  for (let i = 0; i < planeCount; i++) {
    const isBedding = i < 3
    const theta = rand() * Math.PI * 2
    const ny = isBedding
      ? (i === 0 ? 0.94 : i === 1 ? -0.92 : 0.82) + (rand() - 0.5) * 0.14
      : (rand() - 0.35) * 0.85
    const horiz = Math.sqrt(Math.max(0.02, 1.0 - ny * ny))
    const n = new Vector3(Math.cos(theta) * horiz, ny, Math.sin(theta) * horiz).normalize()
    planes.set([n.x, n.y, n.z, 0.68 + rand() * 0.34], i * 4)
  }
  const bevel = MathUtils.lerp(0.16, 0.045, spec.cleavageSharpness)
  return rockBody(spec.center, new Quaternion().setFromEuler(spec.euler), spec.radii, planes, bevel, spec.seed)
}

/**
 * Places hero compositional boulders (the iconic angular monolith jutting into the right side of the lake, foreground
 * fractured wet limestone benches, right buttress outcrops, and seeded shoreline/ledge talus), as bodies of the
 * cave's field (`HollowSculpt`).
 */
export function placeHollowRocks(field: HollowField, extraBoulderCount = 10): HollowRockBody[] {
  const rand = createHollowRandom(field.params.seed * 31 + 109)
  const wl = field.params.waterLevel
  const wScale = field.widthScale
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
    cleavageSharpness: 0.92,
    seed: field.params.seed * 17 + 1,
  })

  // 2. Companion stepped shelf slab behind/beside the hero boulder
  specs.push({
    center: new Vector3(heroX + side * (0.9 + rand() * 0.7), wl + 0.32, heroZ + 0.7 + rand() * 0.9),
    radii: new Vector3(1.15 * heroScale, 0.48 * heroScale, 1.05 * heroScale),
    euler: new Euler(0.06, -0.35 * side, 0.08 * side),
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
    if (z > field.cinemaPose.startZ - 2.8 && Math.abs(x - field.cinemaPose.startX) < 2.2) continue

    const floorY = field.findFloorY(x, z, 3.6)
    if (floorY === null || floorY < wl - 0.55 || floorY > wl + 2.8) continue

    const scale = 0.42 + rand() * 0.68
    const ry = scale * (0.48 + rand() * 0.45)
    specs.push({
      center: new Vector3(x, floorY + ry * 0.38, z),
      radii: new Vector3(scale * (0.85 + rand() * 0.45), ry, scale * (0.8 + rand() * 0.45)),
      euler: new Euler((rand() - 0.5) * 0.24, rand() * Math.PI * 2, (rand() - 0.5) * 0.24),
      cleavageSharpness: 0.7 + rand() * 0.25,
      seed: field.params.seed * 29 + 100 + attempts,
    })
    placed++
  }

  return specs.map(cleavedRock)
}
