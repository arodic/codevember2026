import { describe, it, expect } from 'vitest'
import { BufferAttribute, Vector3 } from 'three/webgpu'
import { HollowField, RIMSTONE_LIP_HEIGHT, RIMSTONE_POOL_STEP } from './HollowField.js'
import { buildHollowLakeGeometry, buildHollowShellGeometry, buildRimstonePoolGeometry } from './HollowShell.js'
import { buildHollowRocks } from './HollowRocks.js'
import { buildHollowSpeleothems } from './HollowSpeleothems.js'

describe('Hollow Phase 1 — Karst SDF, Surface Nets Shell & Speleothems', () => {
  it('sculpts an open cavern corridor, open skylight chimney, stepped rimstone dam, and behind-camera fire alcove', () => {
    const field = new HollowField({seed: 7})
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
    expect(toFire.dot(look)).toBeLessThan(-0.15)
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
  })

  it('reshuffles major composition landmarks across seeds for widescreen seed-hunting', () => {
    const a = new HollowField({seed: 7})
    const b = new HollowField({seed: 41})
    const c = new HollowField({seed: 908})

    const landmarkSpread = (fields: HollowField[]) => {
      const spines = fields.map(f => f.spineX(-6))
      const skies = fields.map(f => f.skylightCenter.x + f.skylightCenter.z)
      const rims = fields.map(f => f.rimstoneCenter.x + f.rimstoneCenter.z * 0.5)
      const fires = fields.map(f => f.fireOrigin.x + f.fireOrigin.z)
      const cams = fields.map(f => f.cinemaPose.startX + f.cinemaPose.startZ + f.cinemaPose.targetZ)
      const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
      return {spine: range(spines), sky: range(skies), rim: range(rims), fire: range(fires), cam: range(cams)}
    }

    const spread = landmarkSpread([a, b, c])
    expect(spread.spine).toBeGreaterThan(1.5)
    expect(spread.sky).toBeGreaterThan(3.0)
    expect(spread.rim).toBeGreaterThan(1.2)
    expect(spread.fire).toBeGreaterThan(2.5)
    expect(spread.cam).toBeGreaterThan(2.0)

    // Every seed keeps fire behind its own cinema camera plane
    for (const field of [a, b, c]) {
      const pose = field.cinemaPose
      const cam = new Vector3(pose.startX, pose.height, pose.startZ)
      const look = new Vector3(pose.targetX, pose.targetY, pose.targetZ).sub(cam).normalize()
      expect(new Vector3().subVectors(field.fireOrigin, cam).dot(look)).toBeLessThan(0)
    }
  })

  it('extracts a manifold Surface Nets shell with inward-into-air FrontSide winding and matching lake/rimstone meshes', () => {
    const field = new HollowField({seed: 7})
    const shell = buildHollowShellGeometry(field, 66, 36, 88)
    const pos = shell.getAttribute('position') as BufferAttribute
    const norm = shell.getAttribute('normal') as BufferAttribute
    const idx = shell.getIndex()!

    expect(pos.count).toBeGreaterThan(4000)
    expect(idx.count).toBeGreaterThan(12000)

    const p0 = new Vector3()
    const p1 = new Vector3()
    const p2 = new Vector3()
    const e1 = new Vector3()
    const e2 = new Vector3()
    const faceN = new Vector3()
    const vN = new Vector3()

    let aligned = 0
    let nonDegenerate = 0
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i)
      const b = idx.getX(i + 1)
      const c = idx.getX(i + 2)
      p0.fromBufferAttribute(pos, a)
      p1.fromBufferAttribute(pos, b)
      p2.fromBufferAttribute(pos, c)
      e1.subVectors(p1, p0)
      e2.subVectors(p2, p0)
      faceN.crossVectors(e1, e2)
      if (faceN.lengthSq() < 1e-10) continue
      nonDegenerate++
      vN.fromBufferAttribute(norm, a)
      if (faceN.dot(vN) > 0) aligned++
    }
    expect(aligned / nonDegenerate).toBeGreaterThan(0.98)

    const lake = buildHollowLakeGeometry(field, 48, 64)
    const rimPool = buildRimstonePoolGeometry(field, 12, 32)
    expect(lake.getIndex()!.count).toBeGreaterThan(1000)
    expect(rimPool.getIndex()!.count).toBeGreaterThan(500)

    shell.dispose()
    lake.dispose()
    rimPool.dispose()
  })

  it('generates cleaved boulders, speleothems, and active over-lake drip emitters with consistent vertex attributes', () => {
    const field = new HollowField({seed: 7})
    const rocks = buildHollowRocks(field, 6)
    field.setBoulderProxies(rocks.proxies)
    field.rebuildVolumeTexture()

    expect(rocks.proxies.length).toBeGreaterThanOrEqual(8)
    expect(rocks.geometry.getAttribute('aZone').itemSize).toBe(4)
    expect(rocks.geometry.getAttribute('aCollar').itemSize).toBe(1)

    const speleothems = buildHollowSpeleothems(field, {
      stalactiteDensity: 1.0,
      stalagmiteDensity: 1.0,
      draperyScale: 1.0,
    })

    expect(speleothems.stalactiteCount).toBeGreaterThan(80)
    expect(speleothems.stalagmiteCount).toBeGreaterThan(8)
    expect(speleothems.draperyCount).toBeGreaterThanOrEqual(4)
    expect(speleothems.dripEmitters.length).toBeGreaterThan(2)

    for (const tip of speleothems.dripEmitters) {
      expect(tip.y).toBeGreaterThan(field.params.waterLevel + 0.5)
      expect(field.lakeDepthAt(tip.x, tip.z)).toBeGreaterThan(0.15)
    }

    rocks.geometry.dispose()
    speleothems.geometry.dispose()
  })
})
