import {BufferAttribute, BufferGeometry, MathUtils} from 'three/webgpu'
import {HollowField, RIMSTONE_POOL_STEP} from './HollowField.js'

/**
 * Builds the meandering main lake water surface mesh at `y = waterLevel` over the seeded lake's extent, trimmed around
 * dry banks and walls and outside the stepped rimstone (`gour`) dam, so the raised shallow sinter basin is never
 * intersected by the main water plane.
 */
export function buildHollowLakeGeometry(field: HollowField, cellSize = 0.2): BufferGeometry {
  const wl = field.params.waterLevel
  const extent = field.lakeExtent
  const minX = extent.minX
  const maxX = extent.maxX
  const minZ = extent.minZ
  const maxZ = extent.maxZ
  const cols = Math.max(2, Math.ceil((maxX - minX) / cellSize))
  const rows = Math.max(2, Math.ceil((maxZ - minZ) / cellSize))
  const rimstone = field.params.rimstoneScale > 0.05

  const vertCount = (cols + 1) * (rows + 1)
  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  const depths = new Float32Array(vertCount)
  const validMask = new Uint8Array(vertCount)

  let p = 0
  for (let r = 0; r <= rows; r++) {
    const z = MathUtils.lerp(minZ, maxZ, r / rows)
    for (let c = 0; c <= cols; c++) {
      const x = MathUtils.lerp(minX, maxX, c / cols)
      positions[p * 3] = x
      positions[p * 3 + 1] = wl
      positions[p * 3 + 2] = z
      normals[p * 3 + 1] = 1.0

      const uRim = rimstone ? field.rimstoneCoord(x, z) : 2.0
      const floorY = field.floorHeightAt(x, z, true)
      const rawDepth = wl - floorY
      depths[p] = Math.max(0.0, rawDepth)
      // Shoreline margin (`rawDepth > -0.22`) so water tucks into sloped banks; open air above it; outside the rimstone
      validMask[p] = rawDepth > -0.22 && uRim > 0.94 && field.macroSample(x, wl + 0.05, z) > -0.3 ? 1 : 0
      p++
    }
  }

  const indices: number[] = []
  const stride = cols + 1
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * stride + c
      const b = a + 1
      const d = a + stride
      const e = d + 1
      if (validMask[a] || validMask[b] || validMask[d] || validMask[e]) {
        // Skip quads completely inside the raised rimstone shelf
        const cx = 0.5 * (positions[a * 3] + positions[e * 3])
        const cz = 0.5 * (positions[a * 3 + 2] + positions[e * 3 + 2])
        if (rimstone && field.rimstoneCoord(cx, cz) < 0.93) continue
        indices.push(a, d, b, b, d, e)
      }
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('aWaterDepth', new BufferAttribute(depths, 1))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Builds the slightly elevated (`+8.5 cm`) shallow amber mineral water meniscus enclosed inside the seed-placed
 * scalloped rimstone (`gour`) dam: each sector's rim is found along its ray where the dam's inner face rises out of
 * the water (just under the floor, so the rock hides the water's edge).
 */
export function buildRimstonePoolGeometry(field: HollowField, rings = 22, sectors = 64): BufferGeometry {
  const reach = field.rimstoneReach
  const poolY = field.params.waterLevel + RIMSTONE_POOL_STEP
  const cx = field.rimstoneCenter.x
  const cz = field.rimstoneCenter.z

  const positions: number[] = [cx, poolY, cz]
  const normals: number[] = [0, 1, 0]
  const depths: number[] = [RIMSTONE_POOL_STEP - 0.025]

  for (let ir = 1; ir <= rings; ir++) {
    const radialT = ir / rings
    for (let is = 0; is < sectors; is++) {
      const theta = (is / sectors) * Math.PI * 2
      // Bisect outward from the center along `(cos theta, sin theta)` to the inner dam wall (`rimstoneCoord = 0.905`)
      const worldDirX = Math.cos(theta)
      const worldDirZ = Math.sin(theta)

      // The crest's ray out to `rimstoneCoord = 0.95`, then the waterline on the face inside it
      let lo = 0.0
      let hi = reach
      for (let b = 0; b < 14; b++) {
        const mid = 0.5 * (lo + hi)
        if (field.rimstoneCoord(cx + worldDirX * mid, cz + worldDirZ * mid) < 0.95) lo = mid
        else hi = mid
      }
      hi = lo
      lo = 0.0
      for (let b = 0; b < 14; b++) {
        const mid = 0.5 * (lo + hi)
        if (field.floorHeightAt(cx + worldDirX * mid, cz + worldDirZ * mid, false) < poolY + 0.008) lo = mid
        else hi = mid
      }
      const rEdge = hi * radialT
      const px = cx + worldDirX * rEdge
      const pz = cz + worldDirZ * rEdge
      const floorY = field.floorHeightAt(px, pz, true)
      positions.push(px, poolY, pz)
      normals.push(0, 1, 0)
      depths.push(Math.max(0.005, poolY - floorY))
    }
  }

  const indices: number[] = []
  for (let is = 0; is < sectors; is++) {
    const next = (is + 1) % sectors
    indices.push(0, 1 + next, 1 + is)
  }
  for (let ir = 1; ir < rings; ir++) {
    const ringStart = 1 + (ir - 1) * sectors
    const nextRing = ringStart + sectors
    for (let is = 0; is < sectors; is++) {
      const next = (is + 1) % sectors
      const a = ringStart + is
      const b = ringStart + next
      const d = nextRing + is
      const e = nextRing + next
      indices.push(a, b, d, b, e, d)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('aWaterDepth', new BufferAttribute(new Float32Array(depths), 1))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
