import {
  ComputeNode, HalfFloatType, InstancedMesh, LinearFilter, Matrix4, Node, NodeBuilder, SphereGeometry, StorageTexture,
  Vector2, Vector3, Vector4, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, attribute, cameraPosition, dot, exp, float, instanceIndex, instancedArray, int, ivec2, mix, normalView,
  normalize, positionLocal, positionViewDirection, positionWorld, pow, reflector, saturate, screenUV, sqrt, texture,
  textureStore, transformNormalToView, uniformArray, uniform, vec2, vec3, vec4, viewportTexture,
} from 'three/tsl'
import {HollowField, createHollowRandom} from './HollowField.js'
import {HollowLitMaterial} from './HollowMaterial.js'
import type {HollowAtmosphere} from './HollowAtmosphere.js'

/** Ripple grid resolution (cells per side) of the GPU wave solver. */
export const WAVE_RES = 512
/** Shore-mask resolution; upsampled to `WAVE_RES` (the mask needs ~65k field queries, not 262k). */
const MASK_RES = 256
const SUBSTEP = 1 / 120
const MAX_SUBSTEPS = 8
/** Impacts injected per substep (more in one substep wait for the next). */
const MAX_IMPACTS = 4
const GRAVITY = 9.81
const DROPLET_COUNT = 28
/** Mean drops per second over the whole lake. */
const DROP_RATE = 0.75
/** Phase speed (`m/s`) of the long ripples, and the capillary stiffness that makes short ones outrun them. */
const WAVE_SPEED = 0.32
const CAPILLARY = 0.0025
const DAMPING = 0.9965
const WATER_IOR = 1.333
/** Absorption `σa` (`1/m`, red / green / blue) of clear mineral water: red dies within metres, blue carries. */
const WATER_ABSORPTION = vec3(0.45, 0.07, 0.03)
/** Scattering `σs` (`1/m`) of the fine suspended calcite. */
const WATER_SCATTERING = 0.25

/** Schlick Fresnel of the air–water interface at `cosTheta`. */
function waterFresnel(cosTheta: Node<'float'>) {
  const f0 = ((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2
  return float(f0).add(float(1 - f0).mul(pow(float(1.0).sub(cosTheta), 5.0)))
}

/** Cosine of the refracted angle under the surface (Snell). */
function refractedCos(cosTheta: Node<'float'>) {
  return sqrt(float(1.0).sub(float(1.0).sub(cosTheta.mul(cosTheta)).div(WATER_IOR * WATER_IOR)))
}

/**
 * Water surface: no albedo. It reflects (the lights' GGX lobes plus a mirror or the cave probes, Fresnel-weighted)
 * and transmits what lies beneath, refracted and absorbed along its path through the water (`beneathWeightNode` ×
 * `beneathNode`), plus the light the turbid column scatters itself (emissive). The mist is applied here, once: the
 * backdrop already carries the fog from the camera to the bed, so only the surface's own terms are fogged.
 */
export class HollowWaterMaterial extends HollowLitMaterial {

  /** `(1 − F) · T_water` per channel. */
  beneathWeightNode: Node<'vec3'> = vec3(0)
  /** The opaque scene behind the surface (a viewport texture, already fogged). */
  beneathNode: Node<'vec3'> = vec3(0)
  private readonly atmosphere: HollowAtmosphere

  constructor(atmosphere: HollowAtmosphere, params: ConstructorParameters<typeof HollowLitMaterial>[0]) {
    super(params)
    this.atmosphere = atmosphere
    this.colorNode = vec3(0)
    this.transparent = true
    this.fog = false
  }

  override setupOutput(builder: NodeBuilder, outputNode: Node<'vec4'>): Node {
    const fog = this.atmosphere.fogAt(positionWorld)
    const surface = outputNode.rgb.mul(fog.a).add(fog.rgb)
    const behind = this.beneathWeightNode.mul(this.beneathNode.sub(fog.rgb).max(0))
    return super.setupOutput(builder, vec4(surface.add(behind), outputNode.a))
  }
}

/** One scheduled drop, from `emitter` at timeline time `spawn` (periodic over the loop). */
export interface HollowDrop {
  emitter: number
  spawn: number
  fall: number
  speed: number
  strength: number
}

/**
 * Builds the seeded, loop-periodic drop schedule: each drop leaves its stalactite tip at `spawn`, falls `fall`
 * seconds under gravity from its initial `speed` and hits the water at `spawn + fall` (both modulo `duration`).
 */
export function scheduleHollowDrops(field: HollowField, emitters: Vector3[], duration: number): HollowDrop[] {
  if (emitters.length === 0) return []
  const rand = createHollowRandom(field.params.seed * 91 + 5)
  const wl = field.params.waterLevel
  const drops: HollowDrop[] = []
  const count = Math.max(1, Math.round(duration * DROP_RATE))
  let t = rand() * 1.5
  for (let i = 0; i < count; i++) {
    const emitter = Math.floor(rand() * emitters.length)
    const speed = 0.2 + rand() * 0.3
    const height = Math.max(0.05, emitters[emitter].y - wl)
    const fall = (-speed + Math.sqrt(speed * speed + 2 * GRAVITY * height)) / GRAVITY
    drops.push({emitter, spawn: t % duration, fall, speed, strength: 0.55 + rand() * 0.45})
    t += (duration / count) * (0.35 + rand() * 1.3)
  }
  return drops
}

/**
 * Meandering mirror lake: planar `reflector` bent by the ripples over refracted, absorbing water, falling stalactite
 * droplets on a seeded loop-periodic schedule, and a `512²` GPU capillary-gravity wave solver
 * (`ḧ = c²∇²h − β∇⁴h`, leapfrog, damped) whose Neumann boundary is the lake's shore, so rings rebound off the banks,
 * the rimstone dam and the boulders.
 */
export class HollowWater {

  readonly lakeReflector: ReturnType<typeof reflector>
  readonly lakeMaterial: HollowWaterMaterial
  readonly rimstoneMaterial: HollowWaterMaterial
  readonly dropletMaterial: HollowWaterMaterial
  readonly dropletMesh: InstancedMesh

  private readonly field: HollowField
  private readonly atmosphere: HollowAtmosphere
  /**
   * The opaque scene behind the water, one copy per render target (the main view, the mirror, the probe cubes):
   * `viewportSharedTexture` would resize one texture between those passes and destroy it while still in use.
   */
  private readonly backdrop = viewportTexture()
  private readonly heightA = instancedArray(WAVE_RES * WAVE_RES, 'float')
  private readonly heightB = instancedArray(WAVE_RES * WAVE_RES, 'float')
  private readonly laplacian = instancedArray(WAVE_RES * WAVE_RES, 'float')
  private readonly maskData = new Float32Array(WAVE_RES * WAVE_RES)
  private readonly mask = instancedArray(this.maskData, 'float')
  private readonly heightTexture: StorageTexture
  private readonly impacts = uniformArray(Array.from({length: MAX_IMPACTS}, () => new Vector4()), 'vec4')
  /** World `xz` of the grid's corner and its side length (`m`). */
  private readonly waveOrigin = uniform(new Vector2(-10, -12))
  private readonly waveSize = uniform(16)
  private readonly kernels: {
    clear: ComputeNode
    inject: [ComputeNode, ComputeNode]
    laplace: [ComputeNode, ComputeNode]
    advance: [ComputeNode, ComputeNode]
    pack: [ComputeNode, ComputeNode]
  }

  private emitters: Vector3[] = []
  private drops: HollowDrop[] = []
  private pendingImpacts: Vector4[] = []
  /** 0: A holds the current heights, B the previous. 1: swapped. */
  private phase: 0 | 1 = 0
  private needsClear = true
  private readonly _m = new Matrix4()
  private readonly _p = new Vector3()

  constructor(field: HollowField, atmosphere: HollowAtmosphere) {
    this.field = field
    this.atmosphere = atmosphere

    // `bounces: false` — only the lake material may sample this RT. Any other material reading it during the
    // mirror pass hits WebGPU TextureBinding|RenderAttachment validation and drops the frame (black scene).
    this.lakeReflector = reflector({resolutionScale: 0.75, bounces: false})
    this.lakeReflector.target.name = 'Lake Reflector'
    // ReflectorNode treats target local +Z as the mirror normal; lake mesh is Y-up (unrotated).
    this.lakeReflector.target.rotateX(-Math.PI / 2)
    this.lakeReflector.target.userData.selectable = false

    this.heightTexture = new StorageTexture(WAVE_RES, WAVE_RES)
    this.heightTexture.type = HalfFloatType
    this.heightTexture.minFilter = LinearFilter
    this.heightTexture.magFilter = LinearFilter
    this.heightTexture.generateMipmaps = false
    this.heightTexture.name = 'Hollow Ripple Height'

    this.kernels = this.createKernels()
    this.lakeMaterial = this.createLakeMaterial()
    this.rimstoneMaterial = this.createPoolMaterial()
    this.dropletMaterial = this.createDropletMaterial()
    this.dropletMesh = this.createDropletMesh()
  }

  /** Re-seeds the drop schedule, rebuilds the shore mask over the lake's extent and stills the water. */
  syncToField(dripEmitters: Vector3[], duration: number) {
    this.emitters = dripEmitters
    this.drops = scheduleHollowDrops(this.field, dripEmitters, duration)
    this.pendingImpacts = []

    const extent = this.field.lakeExtent
    const size = Math.max(extent.maxX - extent.minX, extent.maxZ - extent.minZ)
    const cx = 0.5 * (extent.minX + extent.maxX)
    const cz = 0.5 * (extent.minZ + extent.maxZ)
    this.waveOrigin.value.set(cx - size * 0.5, cz - size * 0.5)
    this.waveSize.value = size

    const coarse = new Uint8Array(MASK_RES * MASK_RES)
    for (let y = 0; y < MASK_RES; y++) {
      for (let x = 0; x < MASK_RES; x++) {
        const wx = this.waveOrigin.value.x + (x + 0.5) / MASK_RES * size
        const wz = this.waveOrigin.value.y + (y + 0.5) / MASK_RES * size
        coarse[y * MASK_RES + x] = this.field.lakeDepthAt(wx, wz) > 0.02 ? 1 : 0
      }
    }
    const up = WAVE_RES / MASK_RES
    for (let y = 0; y < WAVE_RES; y++) {
      for (let x = 0; x < WAVE_RES; x++) {
        const edge = x === 0 || y === 0 || x === WAVE_RES - 1 || y === WAVE_RES - 1
        this.maskData[y * WAVE_RES + x] = !edge && coarse[Math.floor(y / up) * MASK_RES + Math.floor(x / up)] ? 1 : 0
      }
    }
    this.mask.value.needsUpdate = true
    this.needsClear = true

    this.lakeReflector.target.position.set(this.field.spineX(this.field.lakeCenterZ), this.field.params.waterLevel, this.field.lakeCenterZ)
  }

  private createKernels() {
    const N = WAVE_RES
    const cellXY = () => {
      const x: Node<'int'> = int(instanceIndex.mod(N))
      const y: Node<'int'> = int(instanceIndex.div(N))
      return {x, y}
    }
    const index = (x: Node<'int'>, y: Node<'int'>) => y.mul(N).add(x)

    const clear = Fn(() => {
      this.heightA.element(instanceIndex).assign(0)
      this.heightB.element(instanceIndex).assign(0)
      this.laplacian.element(instanceIndex).assign(0)
    })().compute(N * N)

    // Neumann 5-point Laplacian: a dry neighbor mirrors the center, so the shore reflects instead of absorbing
    const laplace = (src: typeof this.heightA) => Fn(() => {
      const {x, y} = cellXY()
      const i = index(x, y)
      const out = this.laplacian.element(instanceIndex)
      If(this.mask.element(i).lessThan(0.5), () => {
        out.assign(0)
      }).Else(() => {
        const c = src.element(i)
        const tap = (dx: number, dy: number) => {
          const j = index(x.add(dx), y.add(dy))
          return mix(c, src.element(j), this.mask.element(j))
        }
        out.assign(tap(1, 0).add(tap(-1, 0)).add(tap(0, 1)).add(tap(0, -1)).sub(c.mul(4)))
      })
    })().compute(N * N)

    // Leapfrog: `next = cur + damping·(cur − prev) + C²·L − B·∇²L`, written over `prev` (each cell reads only its own)
    const advance = (cur: typeof this.heightA, prev: typeof this.heightA) => Fn(() => {
      const {x, y} = cellXY()
      const i = index(x, y)
      const dx = this.waveSize.div(N)
      const c2 = float(WAVE_SPEED * SUBSTEP).div(dx).pow(2)
      const b = float(CAPILLARY * SUBSTEP).div(dx.mul(dx)).pow(2).min(0.02)
      const L = this.laplacian.element(i)
      const tap = (ox: number, oy: number) => {
        const j = index(x.add(ox), y.add(oy))
        return mix(L, this.laplacian.element(j), this.mask.element(j))
      }
      const biharmonic = tap(1, 0).add(tap(-1, 0)).add(tap(0, 1)).add(tap(0, -1)).sub(L.mul(4))
      const h = cur.element(i)
      const next = h.add(h.sub(prev.element(i)).mul(DAMPING)).add(L.mul(c2.min(0.4))).sub(biharmonic.mul(b))
      prev.element(i).assign(next.mul(this.mask.element(i)))
    })().compute(N * N)

    // Drop impacts: a small Gaussian crater in the current heights (the solver turns it into rings)
    const inject = (cur: typeof this.heightA) => Fn(() => {
      const {x, y} = cellXY()
      const i = index(x, y)
      const world = this.waveOrigin.add(vec2(x, y).add(0.5).div(N).mul(this.waveSize))
      const h = cur.element(i)
      Loop(MAX_IMPACTS, ({i: k}) => {
        const impact = this.impacts.element(k) as unknown as Node<'vec4'>
        const r2 = world.sub(impact.xy).dot(world.sub(impact.xy))
        h.subAssign(impact.z.mul(exp(r2.div(impact.w.mul(impact.w)).negate())))
      })
      h.mulAssign(this.mask.element(i))
    })().compute(N * N)

    const pack = (cur: typeof this.heightA) => Fn(() => {
      const {x, y} = cellXY()
      textureStore(this.heightTexture, ivec2(x, y), vec4(cur.element(index(x, y)), 0, 0, 1))
    })().compute(N * N)

    return {
      clear,
      inject: [inject(this.heightA), inject(this.heightB)] as [ComputeNode, ComputeNode],
      laplace: [laplace(this.heightA), laplace(this.heightB)] as [ComputeNode, ComputeNode],
      advance: [advance(this.heightA, this.heightB), advance(this.heightB, this.heightA)] as [ComputeNode, ComputeNode],
      pack: [pack(this.heightA), pack(this.heightB)] as [ComputeNode, ComputeNode],
    }
  }

  /** Surface height (`m`) at the fragment's world `xz`, and its slope from the packed ripple texture. */
  private rippleNormal() {
    const uv = positionWorld.xz.sub(this.waveOrigin).div(this.waveSize)
    const texel = float(1 / WAVE_RES)
    const map = texture(this.heightTexture)
    const hC = map.sample(uv).r
    const hX = map.sample(uv.add(vec2(texel, 0))).r
    const hZ = map.sample(uv.add(vec2(0, texel))).r
    const dx = this.waveSize.div(WAVE_RES)
    return normalize(vec3(hC.sub(hX).div(dx), float(1.0), hC.sub(hZ).div(dx)))
  }

  /**
   * The surface of still water over a bed `depth` metres down (vertical), seen at `cosView`: Beer–Lambert
   * transmittance down to the bed and back (the light reaching the bed crossed the water too), and the radiance the
   * column scatters toward the eye from the ambient light around it.
   */
  private waterColumn(material: HollowWaterMaterial, depth: Node<'float'>, cosView: Node<'float'>, fresnel: Node<'float'>) {
    const viewPath = depth.div(refractedCos(cosView).max(0.05))
    const transmittance = exp(WATER_ABSORPTION.mul(viewPath.add(depth)).negate())
    const extinction = WATER_ABSORPTION.add(WATER_SCATTERING)
    const columnOpacity = float(1.0).sub(exp(extinction.mul(viewPath).negate()))
    const scatter = this.atmosphere.ambientAt(positionWorld).mul(vec3(WATER_SCATTERING).div(extinction)).mul(columnOpacity)
    const transmitted = float(1.0).sub(fresnel)
    material.beneathWeightNode = transmittance.mul(transmitted)
    return scatter.mul(transmitted)
  }

  private createLakeMaterial() {
    const material = new HollowWaterMaterial(this.atmosphere, {roughness: 0.025, metalness: 0.0, ior: WATER_IOR})
    material.name = 'Hollow Lake'

    const waveN = this.rippleNormal()
    material.normalNode = transformNormalToView(waveN)
    this.lakeReflector.uvNode = this.lakeReflector.uvNode!.add(waveN.xz.mul(0.35))

    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const cosView = saturate(dot(waveN, viewDir))
    const fresnel = waterFresnel(cosView)
    const depth = attribute('aWaterDepth', 'float').max(0.0)
    const scatter = this.waterColumn(material, depth, cosView, fresnel)
    // Screen-space refraction: the bed shifts with the ripple slope, more through deeper water
    material.beneathNode = this.backdrop.sample(screenUV.add(waveN.xz.mul(depth.min(0.8).mul(0.06)))).rgb
    // The mirror image is light leaving the surface, not albedo: emit it, weighted by Fresnel
    material.emissiveNode = this.lakeReflector.rgb.mul(fresnel).add(scatter)
    return material
  }

  /**
   * The rimstone pool: shallow water over the travertine dam, reflecting the cave probes (only the lake may sample
   * the mirror, see the constructor).
   */
  private createPoolMaterial() {
    const material = new HollowWaterMaterial(this.atmosphere, {roughness: 0.03, metalness: 0.0, ior: WATER_IOR})
    material.name = 'Hollow Rimstone Pool'
    const cosView = saturate(dot(normalView, positionViewDirection))
    const fresnel = waterFresnel(cosView)
    const depth = attribute('aWaterDepth', 'float').max(0.0)
    material.emissiveNode = this.waterColumn(material, depth, cosView, fresnel)
    material.beneathNode = this.backdrop.sample(screenUV).rgb
    return material
  }

  /** Falling drops: clear water a few millimetres across, refracting what is behind them and catching glints. */
  private createDropletMaterial() {
    const material = new HollowWaterMaterial(this.atmosphere, {roughness: 0.02, metalness: 0.0, ior: WATER_IOR})
    material.name = 'Hollow Droplet'
    material.positionNode = positionLocal.mul(vec3(0.55, 1.4, 0.55))
    const cosView = saturate(dot(normalView, positionViewDirection))
    material.beneathWeightNode = vec3(float(1.0).sub(waterFresnel(cosView)))
    // A drop is a tiny inverted lens: the background shows through, displaced toward its rim
    material.beneathNode = this.backdrop.sample(screenUV.sub(normalView.xy.mul(0.012))).rgb
    return material
  }

  private createDropletMesh() {
    const geo = new SphereGeometry(1, 8, 6)
    const mesh = new InstancedMesh(geo, this.dropletMaterial, DROPLET_COUNT)
    mesh.name = 'Falling Droplets'
    mesh.userData.selectable = false
    mesh.frustumCulled = false
    mesh.count = 0
    return mesh
  }

  /**
   * Places the falling droplets for timeline `time` (a pure function of time) and queues the impacts that happened
   * in the `delta` just played. Scrubbing back or a large jump queues nothing.
   */
  animate(delta: number, time: number, duration: number) {
    const wl = this.field.params.waterLevel
    let live = 0
    for (const drop of this.drops) {
      const tip = this.emitters[drop.emitter]
      if (!tip) continue
      const age = ((time - drop.spawn) % duration + duration) % duration
      if (delta > 0 && delta < 0.5) {
        const before = age - delta
        if (before < drop.fall && age >= drop.fall) this.queueImpact(tip, drop.strength)
      }
      if (age >= drop.fall || live >= DROPLET_COUNT) continue
      const vy = drop.speed + GRAVITY * age
      const y = tip.y - 0.02 - drop.speed * age - 0.5 * GRAVITY * age * age
      if (y <= wl) continue
      const s = 0.016 + Math.min(0.035, vy * 0.0035)
      this._p.set(tip.x, y, tip.z)
      this.dropletMesh.setMatrixAt(live, this._m.makeScale(s, s * 1.35, s).setPosition(this._p))
      live++
    }
    this.dropletMesh.count = live
    this.dropletMesh.instanceMatrix.needsUpdate = true
  }

  private queueImpact(tip: Vector3, strength: number) {
    if (this.field.lakeDepthAt(tip.x, tip.z) < 0.03) return
    // Crater depth (`m`) and radius (`m`)
    this.pendingImpacts.push(new Vector4(tip.x, tip.z, 0.006 * strength, 0.035 + 0.02 * strength))
  }

  /** Steps the solver by `delta` seconds of played timeline in fixed substeps, injecting queued impacts. */
  step(renderer: WebGPURenderer, delta: number) {
    if (this.needsClear) {
      void renderer.compute(this.kernels.clear)
      this.phase = 0
      this.needsClear = false
    }
    const substeps = Math.min(MAX_SUBSTEPS, Math.round(Math.max(0, delta) / SUBSTEP))
    for (let s = 0; s < substeps; s++) {
      if (this.pendingImpacts.length > 0) {
        const batch = this.pendingImpacts.splice(0, MAX_IMPACTS)
        const slots = this.impacts.array as Vector4[]
        for (let k = 0; k < MAX_IMPACTS; k++) slots[k].copy(batch[k] ?? new Vector4(0, 0, 0, 1))
        void renderer.compute(this.kernels.inject[this.phase])
      }
      void renderer.compute(this.kernels.laplace[this.phase])
      void renderer.compute(this.kernels.advance[this.phase])
      this.phase = this.phase === 0 ? 1 : 0
    }
    if (substeps > 0 || delta === 0) void renderer.compute(this.kernels.pack[this.phase])
  }

  dispose() {
    this.lakeReflector.dispose()
    this.lakeMaterial.dispose()
    this.rimstoneMaterial.dispose()
    this.dropletMesh.geometry.dispose()
    this.dropletMaterial.dispose()
    this.heightTexture.dispose()
    for (const node of [this.heightA, this.heightB, this.laplacian, this.mask]) node.value.dispose?.()
  }
}
