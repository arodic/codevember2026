import { describe, it, expect } from 'vitest'
import { BufferAttribute, BufferGeometry, Vector3 } from 'three/webgpu'
import { HOLLOW_MAX, HollowField, RIMSTONE_LIP_HEIGHT, RIMSTONE_POOL_STEP } from './HollowField.js'
import { buildHollowLakeGeometry, buildRimstonePoolGeometry } from './HollowLake.js'
import { placeHollowRocks } from './HollowRocks.js'
import { buildHollowSpeleothems } from './HollowSpeleothems.js'
import { FLOW_LOBE, HollowSculpt } from './HollowSculpt.js'
import { HollowSculptPool } from './HollowSculptPool.js'
import { scheduleHollowDrops } from './HollowWater.js'
import { CHUNK_TRIANGLES, SKIRT_DEPTH, buildHollowChunks } from './HollowChunks.js'

const SEEDS = [1056, 7, 41, 908, 1337, 42, 777, 2501]

/** Edges bordering an odd number of triangles (thin features may pinch 4), except at the skylight mouth. */
function openEdges(geometry: BufferGeometry) {
  const pos = geometry.getAttribute('position')
  const idx = geometry.getIndex()!
  const edgeUse = new Map<number, number>()
  const n = pos.count
  for (let i = 0; i < idx.count; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx.getX(i + e)
      const b = idx.getX(i + (e + 1) % 3)
      const key = Math.min(a, b) * n + Math.max(a, b)
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1)
    }
  }
  let open = 0
  for (const [key, uses] of edgeUse) {
    if (uses % 2 === 0) continue
    if (Math.min(pos.getY(Math.floor(key / n)), pos.getY(key % n)) > HOLLOW_MAX.y - 0.5) continue
    open++
  }
  return open
}

describe('Hollow — karst SDF, sculpted cave & speleothems', () => {
  it('sculpts an open cavern corridor, open skylight chimney, stepped rimstone dam, and behind-camera fire alcove', () => {
    const field = new HollowField({seed: 1056})
    const pose = field.cinemaPose

    // 1. Camera stand & main lake cavern air must be open (`phi > 0`)
    expect(field.sample(pose.startX, pose.height, pose.startZ)).toBeGreaterThan(0.35)
    expect(field.sample(field.spineX(-4.0), 2.0, -4.0)).toBeGreaterThan(0.8)

    // 2. Skylight sinkhole throat punches open through the top of the volume
    const sky = field.skylightCenter
    expect(field.sample(sky.x, Math.min(10.4, sky.y + 0.4), sky.z)).toBeGreaterThan(0.8)

    // 3. Warm fire sits in open air BEHIND the cinema camera plane (never in the widescreen look direction)
    const fire = field.fireOrigin
    expect(field.sample(fire.x, fire.y, fire.z)).toBeGreaterThan(0.5)

    const cam = new Vector3(pose.startX, pose.height, pose.startZ)
    const look = new Vector3(pose.targetX, pose.targetY, pose.targetZ).sub(cam).normalize()
    const toFire = new Vector3().subVectors(fire, cam)
    expect(toFire.dot(look)).toBeLessThan(-1.5)
    expect(fire.z).toBeGreaterThan(pose.startZ + 1.5)

    // 4. Main lake has deep water somewhere along the meander; rimstone dam encloses a raised shallow basin
    let maxLakeDepth = 0
    for (const z of [-1.5, -3.0, -4.5, -6.0, -8.0]) {
      for (const dx of [-0.6, 0, 0.6, 1.2]) {
        maxLakeDepth = Math.max(maxLakeDepth, field.lakeDepthAt(field.spineX(z) + dx, z))
      }
    }
    expect(maxLakeDepth).toBeGreaterThan(0.55)

    const rc = field.rimstoneCenter
    const basinFloor = field.floorHeightAt(rc.x, rc.z, false)
    expect(basinFloor).toBeGreaterThan(0.0)
    expect(basinFloor).toBeLessThan(RIMSTONE_POOL_STEP)

    // Lip crest (`rimstoneCoord ≈ 0.92`) must rise above the shallow meniscus (may sit on benches too)
    let maxLipY = -Infinity
    for (let a = 0; a < Math.PI * 2; a += 0.28) {
      for (let r = 0.35; r <= 3.2; r += 0.06) {
        const x = rc.x + Math.cos(a) * r
        const z = rc.z + Math.sin(a) * r
        const u = field.rimstoneCoord(x, z)
        if (u < 0.84 || u > 1.02) continue
        maxLipY = Math.max(maxLipY, field.floorHeightAt(x, z, false))
      }
    }
    expect(maxLipY).toBeGreaterThan(Math.max(basinFloor, RIMSTONE_POOL_STEP) + 0.04)
    expect(maxLipY).toBeGreaterThanOrEqual(RIMSTONE_LIP_HEIGHT - 0.02)

    // The cascade climbs in rimstone terraces: crests standing proud of the pools behind them
    let crests = 0
    const cz0 = field.cascadeStart - 0.5
    const cz1 = field.cascadeEnd + 0.5
    for (let z = cz0; z > cz1; z -= 0.01) {
      const x = field.spineX(z)
      const h = field.floorHeightAt(x, z, false)
      const behind = field.floorHeightAt(x, z - 0.12, false)
      if (h > field.floorHeightAt(x, z + 0.01, false) && h >= field.floorHeightAt(x, z - 0.01, false) && h > behind + 0.01) crests++
    }
    expect(crests).toBeGreaterThanOrEqual(Math.round(field.params.terraceSteps / 2))
  })

  it('reshuffles major composition landmarks across seeds for widescreen seed-hunting', () => {
    // Include default demo seed 1056 among a spread of unrelated seeds (no single-seed overfitting)
    const fields = SEEDS.map(seed => new HollowField({seed}))

    const landmarkSpread = (fs: HollowField[]) => {
      const spines = fs.map(f => f.spineX(-6))
      const skies = fs.map(f => f.skylightCenter.x + f.skylightCenter.z)
      const rims = fs.map(f => f.rimstoneCenter.x + f.rimstoneCenter.z * 0.5)
      const fires = fs.map(f => f.fireOrigin.x + f.fireOrigin.z)
      const cams = fs.map(f => f.cinemaPose.startX + f.cinemaPose.startZ + f.cinemaPose.targetZ)
      const vaults = fs.map(f => f.ceilingHeightAt(f.spineX(-4), -4, false))
      const tracks = fs.map(f => f.cinemaTracks.forward + f.cinemaTracks.lateral)
      const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
      return {
        spine: range(spines), sky: range(skies), rim: range(rims), fire: range(fires),
        cam: range(cams), vault: range(vaults), track: range(tracks),
      }
    }

    const spread = landmarkSpread(fields)
    expect(spread.spine).toBeGreaterThan(3.5)
    expect(spread.sky).toBeGreaterThan(6.0)
    expect(spread.rim).toBeGreaterThan(3.0)
    expect(spread.fire).toBeGreaterThan(5.0)
    expect(spread.cam).toBeGreaterThan(5.0)
    expect(spread.vault).toBeGreaterThan(1.2)
    expect(spread.track).toBeGreaterThan(1.0)

    // Hero / rimstone sides and look aims must actually flip across the seed set
    const heroSides = new Set(fields.map(f => f.heroSide))
    expect(heroSides.size).toBe(2)
    const rimSigns = new Set(fields.map(f => Math.sign(f.rimstoneCenter.x - f.cinemaPose.startX) || 1))
    expect(rimSigns.size).toBe(2)

    // Every seed keeps fire well behind its own cinema camera plane, and its camera looks into the cavern, not a wall
    for (const field of fields) {
      expect(field.viewClearance()).toBeGreaterThan(0.9)
      const pose = field.cinemaPose
      const cam = new Vector3(pose.startX, pose.height, pose.startZ)
      const look = new Vector3(pose.targetX, pose.targetY, pose.targetZ).sub(cam).normalize()
      expect(new Vector3().subVectors(field.fireOrigin, cam).dot(look)).toBeLessThan(-1.5)
      expect(field.fireOrigin.z).toBeGreaterThan(pose.startZ + 1.5)
    }
  })

  it('fits the lake and rimstone pool meshes to every seed\'s own lake and dam', () => {
    for (const seed of SEEDS) {
      const field = new HollowField({seed})
      const lake = buildHollowLakeGeometry(field, 0.4)
      expect(lake.getIndex()!.count).toBeGreaterThan(300)
      const box = lake.boundingBox!
      // Every patch of deep open water is covered by the lake mesh
      const e = field.lakeExtent
      for (let z = e.minZ; z <= e.maxZ; z += 0.5) {
        for (let x = e.minX; x <= e.maxX; x += 0.5) {
          if (field.lakeDepthAt(x, z) < 0.3) continue
          expect(x).toBeGreaterThanOrEqual(box.min.x - 1e-3)
          expect(x).toBeLessThanOrEqual(box.max.x + 1e-3)
          expect(z).toBeGreaterThanOrEqual(box.min.z - 1e-3)
          expect(z).toBeLessThanOrEqual(box.max.z + 1e-3)
        }
      }

      // The pool's rim hugs the inner dam wall (its edge just under the face), whatever the seed's dam size and yaw
      const pool = buildRimstonePoolGeometry(field, 12, 32)
      const pos = pool.getAttribute('position') as BufferAttribute
      const poolY = field.params.waterLevel + RIMSTONE_POOL_STEP
      let maxU = 0
      for (let i = 0; i < pos.count; i++) maxU = Math.max(maxU, field.rimstoneCoord(pos.getX(i), pos.getZ(i)))
      expect(maxU).toBeLessThan(0.95)
      expect(maxU).toBeGreaterThan(0.86)
      for (let i = pos.count - 32; i < pos.count; i++) {
        expect(field.floorHeightAt(pos.getX(i), pos.getZ(i), false)).toBeGreaterThan(poolY)
      }
      lake.dispose()
      pool.dispose()
    }
  })

  it('places boulders, dripstones, draperies and over-lake drip emitters', () => {
    const field = new HollowField({seed: 1056})
    const rocks = placeHollowRocks(field, 6)
    expect(rocks.length).toBeGreaterThan(6)

    const speleothems = buildHollowSpeleothems(field, {stalactiteDensity: 1, stalagmiteDensity: 1, draperyScale: 1, flowstoneDensity: 1})
    expect(speleothems.stalactiteCount).toBeGreaterThan(80)
    expect(speleothems.stalagmiteCount).toBeGreaterThan(8)
    expect(speleothems.draperyCount).toBeGreaterThanOrEqual(4)
    expect(speleothems.flowstoneCount).toBeGreaterThanOrEqual(2)
    expect(speleothems.bodies.length).toBe(
      speleothems.stalactiteCount + speleothems.stalagmiteCount + speleothems.draperyCount + speleothems.flowstoneCount,
    )
    // Formations of every form: carrots, straws and icicles; pagodas, candles, cones and bosses
    const forms = new Set(speleothems.bodies.map(b => b.kind === 'stalactite' || b.kind === 'stalagmite' ? b.form : b.kind))
    for (const form of ['carrot', 'straw', 'icicle', 'pagoda', 'candle', 'cone', 'boss']) {
      expect(forms.has(form as never), form).toBe(true)
    }

    // Every body is solid at its core and open around it (its own distance, not counting the cave)
    const sculpt = new HollowSculpt(field, [...rocks, ...speleothems.bodies])
    for (const body of sculpt.bodies) {
      let core: Vector3
      if (body.kind === 'rock') core = body.center
      else if (body.kind === 'stalactite') core = new Vector3(...body.spine.subarray(8, 11))
      else if (body.kind === 'stalagmite') core = new Vector3(...body.plates.subarray(0, 3))
      else if (body.kind === 'flowstone') core = new Vector3(...body.lobes.subarray(0, 3))
      else core = new Vector3(...body.curve.subarray(body.curve.length / 2 - 1, body.curve.length / 2 + 2))
      expect(sculpt.bodyDistance(body, core.x, core.y, core.z)).toBeLessThan(0)
      expect(sculpt.bodyDistance(body, body.max.x + 0.2, body.max.y + 0.2, body.max.z + 0.2)).toBeGreaterThan(0)
    }
    // No long, thin stalactites: past a straw's length, one is still fat halfway down
    for (const b of speleothems.bodies) {
      if (b.kind !== 'stalactite') continue
      const S = b.spine
      const rings = S.length / 4 - 2
      const length = Math.hypot(S[S.length - 4] - S[4], S[S.length - 3] - S[5], S[S.length - 2] - S[6])
      if (length > 0.35) expect(S[(1 + Math.floor(rings / 2)) * 4 + 3], `${b.form} ${length.toFixed(2)} m`).toBeGreaterThan(0.025)
    }
    // A stalactite hangs from its anchor to its tip
    const stalactite = speleothems.bodies.find(b => b.kind === 'stalactite')
    expect(stalactite?.kind).toBe('stalactite')
    const s = stalactite!.kind === 'stalactite' ? stalactite!.spine : new Float32Array(8)
    expect(s[s.length - 3]).toBeLessThan(s[5])
    // A flowstone runs down the wall it seeps from, and stands out of it
    for (const flow of speleothems.bodies) {
      if (flow.kind !== 'flowstone') continue
      const L = flow.lobes
      expect(L[1] - L[L.length - FLOW_LOBE + 1]).toBeGreaterThan(0.5)
      const outside = new Vector3(...L.subarray(0, 3)).addScaledVector(new Vector3(...L.subarray(9, 12)), L[14] + 0.02)
      expect(field.sample(outside.x, outside.y, outside.z)).toBeGreaterThan(0)
    }
    // A drapery is a sheet a few centimetres thick: solid on its curve, open a decimetre off it
    const drapery = speleothems.bodies.find(b => b.kind === 'drapery')!
    if (drapery.kind === 'drapery') {
      const c = drapery.curve
      const i = Math.floor(c.length / 6) * 3
      const tx = c[i + 3] - c[i]
      const tz = c[i + 5] - c[i + 2]
      const l = Math.hypot(tx, tz)
      const below = c[i + 1] - 0.4
      expect(sculpt.bodyDistance(drapery, c[i], below, c[i + 2])).toBeLessThan(-0.015)
      expect(sculpt.bodyDistance(drapery, c[i] - (tz / l) * 0.12, below, c[i + 2] + (tx / l) * 0.12)).toBeGreaterThan(0.02)
    }

    expect(speleothems.dripEmitters.length).toBeGreaterThan(2)
    for (const tip of speleothems.dripEmitters) {
      expect(tip.y).toBeGreaterThan(field.params.waterLevel + 0.5)
      expect(field.lakeDepthAt(tip.x, tip.z)).toBeGreaterThan(0.15)
    }

    // Drops: seeded, inside the loop, falling exactly from their tip to the water
    const duration = 90
    const drops = scheduleHollowDrops(field, speleothems.dripEmitters, duration)
    expect(drops).toEqual(scheduleHollowDrops(field, speleothems.dripEmitters, duration))
    expect(drops.length).toBeGreaterThan(30)
    for (const drop of drops) {
      expect(drop.spawn).toBeGreaterThanOrEqual(0)
      expect(drop.spawn).toBeLessThan(duration)
      const height = speleothems.dripEmitters[drop.emitter].y - field.params.waterLevel
      expect(drop.speed * drop.fall + 0.5 * 9.81 * drop.fall * drop.fall).toBeCloseTo(height, 4)
    }
  })

  it('sculpts the cave and its bodies as one closed surface, materials blended across the fillets', async () => {
    const start = performance.now()
    const field = new HollowField({seed: 1056})
    const speleothems = buildHollowSpeleothems(field, {stalactiteDensity: 1, stalagmiteDensity: 1, draperyScale: 1, flowstoneDensity: 1})
    const bodies = [...placeHollowRocks(field, 10), ...speleothems.bodies]
    const pool = new HollowSculptPool()
    const cave = (await pool.build(field, bodies))!
    pool.dispose()
    // Well within the budget (`30 s`) on the workers
    console.log(`Hollow sculpt: ${((performance.now() - start) / 1000).toFixed(1)} s, ${cave.getAttribute('position').count} vertices`)
    expect(performance.now() - start).toBeLessThan(30_000)
    const sculpt = new HollowSculpt(field, bodies)

    const pos = cave.getAttribute('position') as BufferAttribute
    const norm = cave.getAttribute('normal') as BufferAttribute
    const zone = cave.getAttribute('aZone') as BufferAttribute
    const ao = cave.getAttribute('aOcclusion') as BufferAttribute
    const idx = cave.getIndex()!
    expect(pos.count).toBeGreaterThan(200000)

    // Closed but for the skylight's mouth, and wound with its front faces into the open (along the normals)
    expect(openEdges(cave)).toBe(0)
    const p0 = new Vector3()
    const p1 = new Vector3()
    const p2 = new Vector3()
    const n = new Vector3()
    let aligned = 0
    let faces = 0
    for (let i = 0; i < idx.count; i += 3 * 7) {
      p0.fromBufferAttribute(pos, idx.getX(i))
      p1.fromBufferAttribute(pos, idx.getX(i + 1))
      p2.fromBufferAttribute(pos, idx.getX(i + 2))
      const face = p1.sub(p0).cross(p2.sub(p0))
      if (face.lengthSq() < 1e-12) continue
      faces++
      if (face.dot(n.fromBufferAttribute(norm, idx.getX(i))) > 0) aligned++
    }
    expect(aligned / faces).toBeGreaterThan(0.98)

    // On the surface, unit normals, occlusion in [0, 1]
    let off = 0
    for (let v = 0; v < pos.count; v += 13) {
      if (Math.abs(sculpt.distance(pos.getX(v), pos.getY(v), pos.getZ(v))) > 0.01) off++
      expect(n.fromBufferAttribute(norm, v).length()).toBeCloseTo(1, 4)
      expect(ao.getX(v)).toBeGreaterThanOrEqual(0)
      expect(ao.getX(v)).toBeLessThanOrEqual(1)
    }
    expect(off / (pos.count / 13)).toBeLessThan(0.02)

    // Around a stalagmite's foot the calcite runs out onto the cave: travertine falls off with the distance, through
    // values between the two (a blend, not a seam)
    const stalagmites = speleothems.bodies.filter(b => b.kind === 'stalagmite')
    const bands = [0, 0, 0]
    const between = [0, 0, 0]
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v)
      const y = pos.getY(v)
      const z = pos.getZ(v)
      for (const body of stalagmites) {
        const d = sculpt.bodyDistance(body, x, y, z)
        if (d < 0.01 || d > 3 * body.blend) continue
        const band = d < body.blend ? 0 : d < 2 * body.blend ? 1 : 2
        bands[band]++
        const cave = field.zonesAt(x, y, z, norm.getY(v)).travertine
        const t = zone.getY(v)
        if (t > Math.min(cave, 0.92) + 0.02 && t < Math.max(cave, 0.92) - 0.02) between[band]++
        break
      }
    }
    expect(bands[0]).toBeGreaterThan(100)
    expect(between[0] / bands[0]).toBeGreaterThan(0.5)
    expect(between[2] / bands[2]).toBeLessThan(between[0] / bands[0])

    // The rimstone dam's lip gets fine cells
    const wl = field.params.waterLevel
    let rimEdges = 0
    let rimLength = 0
    for (let i = 0; i < idx.count; i++) {
      p0.fromBufferAttribute(pos, idx.getX(i))
      p1.fromBufferAttribute(pos, idx.getX(i - (i % 3) + ((i % 3) + 1) % 3))
      const mid = p2.addVectors(p0, p1).multiplyScalar(0.5)
      if (field.rimstoneCoord(mid.x, mid.z) > 1.2 || Math.abs(mid.y - wl) > 0.25) continue
      rimEdges++
      rimLength += p0.distanceTo(p1)
    }
    expect(rimEdges).toBeGreaterThan(3000)
    expect(rimLength / rimEdges).toBeLessThan(0.08)

    // The drapery sheets are part of the surface, their triangles drawn with the translucent calcite: thin where
    // they hang free, thickening to opaque rock across their fillets
    const sheet = cave.getAttribute('aSheet') as BufferAttribute
    const [rock, calcite] = cave.groups
    expect(rock.start).toBe(0)
    expect(calcite.start).toBe(rock.count)
    expect(rock.count + calcite.count).toBe(idx.count)
    expect(calcite.count / 3).toBeGreaterThan(50000)
    let thin = 0
    for (let i = calcite.start; i < calcite.start + calcite.count; i += 3 * 5) {
      const t = sheet.getX(idx.getX(i))
      expect(t).toBeGreaterThan(0.03)
      if (t < 0.1) thin++
    }
    expect(thin / (calcite.count / 15)).toBeGreaterThan(0.6)
    for (let i = 0; i < rock.count; i += 3 * 101) expect(sheet.getX(idx.getX(i))).toBeGreaterThan(0.3)

    // Hardly a fold: triangles turned against their vertices' normals, bigger than a twentieth of their cell, are rare
    let flipped = 0
    for (let i = 0; i < idx.count; i += 3) {
      p0.fromBufferAttribute(pos, idx.getX(i))
      p1.fromBufferAttribute(pos, idx.getX(i + 1))
      p2.fromBufferAttribute(pos, idx.getX(i + 2))
      const face = p1.sub(p0).cross(p2.sub(p0))
      n.fromBufferAttribute(norm, idx.getX(i))
        .add(p0.fromBufferAttribute(norm, idx.getX(i + 1)))
        .add(p0.fromBufferAttribute(norm, idx.getX(i + 2)))
      if (face.dot(n) < 0 && face.length() > 2e-4) flipped++
    }
    expect(flipped).toBeLessThan(idx.count / 3 / 5000)

    // Drawn in chunks over a 4096² atlas: every face of the surface in one chunk, each vertex on the surface (or its
    // chunk's skirt, a few centimetres behind it) and keeping its surface vertex's light map texel
    const chunks = buildHollowChunks(cave)
    expect(chunks.scale).toBeGreaterThan(30)
    let chunkTriangles = 0
    for (const chunk of chunks.render) {
      const cp = chunk.getAttribute('position') as BufferAttribute
      const cuv = chunk.getAttribute('uv') as BufferAttribute
      const texel = chunk.getAttribute('aLightTexel') as BufferAttribute
      chunkTriangles += chunk.getIndex()!.count / 3
      expect(chunk.groups[0].materialIndex).toBe(0)
      for (let v = 0; v < cp.count; v += 17) {
        expect(cuv.getX(v)).toBeGreaterThan(0)
        expect(cuv.getX(v)).toBeLessThan(1)
        expect(cuv.getY(v)).toBeGreaterThan(0)
        expect(cuv.getY(v)).toBeLessThan(1)
        const t = texel.getX(v)
        expect(Number.isInteger(t) && t < pos.count).toBe(true)
        const gap = p0.fromBufferAttribute(cp, v).distanceTo(p1.fromBufferAttribute(pos, t))
        expect(Math.min(gap, Math.abs(gap - SKIRT_DEPTH))).toBeLessThan(1e-4)
      }
    }
    expect(chunks.render.length).toBeGreaterThan(idx.count / 3 / CHUNK_TRIANGLES)
    expect(chunkTriangles).toBeGreaterThan(idx.count / 3)
    expect(chunkTriangles).toBeLessThan(idx.count / 3 * 1.1)

    cave.dispose()
  })
})
