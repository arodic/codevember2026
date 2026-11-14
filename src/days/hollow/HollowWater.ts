import {
  BufferGeometry, ComputeNode, DoubleSide, HalfFloatType, InstancedMesh, LinearFilter, Matrix4, Mesh, Node, NodeBuilder,
  NodeMaterial, OrthographicCamera, RenderTarget, RendererUtils, Scene, SphereGeometry, StorageTexture, Vector2, Vector3,
  Vector4, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, attribute, cameraPosition, dot, exp, float, floor, fwidth, instanceIndex, instancedArray, int, ivec2,
  mix, normalView, normalize, positionLocal, positionView, positionViewDirection, positionWorld, pow, reflector, saturate,
  screenUV, select, sqrt, texture, textureLoad, textureStore, transformNormalToView, uniformArray, uniform, vec2, vec3,
  vec4, viewportTexture,
} from 'three/tsl'
import {HollowField, createHollowRandom} from './HollowField.js'
import {HollowLitMaterial} from './HollowMaterial.js'
import type {HollowAtmosphere} from './HollowAtmosphere.js'

/** Ripple grid resolution (cells per side) of the GPU wave solver: about 2 cm cells over the lake. */
export const WAVE_RES = 1024
const SUBSTEP = 1 / 120
const MAX_SUBSTEPS = 8
/** Impacts injected per substep (more in one substep wait for the next). */
const MAX_IMPACTS = 4
const GRAVITY = 9.81
/** Drops in flight at once, at most. */
const DROPLET_COUNT = 8
/** Mean drops per second over the whole lake. */
const DROP_RATE = 0.19
/** Phase speed (`m/s`) of the long ripples, and the capillary stiffness that makes short ones outrun them. */
const WAVE_SPEED = 0.32
const CAPILLARY = 0.0025
/** Velocity kept per substep (`~0.89` a second): rings reach the shores and come back before they die out. */
const DAMPING = 0.999
const WATER_IOR = 1.333
/** Absorption `σa` (`1/m`, red / green / blue) of clear mineral water: red dies within metres, blue carries. */
const WATER_ABSORPTION = vec3(0.45, 0.07, 0.03)
/** Scattering `σs` (`1/m`) of the fine suspended calcite. */
const WATER_SCATTERING = 0.25
/** How deep (`m`) the bed map sees under the water. */
const BED_REACH = 8
/** Water shallower than this (`m`) carries no ripples: the solver's shore. */
const BED_MIN_DEPTH = 0.01
/** Pixels over which the lake fades into the rock it meets. */
const SHORE_PIXELS = 2
/**
 * Mirror depth × view depth (about the height, in metres, of the reflected point over the water) up to which the
 * shore fade applies: above it a reflection's edge is another object's, not the shore's.
 */
const SHORE_REACH = 0.08
/** The mirror's cleared depth: nothing reflected there. */
const MIRROR_EMPTY = 0.99999
const BILINEAR_TAPS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const

type RendererState = ReturnType<typeof RendererUtils.resetRendererState>

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
  /** How much of the water shows (`1`), or only `beneathNode` (`0`): fades the water's edge into the rock. */
  shoreNode: Node<'float'> = float(1)
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
    const water = mix(this.beneathNode, surface.add(behind), this.shoreNode)
    return super.setupOutput(builder, vec4(water, outputNode.a))
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
 * droplets on a seeded loop-periodic schedule, and a `1024²` GPU capillary-gravity wave solver
 * (`ḧ = c²∇²h − β∇⁴h`, leapfrog, damped) whose Neumann boundary is the lake's shore, so rings rebound off the banks,
 * the rimstone dam and the boulders. The shore and the water's depth come from the cave itself: its bed seen from the
 * water's plane (`bed`), drawn once per cave.
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
  /** `1` over water, `0` over rock and on the grid's border (from `bed`). */
  private readonly mask = instancedArray(WAVE_RES * WAVE_RES, 'float')
  private readonly heightTexture: StorageTexture
  /**
   * The cave under the water's plane, over the grid: the depth (`m`) of the first surface below the plane where it
   * faces up (water over a bed) and its normal's `y`; `0, ≤ 0` where the plane is inside the rock.
   */
  private readonly bed: RenderTarget
  private readonly bedScene = new Scene()
  private readonly bedCamera = new OrthographicCamera()
  private readonly bedMesh: Mesh<BufferGeometry, NodeMaterial>
  private bedState: RendererState | undefined = undefined
  private bedStale = false
  private readonly waterLevel = uniform(0)
  private readonly impacts = uniformArray(Array.from({length: MAX_IMPACTS}, () => new Vector4()), 'vec4')
  /** World `xz` of the grid's corner and its side length (`m`). */
  private readonly waveOrigin = uniform(new Vector2(-10, -12))
  private readonly waveSize = uniform(16)
  private readonly kernels: {
    clear: ComputeNode
    mask: ComputeNode
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
    // Its depth marks what the mirror holds, and how far the reflected point is above the water (`shoreFade`)
    this.lakeReflector = reflector({resolutionScale: 0.75, bounces: false, depth: true})
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

    this.bed = new RenderTarget(WAVE_RES, WAVE_RES, {
      type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter,
    })
    this.bed.texture.name = 'Hollow Lake Bed'
    this.bedMesh = new Mesh(new BufferGeometry(), this.createBedMaterial())
    this.bedMesh.frustumCulled = false
    this.bedMesh.matrixAutoUpdate = false
    this.bedScene.add(this.bedMesh)

    this.kernels = this.createKernels()
    this.lakeMaterial = this.createLakeMaterial()
    this.rimstoneMaterial = this.createPoolMaterial()
    this.dropletMaterial = this.createDropletMaterial()
    this.dropletMesh = this.createDropletMesh()
  }

  /**
   * Re-seeds the drop schedule, fits the grid to the lake's extent, redraws the bed of `cave` (the cave's surface) on
   * the next step and stills the water.
   */
  syncToField(cave: BufferGeometry, dripEmitters: Vector3[], duration: number) {
    this.emitters = dripEmitters
    this.drops = scheduleHollowDrops(this.field, dripEmitters, duration)
    this.pendingImpacts = []

    const extent = this.field.lakeExtent
    const size = Math.max(extent.maxX - extent.minX, extent.maxZ - extent.minZ)
    const cx = 0.5 * (extent.minX + extent.maxX)
    const cz = 0.5 * (extent.minZ + extent.maxZ)
    this.waveOrigin.value.set(cx - size * 0.5, cz - size * 0.5)
    this.waveSize.value = size
    this.waterLevel.value = this.field.params.waterLevel
    // (The mesh shares the cave's buffers, which the cave disposes)
    this.bedMesh.geometry = cave
    this.bedStale = true
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

    // The solver's shore: water over a bed at least `BED_MIN_DEPTH` deep, and never the grid's border
    const mask = Fn(() => {
      const {x, y} = cellXY()
      const bed = textureLoad(this.bed.texture, ivec2(x, y))
      const border = x.equal(0).or(y.equal(0)).or(x.equal(N - 1)).or(y.equal(N - 1))
      const wet = bed.g.greaterThan(0).and(bed.r.greaterThan(BED_MIN_DEPTH)).and(border.not())
      this.mask.element(instanceIndex).assign(select(wet, float(1), float(0)))
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
      mask,
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

  /**
   * Draws the cave's bed into `bed`, seen from the water's plane straight down over the grid (only what lies under the
   * plane: its depth is the depth range), and the solver's shore from it.
   */
  private createBedMaterial() {
    const material = new NodeMaterial()
    material.name = 'Hollow Lake Bed'
    // Both sides: under the rock the first surface below the plane faces down. (Not front side only: the meshlet
    // pipeline leaves it to the regular one)
    material.side = DoubleSide
    const grid = positionWorld.xz.sub(this.waveOrigin).div(this.waveSize)
    const below = this.waterLevel.sub(positionWorld.y)
    material.vertexNode = vec4(grid.mul(2).sub(1).mul(vec2(1, -1)), below.div(BED_REACH), 1)
    const up = attribute('normal', 'vec3').y
    material.fragmentNode = vec4(select(up.greaterThan(0), below, float(0)), up, 0, 1)
    return material
  }

  private drawBed(renderer: WebGPURenderer) {
    const state = this.bedState = RendererUtils.resetRendererState(renderer, this.bedState as RendererState)
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.bed)
    renderer.clear()
    renderer.render(this.bedScene, this.bedCamera)
    RendererUtils.restoreRendererState(renderer, state)
    void renderer.compute(this.kernels.mask)
  }

  /** Depth (`m`) of the water at the fragment, to the cave's surface under it (boulders and dripstones too). */
  private bedDepth() {
    return texture(this.bed.texture, positionWorld.xz.sub(this.waveOrigin).div(this.waveSize)).r
  }

  /**
   * A bilinear fetch from the mirror at `uv`, over only the texels it reflected something into (its depth isn't
   * cleared): `rgb` the mean of those, `a` their weight. At the shore the mirror holds nothing past the waterline (its
   * clip plane removed the rock below the water, and the rock above is seen from inside, culled).
   */
  private mirrorTaps(uv: Node<'vec2'>, sample: (texel: Node<'ivec2'>, depth: Node<'float'>) => Node<'vec3'>) {
    const depthMap = this.lakeReflector.getDepthNode()
    const size = vec2(depthMap.size(int(0)) as Node<'ivec2'>)
    const p = uv.mul(size).sub(0.5)
    const base = floor(p)
    const f = p.sub(base)
    let sum: Node<'vec3'> = vec3(0)
    let weight: Node<'float'> = float(0)
    for (const [ox, oy] of BILINEAR_TAPS) {
      const texel = ivec2(base.add(vec2(ox, oy)).clamp(vec2(0), size.sub(1)))
      const depth = depthMap.load(texel).x
      const w = (ox ? f.x : f.x.oneMinus()).mul(oy ? f.y : f.y.oneMinus())
      const covered = select(depth.lessThan(MIRROR_EMPTY), w, float(0))
      sum = sum.add(sample(texel, depth).mul(covered))
      weight = weight.add(covered)
    }
    return vec4(sum.div(weight.max(1e-4)), weight)
  }

  /**
   * How much of the water shows, from `0` where it meets the rock to `1` over `SHORE_PIXELS`: the mirror's depth
   * there grows from `0` with the height above the water of the point it reflects (`depth ∝ height / distance` under its
   * oblique clip plane), and at the waterline that point is the waterline. The ratio to its screen gradient is pixels.
   */
  private shoreFade() {
    const height = this.mirrorTaps(screenUV.flipX(), (_texel, depth) => vec3(depth)).x.mul(positionView.z.negate())
    const fade = saturate(height.div(fwidth(height).mul(SHORE_PIXELS).max(1e-6)))
    return select(height.greaterThan(SHORE_REACH), float(1), fade)
  }

  private createLakeMaterial() {
    const material = new HollowWaterMaterial(this.atmosphere, {roughness: 0.025, metalness: 0.0, ior: WATER_IOR})
    material.name = 'Hollow Lake'

    const waveN = this.rippleNormal()
    material.normalNode = transformNormalToView(waveN)
    const shore = this.shoreFade()
    material.shoreNode = shore

    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const cosView = saturate(dot(waveN, viewDir))
    const fresnel = waterFresnel(cosView)
    const depth = this.bedDepth()
    const scatter = this.waterColumn(material, depth, cosView, fresnel)
    // Screen-space refraction: the bed shifts with the ripple slope, more through deeper water, none at the waterline
    material.beneathNode = this.backdrop.sample(screenUV.add(waveN.xz.mul(depth.min(0.8).mul(0.06)).mul(shore))).rgb
    // The mirror image bent by the ripples. Where the bend reaches past the waterline the mirror holds nothing: the
    // rock there, through the water, stands in for it
    const mirror = this.mirrorTaps(screenUV.flipX().add(waveN.xz.mul(0.35)), texel => this.lakeReflector.load(texel).rgb)
    const reflected = mix(material.beneathNode, mirror.rgb, saturate(mirror.a.mul(4)))
    // The mirror image is light leaving the surface, not albedo: emit it, weighted by Fresnel
    material.emissiveNode = reflected.mul(fresnel).add(scatter)
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
      const s = 0.004 + Math.min(0.009, vy * 0.0009)
      this._p.set(tip.x, y, tip.z)
      this.dropletMesh.setMatrixAt(live, this._m.makeScale(s, s * 1.35, s).setPosition(this._p))
      live++
    }
    this.dropletMesh.count = live
    this.dropletMesh.instanceMatrix.needsUpdate = true
  }

  private queueImpact(tip: Vector3, strength: number) {
    if (this.field.lakeDepthAt(tip.x, tip.z) < 0.03) return
    // Crater depth (`m`) and radius (`m`): a drop a few millimetres across, a ring or two of grid cells
    this.pendingImpacts.push(new Vector4(tip.x, tip.z, 0.006 * strength, 0.025 + 0.015 * strength))
  }

  /** Steps the solver by `delta` seconds of played timeline in fixed substeps, injecting queued impacts. */
  step(renderer: WebGPURenderer, delta: number) {
    if (this.bedStale) {
      this.bedStale = false
      this.drawBed(renderer)
    }
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
    this.bed.dispose()
    this.bedMesh.material.dispose()
    for (const node of [this.heightA, this.heightB, this.laplacian, this.mask]) node.value.dispose?.()
  }
}
