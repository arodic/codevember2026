import {
  Box3, BufferAttribute, BufferGeometry, MathUtils, Sphere, Vector3,
} from 'three/webgpu'
import {
  HOLLOW_MAX, HOLLOW_MIN, HOLLOW_SIZE, HollowField, RIMSTONE_POOL_STEP,
} from './HollowField.js'

/** Surface Nets dual-grid resolution (`~20 cm` cells across the cavern bounds). */
export const SHELL_NX = 132
export const SHELL_NY = 68
export const SHELL_NZ = 176

const EDGE_CORNERS: readonly [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/**
 * Extracts a clean manifold indexed `BufferGeometry` of the karst cavern shell via dual Surface Nets with 1-step
 * isosurface gradient projection. Front faces (`FrontSide`) face strictly into open cavern air (`+grad(phi)`), so
 * indoor views are enclosed while exterior editor/cutaway views automatically see inside via backface culling.
 */
export function buildHollowShellGeometry(
  field: HollowField,
  nx = SHELL_NX,
  ny = SHELL_NY,
  nz = SHELL_NZ,
): BufferGeometry {
  const gx = nx + 1
  const gy = ny + 1
  const gz = nz + 1
  const strideY = gx
  const strideZ = gx * gy

  const minX = HOLLOW_MIN.x
  const minY = HOLLOW_MIN.y
  const minZ = HOLLOW_MIN.z
  const dx = HOLLOW_SIZE.x / nx
  const dy = HOLLOW_SIZE.y / ny
  const dz = HOLLOW_SIZE.z / nz

  // 1. Evaluate corner SDF grid (forcing solid rock on outer X/Z/bottom borders while keeping top Y open for skylight)
  const phiGrid = new Float32Array(gx * gy * gz)
  for (let k = 0; k < gz; k++) {
    const z = minZ + k * dz
    const borderZ = k === 0 || k === nz
    for (let j = 0; j < gy; j++) {
      const y = minY + j * dy
      const borderBottom = j === 0
      const rowBase = j * strideY + k * strideZ
      for (let i = 0; i < gx; i++) {
        if (borderBottom || borderZ || i === 0 || i === nx) {
          phiGrid[rowBase + i] = -1.0
        } else {
          phiGrid[rowBase + i] = field.sample(minX + i * dx, y, z, false)
        }
      }
    }
  }

  // 2. Allocate dual vertices in sign-changing cells
  const cellVertIndex = new Int32Array(nx * ny * nz).fill(-1)
  const cellStrideY = nx
  const cellStrideZ = nx * ny

  const positions: number[] = []
  const normals: number[] = []
  const zones: number[] = []
  const blends: number[] = []

  const cornerPhi = new Float32Array(8)
  const cornerX = new Float32Array(8)
  const cornerY = new Float32Array(8)
  const cornerZ = new Float32Array(8)
  const grad = new Vector3()

  const normalEps = Math.max(0.07, 0.45 * Math.min(dx, dy, dz))

  for (let k = 0; k < nz; k++) {
    const z0 = minZ + k * dz
    const z1 = z0 + dz
    for (let j = 0; j < ny; j++) {
      const y0 = minY + j * dy
      const y1 = y0 + dy
      for (let i = 0; i < nx; i++) {
        const base = i + j * strideY + k * strideZ
        const p0 = phiGrid[base]
        const p1 = phiGrid[base + 1]
        const p2 = phiGrid[base + strideY]
        const p3 = phiGrid[base + strideY + 1]
        const p4 = phiGrid[base + strideZ]
        const p5 = phiGrid[base + strideZ + 1]
        const p6 = phiGrid[base + strideY + strideZ]
        const p7 = phiGrid[base + strideY + strideZ + 1]

        let mask = 0
        if (p0 >= 0) mask |= 1
        if (p1 >= 0) mask |= 2
        if (p2 >= 0) mask |= 4
        if (p3 >= 0) mask |= 8
        if (p4 >= 0) mask |= 16
        if (p5 >= 0) mask |= 32
        if (p6 >= 0) mask |= 64
        if (p7 >= 0) mask |= 128
        if (mask === 0 || mask === 255) continue

        const x0 = minX + i * dx
        const x1 = x0 + dx
        cornerPhi[0] = p0; cornerPhi[1] = p1; cornerPhi[2] = p2; cornerPhi[3] = p3
        cornerPhi[4] = p4; cornerPhi[5] = p5; cornerPhi[6] = p6; cornerPhi[7] = p7
        cornerX[0] = x0; cornerX[1] = x1; cornerX[2] = x0; cornerX[3] = x1
        cornerX[4] = x0; cornerX[5] = x1; cornerX[6] = x0; cornerX[7] = x1
        cornerY[0] = y0; cornerY[1] = y0; cornerY[2] = y1; cornerY[3] = y1
        cornerY[4] = y0; cornerY[5] = y0; cornerY[6] = y1; cornerY[7] = y1
        cornerZ[0] = z0; cornerZ[1] = z0; cornerZ[2] = z0; cornerZ[3] = z0
        cornerZ[4] = z1; cornerZ[5] = z1; cornerZ[6] = z1; cornerZ[7] = z1

        let sumX = 0
        let sumY = 0
        let sumZ = 0
        let crossings = 0
        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGE_CORNERS[e]
          const va = cornerPhi[a]
          const vb = cornerPhi[b]
          if ((va >= 0) === (vb >= 0)) continue
          const denom = va - vb
          const t = Math.abs(denom) > 1e-7 ? MathUtils.clamp(va / denom, 0.0, 1.0) : 0.5
          sumX += cornerX[a] + (cornerX[b] - cornerX[a]) * t
          sumY += cornerY[a] + (cornerY[b] - cornerY[a]) * t
          sumZ += cornerZ[a] + (cornerZ[b] - cornerZ[a]) * t
          crossings++
        }

        let vx = sumX / crossings
        let vy = sumY / crossings
        let vz = sumZ / crossings

        // Snap gently toward `phi = 0` while staying strictly inside the dual cell bounds so neighbors never cross
        const pMid = field.sample(vx, vy, vz, false)
        field.sampleNormal(vx, vy, vz, grad, false, normalEps)
        const step = MathUtils.clamp(-pMid * 0.35, -0.25 * dx, 0.25 * dx)
        vx = MathUtils.clamp(vx + grad.x * step, x0 + 0.05 * dx, x1 - 0.05 * dx)
        vy = MathUtils.clamp(vy + grad.y * step, y0 + 0.05 * dy, y1 - 0.05 * dy)
        vz = MathUtils.clamp(vz + grad.z * step, z0 + 0.05 * dz, z1 - 0.05 * dz)

        field.sampleNormal(vx, vy, vz, grad, false, normalEps)
        const zInfo = field.zonesAt(vx, vy, vz, grad.y)

        const vIdx = positions.length / 3
        cellVertIndex[i + j * cellStrideY + k * cellStrideZ] = vIdx
        positions.push(vx, vy, vz)
        normals.push(grad.x, grad.y, grad.z)
        zones.push(zInfo.strata, zInfo.travertine, zInfo.rimstone, zInfo.wetness)
        blends.push(0.0)
      }
    }
  }

  // 3. Connect dual quads across sign-changing interior edges along `+grad(phi)`, splitting along the shorter diagonal
  const indices: number[] = []
  const emitQuad = (v0: number, v1: number, v2: number, v3: number, flip: boolean) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return
    const d02x = positions[v0 * 3] - positions[v2 * 3]
    const d02y = positions[v0 * 3 + 1] - positions[v2 * 3 + 1]
    const d02z = positions[v0 * 3 + 2] - positions[v2 * 3 + 2]
    const d13x = positions[v1 * 3] - positions[v3 * 3]
    const d13y = positions[v1 * 3 + 1] - positions[v3 * 3 + 1]
    const d13z = positions[v1 * 3 + 2] - positions[v3 * 3 + 2]
    const use02 = (d02x * d02x + d02y * d02y + d02z * d02z) <= (d13x * d13x + d13y * d13y + d13z * d13z)
    if (use02) {
      if (!flip) indices.push(v0, v1, v2, v0, v2, v3)
      else indices.push(v0, v2, v1, v0, v3, v2)
    } else {
      if (!flip) indices.push(v1, v2, v3, v1, v3, v0)
      else indices.push(v1, v3, v2, v1, v0, v3)
    }
  }

  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const gBase = i + j * strideY + k * strideZ
        const p0 = phiGrid[gBase]
        const s0 = p0 >= 0

        // +X edge `(i, j, k) -> (i + 1, j, k)` (skip `i = nx - 1` outer wall; skip top row `j = ny` already `< ny`)
        if (i < nx - 1) {
          const sX = phiGrid[gBase + 1] >= 0
          if (s0 !== sX) {
            const v0 = cellVertIndex[i + (j - 1) * cellStrideY + (k - 1) * cellStrideZ]
            const v1 = cellVertIndex[i + j * cellStrideY + (k - 1) * cellStrideZ]
            const v2 = cellVertIndex[i + j * cellStrideY + k * cellStrideZ]
            const v3 = cellVertIndex[i + (j - 1) * cellStrideY + k * cellStrideZ]
            emitQuad(v0, v1, v2, v3, s0)
          }
        }

        // +Y edge `(i, j, k) -> (i, j + 1, k)`
        if (j < ny - 1) {
          const sY = phiGrid[gBase + strideY] >= 0
          if (s0 !== sY) {
            const v0 = cellVertIndex[(i - 1) + j * cellStrideY + (k - 1) * cellStrideZ]
            const v1 = cellVertIndex[(i - 1) + j * cellStrideY + k * cellStrideZ]
            const v2 = cellVertIndex[i + j * cellStrideY + k * cellStrideZ]
            const v3 = cellVertIndex[i + j * cellStrideY + (k - 1) * cellStrideZ]
            emitQuad(v0, v1, v2, v3, s0)
          }
        }

        // +Z edge `(i, j, k) -> (i, j, k + 1)`
        if (k < nz - 1) {
          const sZ = phiGrid[gBase + strideZ] >= 0
          if (s0 !== sZ) {
            const v0 = cellVertIndex[(i - 1) + (j - 1) * cellStrideY + k * cellStrideZ]
            const v1 = cellVertIndex[i + (j - 1) * cellStrideY + k * cellStrideZ]
            const v2 = cellVertIndex[i + j * cellStrideY + k * cellStrideZ]
            const v3 = cellVertIndex[(i - 1) + j * cellStrideY + k * cellStrideZ]
            emitQuad(v0, v1, v2, v3, s0)
          }
        }
      }
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('aZone', new BufferAttribute(new Float32Array(zones), 4))
  geometry.setAttribute('aCollar', new BufferAttribute(new Float32Array(blends), 1))
  geometry.setIndex(indices)
  const bounds = new Box3(HOLLOW_MIN.clone(), HOLLOW_MAX.clone())
  geometry.boundingBox = bounds
  geometry.boundingSphere = bounds.getBoundingSphere(new Sphere())
  return geometry
}

/**
 * Builds the meandering main lake water surface mesh at `y = waterLevel`, trimmed around dry walls and outside the
 * stepped foreground rimstone (`gour`) dam so the raised shallow sinter basin is never intersected by `y = 0` water.
 */
export function buildHollowLakeGeometry(field: HollowField, cols = 112, rows = 144): BufferGeometry {
  const wl = field.params.waterLevel
  const widthScale = field.params.cavernWidth
  const minX = -7.6 * widthScale
  const maxX = 5.4 * widthScale
  const minZ = -12.0
  const maxZ = 3.4

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

      const uRim = field.rimstoneCoord(x, z)
      const floorY = field.floorHeightAt(x, z, true)
      const rawDepth = wl - floorY
      depths[p] = Math.max(0.0, rawDepth)
      // Keep shoreline margin (`rawDepth > -0.22`) so water tucks cleanly into sloped rock banks, but stay outside rimstone basin
      validMask[p] = rawDepth > -0.22 && uRim > 0.94 ? 1 : 0
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
        if (field.rimstoneCoord(cx, cz) < 0.93) continue
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
 * Builds the slightly elevated (`+8.5 cm`) shallow amber mineral water meniscus enclosed inside the lower-left
 * foreground scalloped rimstone (`gour`) dam.
 */
export function buildRimstonePoolGeometry(field: HollowField, rings = 22, sectors = 64): BufferGeometry {
  const scale = Math.max(0.35, field.params.rimstoneScale)
  const poolY = field.params.waterLevel + RIMSTONE_POOL_STEP
  const cx = field.rimstoneCenter.x
  const cz = field.rimstoneCenter.z

  const positions: number[] = [cx, poolY, cz]
  const normals: number[] = [0, 1, 0]
  const depths: number[] = [RIMSTONE_POOL_STEP - 0.025]

  // Match `HollowField.rimstoneCoord` inverse polar mapping so boundary hugs the inner dam wall (`u = 0.90`)
  const rotC = 0.92
  const rotS = -0.39

  for (let ir = 1; ir <= rings; ir++) {
    const radialT = ir / rings
    for (let is = 0; is < sectors; is++) {
      const theta = (is / sectors) * Math.PI * 2
      // March outward from center along ray `(cos theta, sin theta)` until `rimstoneCoord == 0.905`
      const dirX = Math.cos(theta)
      const dirZ = Math.sin(theta)
      const worldDirX = rotC * dirX * 2.05 * scale - rotS * dirZ * 1.38 * scale
      const worldDirZ = rotS * dirX * 2.05 * scale + rotC * dirZ * 1.38 * scale

      let lo = 0.0
      let hi = 1.35
      for (let b = 0; b < 8; b++) {
        const mid = 0.5 * (lo + hi)
        if (field.rimstoneCoord(cx + worldDirX * mid, cz + worldDirZ * mid) < 0.905) lo = mid
        else hi = mid
      }
      const rEdge = 0.5 * (lo + hi) * radialT
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
