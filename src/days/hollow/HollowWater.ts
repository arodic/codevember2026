import {
  DataTexture, FloatType, InstancedMesh, LinearFilter, Matrix4, MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial, RedFormat, SphereGeometry, Vector2, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {
  attribute, cameraPosition, color, dot, exp, float, mix, normalize, positionLocal, positionWorld, pow, saturate,
  smoothstep, texture, transformNormalToView, vec2, vec3,
} from 'three/tsl'
import { reflector } from 'three/tsl'
import { HollowField, createHollowRandom } from './HollowField.js'

const WAVE_RES = 256
const GRAVITY = 9.81
const DROPLET_COUNT = 28

interface Droplet {
  active: boolean
  x: number
  y: number
  z: number
  vy: number
}

/**
 * Meandering mirror lake: planar `reflector`, Beer–Lambert body color, falling stalactite droplets, and a CPU
 * capillary-style ripple height field that bends reflection normals (GPU dispersive PDE can replace the stamp later).
 */
export class HollowWater {

  readonly lakeReflector: ReturnType<typeof reflector>
  readonly lakeMaterial: MeshPhysicalNodeMaterial
  readonly rimstoneMaterial: MeshPhysicalNodeMaterial
  readonly dropletMesh: InstancedMesh

  private readonly waveData: Float32Array
  private readonly shoreMask: Uint8Array
  private readonly waveTexture: DataTexture
  private readonly field: HollowField
  private dripEmitters: Vector3[] = []
  private droplets: Droplet[] = []
  private nextSpawn = 0.8
  private rand: () => number = createHollowRandom(1)
  private readonly _m = new Matrix4()
  private readonly _p = new Vector3()
  private readonly waveOrigin = new Vector2(-10, -12)
  private readonly waveExtent = new Vector2(20, 16)

  constructor(field: HollowField) {
    this.field = field

    this.lakeReflector = reflector({resolutionScale: 0.75, bounces: false})
    this.lakeReflector.target.name = 'Lake Reflector'
    this.lakeReflector.target.rotateX(-Math.PI / 2)
    this.lakeReflector.target.userData.selectable = false

    this.waveData = new Float32Array(WAVE_RES * WAVE_RES)
    this.shoreMask = new Uint8Array(WAVE_RES * WAVE_RES)
    this.waveTexture = new DataTexture(this.waveData, WAVE_RES, WAVE_RES, RedFormat, FloatType)
    this.waveTexture.name = 'Hollow Ripple Height'
    this.waveTexture.minFilter = LinearFilter
    this.waveTexture.magFilter = LinearFilter
    this.waveTexture.generateMipmaps = false
    this.waveTexture.needsUpdate = true

    this.lakeMaterial = this.createLakeMaterial()
    this.rimstoneMaterial = this.createRimstoneMaterial()
    this.dropletMesh = this.createDropletMesh()
  }

  syncToField(dripEmitters: Vector3[]) {
    this.dripEmitters = dripEmitters
    this.rand = createHollowRandom(this.field.params.seed * 91 + 5)
    this.nextSpawn = 0.5 + this.rand() * 1.5
    this.waveData.fill(0)
    for (let y = 0; y < WAVE_RES; y++) {
      for (let x = 0; x < WAVE_RES; x++) {
        const wx = this.waveOrigin.x + (x + 0.5) / WAVE_RES * this.waveExtent.x
        const wz = this.waveOrigin.y + (y + 0.5) / WAVE_RES * this.waveExtent.y
        this.shoreMask[y * WAVE_RES + x] = this.field.lakeDepthAt(wx, wz) > 0.04 ? 1 : 0
      }
    }
    this.waveTexture.needsUpdate = true

    const lakeX = this.field.spineX(-4.0)
    this.lakeReflector.target.position.set(lakeX, this.field.params.waterLevel, -4.0)
  }

  private createLakeMaterial() {
    const waterDepth = attribute('aWaterDepth', 'float')
    const material = new MeshPhysicalNodeMaterial({
      roughness: 0.025,
      metalness: 0.0,
      ior: 1.333,
    })
    material.name = 'Hollow Lake'

    const waveUV = positionWorld.xz.sub(vec2(this.waveOrigin.x, this.waveOrigin.y))
      .div(vec2(this.waveExtent.x, this.waveExtent.y))
    const eps = float(1.5 / WAVE_RES)
    const waveMap = texture(this.waveTexture)
    const hC = waveMap.sample(waveUV).r
    const hX = waveMap.sample(waveUV.add(vec2(eps, 0))).r
    const hZ = waveMap.sample(waveUV.add(vec2(0, eps))).r
    const waveN = normalize(vec3(hC.sub(hX).mul(28.0), float(1.0), hC.sub(hZ).mul(28.0)))
    material.normalNode = transformNormalToView(waveN)

    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const nDotV = saturate(dot(waveN, viewDir))
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1.0).sub(nDotV), 5.0)))

    const reflectSample = this.lakeReflector.rgb

    const shallowTint = color(0xa56b32).mul(0.55)
    const deepTint = color(0x0c3d55).mul(0.4)
    const bodyColor = mix(shallowTint, deepTint, smoothstep(0.04, 0.9, waterDepth))
    const absorb = exp(waterDepth.mul(-1.6))
    const body = mix(deepTint, bodyColor, absorb)

    material.colorNode = mix(body, reflectSample, saturate(fresnel.mul(0.95).add(0.06)))
    return material
  }

  private createRimstoneMaterial() {
    const waterDepth = attribute('aWaterDepth', 'float')
    const material = new MeshPhysicalNodeMaterial({
      roughness: 0.05,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      ior: 1.333,
    })
    material.name = 'Hollow Rimstone Pool'

    const sinterFloor = color(0xb97c3e)
    const amberPool = color(0x9e6329)
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const fresnel = float(0.03).add(float(0.97).mul(pow(float(1.0).sub(saturate(viewDir.y)), 5.0)))
    const base = mix(sinterFloor, amberPool, smoothstep(0.01, 0.09, waterDepth))
    material.colorNode = mix(base, this.lakeReflector.rgb.mul(0.85), fresnel.mul(0.65))
    return material
  }

  private createDropletMesh() {
    const geo = new SphereGeometry(1, 8, 6)
    const mat = new MeshBasicNodeMaterial()
    mat.name = 'Hollow Droplet'
    mat.transparent = true
    mat.depthWrite = false
    mat.positionNode = positionLocal.mul(vec3(0.55, 1.4, 0.55))
    mat.colorNode = color(0xc5e7f5).mul(1.5)
    mat.opacityNode = float(0.88)

    const mesh = new InstancedMesh(geo, mat, DROPLET_COUNT)
    mesh.name = 'Falling Droplets'
    mesh.userData.selectable = false
    mesh.frustumCulled = false
    mesh.count = 0
    this.droplets = Array.from({length: DROPLET_COUNT}, () => ({
      active: false, x: 0, y: 0, z: 0, vy: 0,
    }))
    return mesh
  }

  /** Advance ripples + droplets from timeline `time` / `delta`. */
  update(time: number, delta: number) {
    if (delta <= 0) return

    this.stepRipples(delta)

    if (this.dripEmitters.length > 0 && time >= this.nextSpawn) {
      this.spawnDroplet()
      this.nextSpawn = time + 0.4 + this.rand() * 2.1
    }

    const wl = this.field.params.waterLevel
    let live = 0
    for (const d of this.droplets) {
      if (!d.active) continue
      d.vy -= GRAVITY * delta
      d.y += d.vy * delta
      if (d.y <= wl) {
        this.stampRipple(d.x, d.z, 0.55 + this.rand() * 0.45)
        d.active = false
        continue
      }
      const s = 0.016 + Math.min(0.035, Math.abs(d.vy) * 0.0035)
      this._p.set(d.x, d.y, d.z)
      this.dropletMesh.setMatrixAt(live, this._m.makeScale(s, s * 1.35, s).setPosition(this._p))
      live++
    }
    this.dropletMesh.count = live
    this.dropletMesh.instanceMatrix.needsUpdate = true
  }

  private spawnDroplet() {
    const tip = this.dripEmitters[Math.floor(this.rand() * this.dripEmitters.length)]
    if (!tip) return
    const slot = this.droplets.find(d => !d.active)
    if (!slot) return
    slot.active = true
    slot.x = tip.x + (this.rand() - 0.5) * 0.1
    slot.y = tip.y - 0.02
    slot.z = tip.z + (this.rand() - 0.5) * 0.1
    slot.vy = -0.2 - this.rand() * 0.3
  }

  /** Concentric capillary-ish multi-ring stamp (positive core + negative ring). */
  private stampRipple(worldX: number, worldZ: number, strength: number) {
    const u = (worldX - this.waveOrigin.x) / this.waveExtent.x
    const v = (worldZ - this.waveOrigin.y) / this.waveExtent.y
    if (u < 0.02 || u > 0.98 || v < 0.02 || v > 0.98) return
    if (this.field.lakeDepthAt(worldX, worldZ) < 0.05) return

    const cx = u * (WAVE_RES - 1)
    const cy = v * (WAVE_RES - 1)
    const radius = 14
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        const x = Math.round(cx + i)
        const y = Math.round(cy + j)
        if (x < 1 || y < 1 || x >= WAVE_RES - 1 || y >= WAVE_RES - 1) continue
        const r = Math.hypot(i, j)
        // Multi-ring: J0-like lobes for capillary look
        const ring = Math.exp(-r * r * 0.035) * Math.cos(r * 0.95)
        this.waveData[y * WAVE_RES + x] += ring * strength * 0.35
      }
    }
    this.waveTexture.needsUpdate = true
  }

  /** Damped discrete wave step with soft Neumann clamp at dry shore (lakeDepth probe). */
  private stepRipples(delta: number) {
    const prev = this.waveData.slice()
    const c2 = 18.0
    const damp = Math.pow(0.975, delta * 60)
    const dt = Math.min(delta, 1 / 30)
    for (let y = 1; y < WAVE_RES - 1; y++) {
      for (let x = 1; x < WAVE_RES - 1; x++) {
        const i = y * WAVE_RES + x
        const lap = prev[i - 1] + prev[i + 1] + prev[i - WAVE_RES] + prev[i + WAVE_RES] - 4 * prev[i]
        // Light biharmonic via lap-of-neighbors for multi-ring persistence
        const bi = (
          (prev[i + 2] ?? prev[i + 1]) + (prev[i - 2] ?? prev[i - 1])
          + (prev[i + 2 * WAVE_RES] ?? prev[i + WAVE_RES]) + (prev[i - 2 * WAVE_RES] ?? prev[i - WAVE_RES])
          - 4 * lap
        )
        let next = prev[i] + (c2 * lap - 0.08 * bi) * dt * dt
        next *= damp
        if (!this.shoreMask[i]) next = 0
        this.waveData[i] = next
      }
    }
    this.waveTexture.needsUpdate = true
  }

  onBeforeDraw(_renderer: WebGPURenderer) {
    // Reflector updates with the scene automatically via TSL reflector node
  }

  dispose() {
    this.lakeReflector.dispose()
    this.lakeMaterial.dispose()
    this.rimstoneMaterial.dispose()
    this.dropletMesh.geometry.dispose()
    ;(this.dropletMesh.material as MeshBasicNodeMaterial).dispose()
    this.waveTexture.dispose()
  }
}
