import {
  ComputeNode, Data3DTexture, DirectionalLight, HalfFloatType, LinearFilter, Node, PointLight, RGBAFormat, RedFormat,
  RepeatWrapping, Scene, Storage3DTexture, TextureNode, UniformNode, Color, UnsignedByteType, Vector3, WebGPURenderer,
  ClampToEdgeWrapping, Matrix4, Vector4,
} from 'three/webgpu'
import {
  Fn, If, Loop, abs, cameraPosition, cos, cubeTexture, dot, exp, float, instanceIndex, interleavedGradientNoise,
  inverseSqrt, length, max, normalize, output, positionWorld, screenCoordinate, select, sin, sqrt, texture, texture3D,
  textureStore, uint, uniform, uvec3, vec2, vec3, vec4, viewZToPerspectiveDepth,
} from 'three/tsl'
import type {VXGIVolume} from 'three/addons/lighting/vxgi/VXGIVolume.js'
import {createConeTracer} from 'three/addons/lighting/vxgi/VXGIConeTracer.js'
import {HOLLOW_MAX, HOLLOW_MIN, HollowField} from './HollowField.js'
import type {HollowLightSource, HollowLightUniforms} from './HollowLighting.js'

/** Visibility voxel (`m`): resolves the sun shaft's edge. */
const VISIBILITY_VOXEL = 0.25
/** Ambient voxel (`m`): indirect light is smooth. */
const AMBIENT_VOXEL = 0.5
const STEPS = 24
const MAX_DISTANCE = 60
/** Henyey–Greenstein asymmetry of the mist (water droplets scatter forward). */
const PHASE_G = 0.6
/** Single-scattering albedo `σs / σt` of the mist. */
const MIST_ALBEDO = 0.92
/** Cones per ambient voxel, spread over the sphere. */
const AMBIENT_CONES = 16
const NOISE_SIZE = 32

function gridSize(voxel: number): [number, number, number] {
  const size = new Vector3().subVectors(HOLLOW_MAX, HOLLOW_MIN)
  return [Math.ceil(size.x / voxel), Math.ceil(size.y / voxel), Math.ceil(size.z / voxel)]
}

function createVolumeTexture(name: string, [x, y, z]: [number, number, number]) {
  const tex = new Storage3DTexture(x, y, z)
  tex.name = name
  tex.type = HalfFloatType
  tex.format = RGBAFormat
  tex.generateMipmaps = false
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping
  return tex
}

/** Periodic value noise lattice (trilinear filtering + repeat wrap make it seamless). */
function createNoiseTexture() {
  const data = new Uint8Array(NOISE_SIZE ** 3)
  let s = 0x9e3779b9
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    data[i] = (s >>> 0) & 255
  }
  const tex = new Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE)
  tex.format = RedFormat
  tex.type = UnsignedByteType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  tex.name = 'Hollow Mist Noise'
  return tex
}

/** A color uniform as the `vec3` it is in the shader (@types/three keeps `color` apart). */
function rgb(node: UniformNode<'color', Color>): Node<'vec3'> {
  return node as unknown as Node<'vec3'>
}

/** Henyey–Greenstein phase function (`sr⁻¹`). */
function phaseHG(cosTheta: Node<'float'>) {
  const g = PHASE_G
  const denom = float(1 + g * g).sub(cosTheta.mul(2 * g)).max(1e-4)
  return float((1 - g * g) / (4 * Math.PI)).div(denom.mul(sqrt(denom)))
}

/**
 * Cave mist as a participating medium (single scattering, Beer–Lambert extinction), applied to every surface through
 * `scene.fogNode`: each fragment marches the view ray from the camera to itself. Nothing glows on its own; the
 * in-scattered light is
 * - the shadowed sun and fire (their visibility baked from the renderer's shadow maps into a voxel grid),
 *   through a Henyey–Greenstein phase;
 * - the cave's indirect light and the sky portal: the mean radiance around each voxel, cone-traced through the VXGI
 *   volume once per light source at unit intensity and rescaled live (light is linear).
 */
export class HollowAtmosphere {

  /** Scattering coefficient `σs` (`1/m`) of the mist at the water. */
  readonly density = uniform(0.03)
  /** Loop phase (`0..2π`): the mist drifts on a closed path, so the timeline loops seamlessly. */
  readonly phase = uniform(0)

  private readonly lights: HollowLightUniforms
  private readonly waterLevel: UniformNode<'float', number>
  private readonly boundsMin = uniform(HOLLOW_MIN.clone())
  private readonly boundsSize = uniform(new Vector3().subVectors(HOLLOW_MAX, HOLLOW_MIN))
  private readonly visibilitySize = gridSize(VISIBILITY_VOXEL)
  private readonly ambientSize = gridSize(AMBIENT_VOXEL)
  /** `r`: sun visibility, `g`: fire visibility. */
  private readonly visibility = createVolumeTexture('Hollow Mist Visibility', this.visibilitySize)
  private readonly ambientSources: Record<HollowLightSource, Storage3DTexture> = {
    sun: createVolumeTexture('Hollow Mist Ambient Sun', this.ambientSize),
    fire: createVolumeTexture('Hollow Mist Ambient Fire', this.ambientSize),
    sky: createVolumeTexture('Hollow Mist Ambient Sky', this.ambientSize),
  }
  /** Mean radiance of the indirect light at the current levels (`Σ source × level`, recombined every frame). */
  private readonly ambient = createVolumeTexture('Hollow Mist Ambient', this.ambientSize)
  private readonly noise = createNoiseTexture()
  /** `1` in the cave's air, `0` in the rock (the cutaway camera looks through the rock). */
  private readonly airMask: Data3DTexture

  private readonly sunShadowMatrix = uniform(new Matrix4())
  /** Shadow bias, near, far of the sun and the fire, and the fire's shadow origin. */
  private readonly sunShadowParams = uniform(new Vector4())
  private readonly fireShadowParams = uniform(new Vector4())
  private readonly fireShadowOrigin = uniform(new Vector3())

  /** The sun's and the fire's shadow maps, known after the first bake (`texture()` / `cubeTexture()` inputs). */
  private shadowMaps: {sun: Parameters<typeof texture>[0]; fire: Parameters<typeof cubeTexture>[0]} | null = null
  private visibilityKernel: ComputeNode | null = null
  private visibilityKey = ''
  private ambientKernels: Partial<Record<HollowLightSource, ComputeNode>> = {}
  private readonly combineKernel: ComputeNode
  private readonly clearKernels: ComputeNode[]

  constructor(lights: HollowLightUniforms, waterLevel: UniformNode<'float', number>) {
    this.lights = lights
    this.waterLevel = waterLevel
    const [x, y, z] = this.ambientSize
    this.airMask = new Data3DTexture(new Uint8Array(x * y * z), x, y, z)
    this.airMask.format = RedFormat
    this.airMask.type = UnsignedByteType
    this.airMask.minFilter = LinearFilter
    this.airMask.magFilter = LinearFilter
    this.airMask.wrapS = this.airMask.wrapT = this.airMask.wrapR = ClampToEdgeWrapping
    this.airMask.unpackAlignment = 1
    this.airMask.name = 'Hollow Mist Air'
    // All rock until `syncToField` (the cave is meshed on workers: the mist renders before it arrives)
    this.airMask.needsUpdate = true
    this.combineKernel = this.createCombineKernel()
    this.clearKernels = [this.visibility, this.ambientSources.sun, this.ambientSources.fire, this.ambientSources.sky]
      .map((tex) => this.createClearKernel(tex))
  }

  /** Rebuilds the air mask from the seeded cavern (~0.1 s). */
  syncToField(field: HollowField) {
    const [nx, ny, nz] = this.ambientSize
    const data = this.airMask.image.data as Uint8Array
    let i = 0
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let n = 0; n < nx; n++) {
          const air = field.sample(
            HOLLOW_MIN.x + (n + 0.5) * AMBIENT_VOXEL,
            HOLLOW_MIN.y + (j + 0.5) * AMBIENT_VOXEL,
            HOLLOW_MIN.z + (k + 0.5) * AMBIENT_VOXEL,
          ) > 0
          data[i++] = air ? 255 : 0
        }
      }
    }
    this.airMask.needsUpdate = true
  }

  /** Fogs every fogged material: `color · T + L`, marched from the camera to the fragment. */
  applyFog(scene: Scene) {
    scene.fogNode = Fn(() => {
      const fog = this.fogAt(positionWorld)
      return vec4(output.rgb.mul(fog.a).add(fog.rgb), output.a)
    })()
  }

  /** `vec4(in-scattered radiance, transmittance)` along the view ray from the camera to `surface`. */
  fogAt(surface: Node<'vec3'>): Node<'vec4'> {
    return Fn(() => {
      const origin = cameraPosition
      const toSurface = surface.sub(origin).toConst()
      const distance = length(toSurface).min(MAX_DISTANCE).toConst()
      const dir = normalize(toSurface).toConst()
      const ds = distance.div(STEPS).toConst()
      const jitter = interleavedGradientNoise(screenCoordinate.xy).toConst()
      const sunPhase = phaseHG(dot(dir, this.lights.sunDirection)).toConst()

      const radiance = vec3(0).toVar()
      const transmittance = float(1).toVar()
      Loop(STEPS, ({i}) => {
        const p = origin.add(dir.mul(float(i).add(jitter).mul(ds))).toConst()
        const uvw = p.sub(this.boundsMin).div(this.boundsSize).toConst()
        const sigma = this.densityAt(p).toConst()
        const visible = texture3D(this.visibility, uvw, float(0)).toConst()
        const toFire = this.lights.firePosition.sub(p).toConst()
        const fireDistance2 = dot(toFire, toFire).max(0.04).toConst()
        const firePhase = phaseHG(dot(toFire, dir).mul(inverseSqrt(fireDistance2)))
        const direct = rgb(this.lights.sunColor).mul(visible.r.mul(sunPhase))
          .add(rgb(this.lights.fireColor).mul(visible.g.div(fireDistance2).mul(firePhase)))
        // Isotropic part: the phase integrates the surrounding radiance to its mean
        const indirect = texture3D(this.ambient, uvw, float(0)).rgb
        const stepTransmittance = exp(sigma.div(MIST_ALBEDO).mul(ds).negate()).toConst()
        // Energy-conserving step: σs ∫ T dt over the step = albedo · (1 − T_step)
        radiance.addAssign(direct.add(indirect).mul(transmittance.mul(stepTransmittance.oneMinus()).mul(MIST_ALBEDO)))
        transmittance.mulAssign(stepTransmittance)
      })
      return vec4(radiance, transmittance)
    })()
  }

  /** Mean radiance of the indirect light at `p` (what an isotropic scatterer such as turbid water receives). */
  ambientAt(p: Node<'vec3'>): Node<'vec3'> {
    return texture3D(this.ambient, p.sub(this.boundsMin).div(this.boundsSize), float(0)).rgb
  }

  /** `σs` at `p`: a bank over the water thinning upward, broken up by drifting noise. */
  private densityAt(p: Node<'vec3'>): Node<'float'> {
    const height = max(p.y.sub(this.waterLevel), 0.0)
    const profile = exp(height.div(-2.2)).mul(0.7).add(0.3)
    const drift = vec3(cos(this.phase), sin(this.phase.mul(2)).mul(0.5), sin(this.phase)).mul(0.25)
    const coarse = texture3D(this.noise, p.mul(0.045).add(drift), float(0)).r
    const fine = texture3D(this.noise, p.mul(0.13).sub(drift.mul(2)), float(0)).r
    const breakup = coarse.mul(0.65).add(fine.mul(0.35)).mul(1.4).add(0.3)
    const air = texture3D(this.airMask, p.sub(this.boundsMin).div(this.boundsSize), float(0)).r
    return this.density.mul(profile).mul(breakup).mul(air)
  }

  private voxelCoords(size: [number, number, number]) {
    const [x, y] = size
    return uvec3(instanceIndex.mod(uint(x)), instanceIndex.div(uint(x)).mod(uint(y)), instanceIndex.div(uint(x * y)))
  }

  private voxelCenter(coords: Node<'uvec3'>, voxel: number) {
    return this.boundsMin.add(vec3(coords).add(0.5).mul(voxel))
  }

  private createClearKernel(tex: Storage3DTexture) {
    const {width, height, depth} = tex.image as {width: number; height: number; depth: number}
    const size: [number, number, number] = [width, height, depth]
    const count = size[0] * size[1] * size[2]
    return Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        textureStore(tex, this.voxelCoords(size), vec4(0))
      })
    })().compute(count).setName('Hollow.MistClear')
  }

  private createCombineKernel() {
    const size = this.ambientSize
    const count = size[0] * size[1] * size[2]
    const {sun, fire, sky} = this.ambientSources
    return Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const coords = this.voxelCoords(size)
        const uvw = vec3(coords).add(0.5).div(vec3(...size))
        const mean = texture3D(sun, uvw, float(0)).rgb.mul(this.lights.giSun)
          .add(texture3D(sky, uvw, float(0)).rgb.mul(this.lights.giSky))
          .add(texture3D(fire, uvw, float(0)).rgb.mul(this.lights.giFire))
        textureStore(this.ambient, coords, vec4(mean, 1))
      })
    })().compute(count).setName('Hollow.MistCombine')
  }

  /** Zeroes the baked visibility and ambient (the geometry changed, so they are stale until the next bake). */
  clear(renderer: WebGPURenderer) {
    for (const kernel of this.clearKernels) void renderer.compute(kernel)
  }

  /**
   * Bakes the sun and fire visibility of every mist voxel from their shadow maps (call after the frame that rendered
   * them). Bias, near and far follow the shadows so the mist's shafts line up with the shadows on the rock.
   */
  bakeVisibility(renderer: WebGPURenderer, sun: DirectionalLight, fire: PointLight) {
    const sunDepth = sun.shadow.map?.depthTexture
    const fireDepth = fire.shadow.map?.depthTexture
    if (!sunDepth || !fireDepth) return false
    this.sunShadowMatrix.value.copy(sun.shadow.matrix)
    this.sunShadowParams.value.set(sun.shadow.bias, sun.shadow.camera.near, sun.shadow.camera.far, 0)
    this.fireShadowParams.value.set(fire.shadow.bias, fire.shadow.camera.near, fire.shadow.camera.far, 0)
    this.fireShadowOrigin.value.setFromMatrixPosition(fire.matrixWorld)
    const key = `${sunDepth.uuid}:${fireDepth.uuid}`
    if (!this.visibilityKernel || this.visibilityKey !== key) {
      // @types/three doesn't relate the shadow maps' texture types to what `texture()` / `cubeTexture()` take
      this.shadowMaps = {
        sun: sunDepth as unknown as Parameters<typeof texture>[0],
        fire: fireDepth as unknown as Parameters<typeof cubeTexture>[0],
      }
      this.visibilityKernel?.dispose()
      this.visibilityKernel = this.createVisibilityKernel()
      this.visibilityKey = key
    }
    void renderer.compute(this.visibilityKernel)
    return true
  }

  /** Whether the shadow maps are known (materials built before the first bake see no light through them). */
  get shadowsReady() {
    return this.shadowMaps !== null
  }

  /**
   * `vec2(sun, fire)` visibility of `p` read from their shadow maps, the fire's seen from `fireOrigin`. Resolved when
   * the shader is built (`0` before the first bake: rebuild the material after it). Branch-free, so fragment shaders
   * may call it; compute shaders pass `compute`.
   */
  directVisibility(p: Node<'vec3'>, fireOrigin: Node<'vec3'>, compute = false): Node<'vec2'> {
    return Fn(() => this.sampleVisibility(p, fireOrigin, compute))()
  }

  /**
   * The shadow maps carry comparison samplers: fragment shaders compare in hardware (2×2 filtered), compute shaders,
   * which can't, load the depth and compare it.
   */
  private sampleVisibility(p: Node<'vec3'>, fireOrigin: Node<'vec3'>, compute: boolean): Node<'vec2'> {
    const maps = this.shadowMaps
    if (!maps) return vec2(0)
    const lit = (map: TextureNode, reference: Node<'float'>): Node<'float'> => compute
      ? select(reference.lessThanEqual(map.r), 1, 0)
      : map.compare(reference) as unknown as Node<'float'>

    // Sun: orthographic shadow map addressed by the shadow matrix (WebGPU flips v)
    const clip = this.sunShadowMatrix.mul(vec4(p, 1))
    const coord = clip.xyz.div(clip.w)
    const uv = vec2(coord.x, coord.y.oneMinus())
    const inside = uv.x.greaterThanEqual(0).and(uv.x.lessThanEqual(1)).and(uv.y.greaterThanEqual(0))
      .and(uv.y.lessThanEqual(1)).and(coord.z.greaterThanEqual(0)).and(coord.z.lessThanEqual(1))
    const sun = select(inside, lit(texture(maps.sun, uv.clamp(0, 1)), coord.z.add(this.sunShadowParams.x)), 0)

    // Fire: cube shadow map addressed by the light-to-point vector
    const toPoint = p.sub(fireOrigin)
    const a = abs(toPoint)
    const viewZ = max(max(a.x, a.y), a.z)
    const near = this.fireShadowParams.y
    const far = this.fireShadowParams.z
    const reference = viewZToPerspectiveDepth(viewZ.negate(), near, far).add(this.fireShadowParams.x)
    const fireLit = lit(cubeTexture(maps.fire, normalize(toPoint)), reference)
    const fire = select(viewZ.greaterThanEqual(near).and(viewZ.lessThanEqual(far)), fireLit, 0)
    return vec2(sun, fire)
  }

  private createVisibilityKernel() {
    const size = this.visibilitySize
    const count = size[0] * size[1] * size[2]
    return Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const coords = this.voxelCoords(size)
        const p = this.voxelCenter(coords, VISIBILITY_VOXEL).toConst()
        const visible = this.directVisibility(p, this.fireShadowOrigin, true)
        textureStore(this.visibility, coords, vec4(visible, 0, 1))
      })
    })().compute(count).setName('Hollow.MistVisibility')
  }

  /**
   * Cone-traces the mean radiance around every ambient voxel through `volume`, which holds one light source at unit
   * intensity (cones leaving the volume gather nothing: the cave is closed but for the sky portal).
   */
  bakeAmbient(renderer: WebGPURenderer, source: HollowLightSource, volume: VXGIVolume) {
    let kernel = this.ambientKernels[source]
    if (!kernel) {
      kernel = this.createAmbientKernel(this.ambientSources[source], volume)
      this.ambientKernels[source] = kernel
    }
    void renderer.compute(kernel)
  }

  private createAmbientKernel(target: Storage3DTexture, volume: VXGIVolume) {
    const size = this.ambientSize
    const count = size[0] * size[1] * size[2]
    const trace = createConeTracer(volume, {
      radianceNode: volume.radianceNode,
      directionalNode: volume.directionalRadiance ? volume.directionalNode : null,
      maxSteps: 96,
    })
    // Cones of ~53° (16 of them tile the sphere), on a Fibonacci spiral
    const tanHalfAngle = float(Math.tan((26.5 * Math.PI) / 180))
    return Fn(() => {
      If(instanceIndex.lessThan(uint(count)), () => {
        const coords = this.voxelCoords(size)
        const p = this.voxelCenter(coords, AMBIENT_VOXEL).toConst()
        const sum = vec3(0).toVar()
        Loop(AMBIENT_CONES, ({i}) => {
          const z = float(i).add(0.5).mul(2 / AMBIENT_CONES).oneMinus().toConst()
          const r = sqrt(z.mul(z).oneMinus().max(0)).toConst()
          const phi = float(i).mul(Math.PI * (3 - Math.sqrt(5))).toConst()
          const dir = vec3(r.mul(cos(phi)), z, r.mul(sin(phi)))
          sum.addAssign(trace(p, dir, tanHalfAngle, volume.traceDistanceNode).color)
        })
        textureStore(target, coords, vec4(sum.div(AMBIENT_CONES), 1))
      })
    })().compute(count).setName('Hollow.MistAmbient')
  }

  /** Per frame: the mist's drift phase and the indirect light at the current (flickering) levels. */
  update(renderer: WebGPURenderer, time: number, duration: number) {
    this.phase.value = (time / Math.max(1e-3, duration)) * Math.PI * 2
    void renderer.compute(this.combineKernel)
  }

  dispose() {
    this.visibility.dispose()
    for (const tex of Object.values(this.ambientSources)) tex.dispose()
    this.ambient.dispose()
    this.noise.dispose()
    this.airMask.dispose()
    this.visibilityKernel?.dispose()
    for (const kernel of Object.values(this.ambientKernels)) kernel?.dispose()
    this.combineKernel.dispose()
    for (const kernel of this.clearKernels) kernel.dispose()
  }
}
