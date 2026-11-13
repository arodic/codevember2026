import {
  Box3, ClampToEdgeWrapping, ComputeNode, HalfFloatType, LinearFilter, Node, Storage3DTexture, StorageBufferAttribute,
  Vector3, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, clamp, dot, exp, float, globalId, int, length, localId, max, min, mix, saturate, select, storage,
  storageTexture3D, texture3D, textureStore, uint, uniform, uvec3, vec3, vec4, workgroupArray, workgroupBarrier,
  workgroupId,
} from 'three/tsl'
import { BARB_COUNT } from './FeatherMorphology.js'

/** 3D plumage density & optical-depth volume dimensions (`~1.1 mm` trilinear voxels across the feather crown). */
export const VOLUME_W = 64
export const VOLUME_H = 48
export const VOLUME_D = 40

/** Each of the 128 barbs exports 3 bounding envelope sub-capsules (`2 × vec4` per capsule = `6 × vec4` per barb). */
export const CAPSULES_PER_BARB = 3
export const TOTAL_BARB_CAPSULES = BARB_COUNT * CAPSULES_PER_BARB
/** Packed `barbCapsulesAndTorqueBuffer` layout: `[0..383]` = `endsA`, `[384..767]` = `endsB`, `[768..895]` = `barbTorque`. */
export const CAPSULE_B_OFFSET = TOTAL_BARB_CAPSULES
export const BARB_TORQUE_OFFSET = TOTAL_BARB_CAPSULES * 2
export const TOTAL_CAPSULE_TORQUE_VEC4S = TOTAL_BARB_CAPSULES * 2 + BARB_COUNT

export type TypedWorkgroupArray<T extends string> = {
  element(index: Node | number): Node<T>
}

export function sharedArray<T extends string>(type: T, count: number): TypedWorkgroupArray<T> {
  const arr = workgroupArray(type, count) as unknown as {element(index: Node): Node<T>}
  return {
    // WorkgroupInfoElementNode requires a TSL Node (does not auto-wrap raw JS numbers like storageElement does)
    element: (index: Node | number) => arr.element(typeof index === 'number' ? int(index) : index),
  }
}

/**
 * 3D keratin plumage extinction & dual-scattering optical-depth volume (`HalfFloatType` `Storage3DTexture`,
 * `generateMipmaps = false` for universal WebGPU compatibility).
 *
 * Pass 1 (`buildDensityCompute`): `[4, 4, 4]` workgroup brick culling tests 2 barbs per thread against the brick AABB,
 * compacts overlapping barbs in shared memory, and evaluates smooth analytical capsule-envelope density with zero atomics.
 * Pass 2 (`marchLightCompute`): marches optical depth `tauKey` toward the studio backlight softbox, computes local
 * surround sky visibility `ambientVis`, and evaluates forward multi-scattering glow `multiScatter` inside dense down.
 */
export class FeatherVolume {

  readonly densityTexture: Storage3DTexture
  readonly lightTexture: Storage3DTexture
  readonly boundsMin = uniform(new Vector3(-3.6, -5.8, -2.2))
  readonly boundsSize = uniform(new Vector3(7.2, 7.6, 4.4))
  readonly keyDirection = uniform(new Vector3(0.50, 0.46, -0.73).normalize())
  readonly densityScale = uniform(1.0)

  private readonly buildDensityCompute: ComputeNode
  private readonly marchLightCompute: ComputeNode

  constructor(capsulesAndTorqueBuffer: StorageBufferAttribute) {
    this.densityTexture = createVolumeTexture('Feather Density Volume')
    this.lightTexture = createVolumeTexture('Feather Light Volume')

    const capsules = storage(capsulesAndTorqueBuffer, 'vec4', TOTAL_CAPSULE_TORQUE_VEC4S).toReadOnly()
    const densityOut = storageTexture3D(this.densityTexture)
    const lightOut = storageTexture3D(this.lightTexture)

    const bMin = this.boundsMin
    const bSize = this.boundsSize
    const keyDir = this.keyDirection
    const densityMul = this.densityScale
    const gridDims = vec3(VOLUME_W, VOLUME_H, VOLUME_D)
    const densityTex = this.densityTexture

    const sampleDensity = (uvwNode: Node<'vec3'>) => texture3D(densityTex, clamp(uvwNode, 0.0, 1.0)).level(float(0.0)).r

    // Pass 1: 4×4×4 brick-culled smooth analytical plumulaceous density gather (1 storage buffer)
    const densityKernel = Fn(() => {
      const wgBarbIndices = sharedArray('int', BARB_COUNT)
      const wgBarbFlags = sharedArray('int', BARB_COUNT)
      const wgActiveCount = sharedArray('int', 1)

      const lx = int(localId.x)
      const ly = int(localId.y)
      const lz = int(localId.z)
      const tid = lx.add(ly.mul(4)).add(lz.mul(16))

      const brickOriginVoxel = vec3(workgroupId.mul(4))
      const voxelSize = bSize.div(gridDims)
      const brickMin = bMin.add(brickOriginVoxel.mul(voxelSize))
      const brickMax = brickMin.add(voxelSize.mul(4.0))
      const brickCenter = brickMin.add(brickMax).mul(0.5)
      const brickHalfDiag = length(voxelSize.mul(2.0)).add(0.08)

      Loop(2, ({i}) => {
        const bIdx = tid.mul(2).add(i)
        const baseCapA = bIdx.mul(CAPSULES_PER_BARB)
        const baseCapB = baseCapA.add(CAPSULE_B_OFFSET)
        const p0 = capsules.element(baseCapA).xyz
        const p3 = capsules.element(baseCapB.add(2)).xyz
        const mid = capsules.element(baseCapA.add(1)).xyz.add(capsules.element(baseCapB.add(1)).xyz).mul(0.5)
        const maxEnv = max(
          capsules.element(baseCapA).w,
          max(capsules.element(baseCapA.add(1)).w, capsules.element(baseCapB.add(1)).w),
        ).mul(1.35)
        const dMid = length(mid.sub(brickCenter))
        const span = max(length(p0.sub(mid)), length(p3.sub(mid))).add(maxEnv).add(brickHalfDiag)
        wgBarbFlags.element(bIdx).assign(select(dMid.lessThan(span), int(1), int(0)))
      })

      workgroupBarrier()

      If(tid.equal(0), () => {
        const count = int(0).toVar()
        Loop(BARB_COUNT, ({i}) => {
          If(wgBarbFlags.element(i).greaterThan(0), () => {
            wgBarbIndices.element(count).assign(i)
            count.addAssign(1)
          })
        })
        wgActiveCount.element(0).assign(count)
      })

      workgroupBarrier()

      const gx = int(globalId.x)
      const gy = int(globalId.y)
      const gz = int(globalId.z)
      If(gx.lessThan(VOLUME_W).and(gy.lessThan(VOLUME_H)).and(gz.lessThan(VOLUME_D)), () => {
        const uvw = vec3(float(gx).add(0.5), float(gy).add(0.5), float(gz).add(0.5)).div(gridDims)
        const worldPos = bMin.add(uvw.mul(bSize))
        const activeCount = wgActiveCount.element(0)
        const density = float(0.0).toVar()

        Loop(activeCount, ({i}) => {
          const bIdx = wgBarbIndices.element(i)
          const baseCapA = bIdx.mul(CAPSULES_PER_BARB)
          Loop(CAPSULES_PER_BARB, ({i: c}) => {
            const capIdxA = baseCapA.add(c)
            const a = capsules.element(capIdxA)
            const b = capsules.element(capIdxA.add(CAPSULE_B_OFFSET))
            const ab = b.xyz.sub(a.xyz)
            const abLenSq = max(dot(ab, ab), 1e-6)
            const t = clamp(dot(worldPos.sub(a.xyz), ab).div(abLenSq), 0.0, 1.0)
            const closest = a.xyz.add(ab.mul(t))
            const envR = max(mix(a.w, b.w, t).mul(1.25), 0.035)
            const dist = length(worldPos.sub(closest))
            const normD = dist.div(envR)
            If(normD.lessThan(1.25), () => {
              const shell = saturate(float(1.0).sub(normD.mul(normD).mul(0.64)))
              density.addAssign(shell.mul(shell).mul(0.42))
            })
          })
        })

        const finalDensity = min(density.mul(densityMul), 16.0)
        textureStore(densityOut, uvec3(uint(gx), uint(gy), uint(gz)), vec4(finalDensity, 0.0, 0.0, 1.0))
      })
    })().computeKernel([4, 4, 4])
    densityKernel.dispatchSize = [VOLUME_W / 4, VOLUME_H / 4, VOLUME_D / 4]
    this.buildDensityCompute = densityKernel

    // Pass 2: Directional backlight optical-depth march + isotropic surround sky visibility + dual-scattering glow
    const lightKernel = Fn(() => {
      const gx = int(globalId.x)
      const gy = int(globalId.y)
      const gz = int(globalId.z)

      If(gx.lessThan(VOLUME_W).and(gy.lessThan(VOLUME_H)).and(gz.lessThan(VOLUME_D)), () => {
        const uvw = vec3(float(gx).add(0.5), float(gy).add(0.5), float(gz).add(0.5)).div(gridDims)
        const worldPos = bMin.add(uvw.mul(bSize))
        const localRho = sampleDensity(uvw)

        const tauKey = float(0.0).toVar()
        const dist = float(0.09).toVar()
        Loop(10, () => {
          const stepLen = dist.mul(0.36)
          const sampleWorld = worldPos.add(keyDir.mul(dist))
          const sampleUvw = sampleWorld.sub(bMin).div(bSize)
          const inside = sampleUvw.x.greaterThanEqual(0.0).and(sampleUvw.x.lessThanEqual(1.0))
            .and(sampleUvw.y.greaterThanEqual(0.0)).and(sampleUvw.y.lessThanEqual(1.0))
            .and(sampleUvw.z.greaterThanEqual(0.0)).and(sampleUvw.z.lessThanEqual(1.0))
          If(inside, () => {
            const rho = sampleDensity(sampleUvw)
            tauKey.addAssign(rho.mul(stepLen).mul(1.85))
          })
          dist.addAssign(stepLen)
        })

        const stepUv = vec3(2.2).div(gridDims)
        const surround = sampleDensity(uvw.add(vec3(stepUv.x, 0.0, 0.0)))
          .add(sampleDensity(uvw.sub(vec3(stepUv.x, 0.0, 0.0))))
          .add(sampleDensity(uvw.add(vec3(0.0, stepUv.y, 0.0))))
          .add(sampleDensity(uvw.sub(vec3(0.0, stepUv.y, 0.0))))
          .add(sampleDensity(uvw.add(vec3(0.0, 0.0, stepUv.z))))
          .add(sampleDensity(uvw.sub(vec3(0.0, 0.0, stepUv.z))))
          .div(6.0)

        const meanRho = localRho.mul(0.4).add(surround.mul(0.6))
        const ambientVis = exp(meanRho.mul(-0.34)).mul(0.66).add(0.34)
        const multiScatter = float(1.0).sub(exp(meanRho.mul(-0.85))).mul(exp(tauKey.mul(-0.24)))

        textureStore(lightOut, uvec3(uint(gx), uint(gy), uint(gz)), vec4(tauKey, ambientVis, localRho, multiScatter))
      })
    })().computeKernel([4, 4, 4])
    lightKernel.dispatchSize = [VOLUME_W / 4, VOLUME_H / 4, VOLUME_D / 4]
    this.marchLightCompute = lightKernel
  }

  setBounds(bounds: Box3) {
    this.boundsMin.value.copy(bounds.min)
    bounds.getSize(this.boundsSize.value)
  }

  update(renderer: WebGPURenderer) {
    void renderer.compute(this.buildDensityCompute)
    void renderer.compute(this.marchLightCompute)
  }

  dispose() {
    this.buildDensityCompute.dispose()
    this.marchLightCompute.dispose()
    this.densityTexture.dispose()
    this.lightTexture.dispose()
  }
}

function createVolumeTexture(name: string): Storage3DTexture {
  const tex = new Storage3DTexture(VOLUME_W, VOLUME_H, VOLUME_D)
  tex.name = name
  tex.type = HalfFloatType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.mipmapsAutoUpdate = false
  return tex
}
