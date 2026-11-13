import {
  Color, CubeCamera, CubeRenderTarget, DirectionalLight, HalfFloatType, MathUtils, PMREMGenerator, PointLight,
  RectAreaLight, RectAreaLightNode, Scene, Vector3, WebGPURenderer,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js'
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js'
import { HOLLOW_MAX, HOLLOW_MIN, HollowField, createHollowRandom } from './HollowField.js'

export type HollowBakeStage =
  | 'idle'
  | 'sky-direct'
  | 'sky-bounce'
  | 'fire-direct'
  | 'fire-bounce'
  | 'env'
  | 'done'

const PROBES_X = 10
const PROBES_Y = 6
const PROBES_Z = 14
const CUBEMAP_SIZE = 8
const BOUNCES = 2
const PROBES_PER_FRAME = 48
const ENV_SIZE = 128

let ltcReady = false

function ensureRectAreaLtc() {
  if (ltcReady) return
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
  ltcReady = true
}

/**
 * Dual static `LightProbeGrid` GI (sky + unit fire) with live fire scaling, skylight / fire area lights, and two
 * parallax PMREM specular probes. Grids stay `visible = false` and are sampled manually so sky + fire add linearly.
 */
export class HollowLighting {

  readonly skyProbeGrid: LightProbeGrid
  readonly fireProbeGrid: LightProbeGrid
  readonly skylight: DirectionalLight
  readonly skyArea: RectAreaLight
  readonly firePoint: PointLight
  readonly fireArea: RectAreaLight
  readonly fireIntensity = uniform(1.0)
  readonly fireTint = uniform(new Color(0xff8c2e))

  private readonly field: HollowField
  private readonly scene: Scene
  private pmrem: PMREMGenerator | null = null
  private lakeEnvTarget: CubeRenderTarget | null = null
  private skyEnvTarget: CubeRenderTarget | null = null
  private lakeCube: CubeCamera | null = null
  private skyCube: CubeCamera | null = null
  lakeEnvMap: ReturnType<PMREMGenerator['fromCubemap']> | null = null
  skyEnvMap: ReturnType<PMREMGenerator['fromCubemap']> | null = null

  bakeStage: HollowBakeStage = 'idle'
  private bakeIndex = 0
  private bouncePass = 0
  private readonly totalProbes = PROBES_X * PROBES_Y * PROBES_Z
  private fireBaseIntensity = 52
  private fireRand: () => number = createHollowRandom(1)
  private flickerPhase = 0

  constructor(field: HollowField, scene: Scene) {
    ensureRectAreaLtc()
    this.field = field
    this.scene = scene

    const size = new Vector3().subVectors(HOLLOW_MAX, HOLLOW_MIN)
    const center = new Vector3().addVectors(HOLLOW_MIN, HOLLOW_MAX).multiplyScalar(0.5)

    this.skyProbeGrid = new LightProbeGrid(size.x, size.y, size.z, PROBES_X, PROBES_Y, PROBES_Z)
    this.skyProbeGrid.name = 'Hollow Sky Probe Grid'
    this.skyProbeGrid.position.copy(center)
    this.skyProbeGrid.visible = false
    this.skyProbeGrid.intensity = 1
    this.skyProbeGrid.updateBoundingBox()

    this.fireProbeGrid = new LightProbeGrid(size.x, size.y, size.z, PROBES_X, PROBES_Y, PROBES_Z)
    this.fireProbeGrid.name = 'Hollow Fire Probe Grid'
    this.fireProbeGrid.position.copy(center)
    this.fireProbeGrid.visible = false
    this.fireProbeGrid.intensity = 1
    this.fireProbeGrid.updateBoundingBox()

    this.skylight = new DirectionalLight(0x8ad8f0, 5.2)
    this.skylight.name = 'Skylight'
    this.skylight.castShadow = true
    this.skylight.shadow.mapSize.setScalar(2048)
    this.skylight.shadow.camera.near = 2
    this.skylight.shadow.camera.far = 40
    this.skylight.shadow.camera.left = -10
    this.skylight.shadow.camera.right = 10
    this.skylight.shadow.camera.top = 10
    this.skylight.shadow.camera.bottom = -10
    this.skylight.shadow.bias = -0.0008
    this.skylight.shadow.normalBias = 0.04

    this.skyArea = new RectAreaLight(0x96cfdc, 18, 6.5, 5.5)
    this.skyArea.name = 'Skylight Area'
    this.skyArea.rotation.x = Math.PI / 2

    this.firePoint = new PointLight(0xff8c2e, this.fireBaseIntensity, 28, 1.7)
    this.firePoint.name = 'Hidden Fire'
    this.firePoint.castShadow = true
    this.firePoint.shadow.mapSize.setScalar(1024)
    this.firePoint.shadow.camera.near = 0.35
    this.firePoint.shadow.camera.far = 26
    this.firePoint.shadow.bias = -0.0015
    this.firePoint.shadow.normalBias = 0.05

    this.fireArea = new RectAreaLight(0xffa04a, 22, 2.4, 1.8)
    this.fireArea.name = 'Fire Area'

    scene.add(this.skylight)
    scene.add(this.skylight.target)
    scene.add(this.skyArea)
    scene.add(this.firePoint)
    scene.add(this.fireArea)
    // Probe grids stay out of the automatic light list (manual dual-sample in materials)
    scene.add(this.skyProbeGrid)
    scene.add(this.fireProbeGrid)
  }

  initRenderer(renderer: WebGPURenderer) {
    this.pmrem?.dispose()
    this.lakeEnvTarget?.dispose()
    this.skyEnvTarget?.dispose()
    this.pmrem = new PMREMGenerator(renderer)
    this.lakeEnvTarget = new CubeRenderTarget(ENV_SIZE, {type: HalfFloatType})
    this.skyEnvTarget = new CubeRenderTarget(ENV_SIZE, {type: HalfFloatType})
    this.lakeCube = new CubeCamera(0.2, 60, this.lakeEnvTarget)
    this.skyCube = new CubeCamera(0.2, 60, this.skyEnvTarget)
  }

  /** Align direct lights to the current seeded cavern anatomy. */
  syncToField() {
    const skyPos = this.field.skylightCenter
    const dir = this.field.skylightDirection
    this.skylight.target.position.set(
      skyPos.x - dir.x * 4.0,
      this.field.params.waterLevel + 1.1,
      skyPos.z - dir.z * 4.0,
    )
    this.skylight.position.copy(this.skylight.target.position).addScaledVector(dir, 21.0)
    this.skyArea.position.set(skyPos.x, skyPos.y - 0.35, skyPos.z)
    this.skyArea.width = 5.5 * this.field.params.skylightSize
    this.skyArea.height = 4.8 * this.field.params.skylightSize

    const fire = this.field.fireOrigin
    this.firePoint.position.copy(fire)
    this.fireArea.position.set(fire.x, fire.y + 0.15, fire.z - 0.35)
    // Face the fire area into the cavern (−Z)
    this.fireArea.lookAt(fire.x, fire.y + 0.4, fire.z - 4.0)

    this.fireRand = createHollowRandom(this.field.params.seed * 17 + 3)
    this.flickerPhase = this.fireRand() * Math.PI * 2
  }

  /** Queue a full dual-grid rebake after cavern rebuild. */
  requestBake() {
    this.bakeStage = 'sky-direct'
    this.bakeIndex = 0
    this.bouncePass = 0
  }

  get baking() {
    return this.bakeStage !== 'idle' && this.bakeStage !== 'done'
  }

  get bakeProgress() {
    const stages = ['sky-direct', 'sky-bounce', 'fire-direct', 'fire-bounce', 'env'] as const
    const si = stages.indexOf(this.bakeStage as typeof stages[number])
    if (si < 0) return this.bakeStage === 'done' ? 1 : 0
    const bounceFrac = this.bouncePass / Math.max(1, BOUNCES)
    const probeFrac = this.bakeIndex / this.totalProbes
    return MathUtils.clamp((si + probeFrac * 0.85 + bounceFrac * 0.15) / stages.length, 0, 0.99)
  }

  /**
   * Progressively bake sky then fire probe grids (direct + bounce passes), then capture PMREM specular probes.
   * Call once per `onBeforeDraw` while `baking`.
   */
  stepBake(renderer: WebGPURenderer) {
    if (!this.baking) return

    if (this.bakeStage === 'sky-direct' || this.bakeStage === 'sky-bounce') {
      this.setBakeLights('sky')
      const pass = this.bakeStage === 'sky-direct' ? 0 : this.bouncePass
      const count = Math.min(PROBES_PER_FRAME, this.totalProbes - this.bakeIndex)
      this.skyProbeGrid.bake(renderer, this.scene, {
        cubemapSize: CUBEMAP_SIZE,
        near: 0.15,
        far: 55,
        bounces: 0,
        start: this.bakeIndex,
        count,
        pass,
      })
      this.bakeIndex += count
      if (this.bakeIndex >= this.totalProbes) {
        this.bakeIndex = 0
        if (this.bakeStage === 'sky-direct') {
          this.bakeStage = 'sky-bounce'
          this.bouncePass = 1
        } else if (this.bouncePass < BOUNCES) {
          this.bouncePass++
        } else {
          this.bakeStage = 'fire-direct'
          this.bouncePass = 0
        }
      }
      return
    }

    if (this.bakeStage === 'fire-direct' || this.bakeStage === 'fire-bounce') {
      this.setBakeLights('fire')
      const pass = this.bakeStage === 'fire-direct' ? 0 : this.bouncePass
      const count = Math.min(PROBES_PER_FRAME, this.totalProbes - this.bakeIndex)
      this.fireProbeGrid.bake(renderer, this.scene, {
        cubemapSize: CUBEMAP_SIZE,
        near: 0.15,
        far: 55,
        bounces: 0,
        start: this.bakeIndex,
        count,
        pass,
      })
      this.bakeIndex += count
      if (this.bakeIndex >= this.totalProbes) {
        this.bakeIndex = 0
        if (this.bakeStage === 'fire-direct') {
          this.bakeStage = 'fire-bounce'
          this.bouncePass = 1
        } else if (this.bouncePass < BOUNCES) {
          this.bouncePass++
        } else {
          this.bakeStage = 'env'
        }
      }
      return
    }

    if (this.bakeStage === 'env') {
      this.setBakeLights('both')
      this.captureEnvProbes(renderer)
      this.bakeStage = 'done'
    }
  }

  private setBakeLights(mode: 'sky' | 'fire' | 'both') {
    const skyOn = mode === 'sky' || mode === 'both'
    const fireOn = mode === 'fire' || mode === 'both'
    this.skylight.visible = skyOn
    this.skyArea.visible = skyOn
    this.firePoint.visible = fireOn
    this.fireArea.visible = fireOn
    // Unit fire during bake so live intensity scales the SH cleanly
    if (fireOn && mode === 'fire') {
      this.firePoint.intensity = 1.0
      this.fireArea.intensity = 1.0
      this.firePoint.color.set(0xffffff)
      this.fireArea.color.set(0xffc090)
    }
    if (mode === 'both') {
      this.firePoint.intensity = this.fireBaseIntensity * this.fireIntensity.value
      this.fireArea.intensity = 22 * this.fireIntensity.value
    }
  }

  private captureEnvProbes(renderer: WebGPURenderer) {
    if (!this.pmrem || !this.lakeCube || !this.skyCube || !this.lakeEnvTarget || !this.skyEnvTarget) return

    const lakePos = new Vector3(this.field.spineX(-4.0), this.field.params.waterLevel + 1.6, -4.0)
    const skyPos = this.field.skylightCenter.clone()
    skyPos.y = Math.min(skyPos.y - 2.5, 6.5)

    this.lakeCube.position.copy(lakePos)
    this.skyCube.position.copy(skyPos)
    this.lakeCube.update(renderer, this.scene)
    this.skyCube.update(renderer, this.scene)

    this.lakeEnvMap?.dispose()
    this.skyEnvMap?.dispose()
    this.lakeEnvMap = this.pmrem.fromCubemap(this.lakeEnvTarget.texture)
    this.skyEnvMap = this.pmrem.fromCubemap(this.skyEnvTarget.texture)
  }

  /** Animate off-screen fire intensity / tint / micro-motion from timeline time. */
  updateFire(time: number) {
    const t = time + this.flickerPhase
    // Band-limited flicker: slow breath + mid crackle + fast spark
    const breath = 0.55 + 0.45 * Math.sin(t * 2.3) * Math.sin(t * 0.7 + 1.1)
    const crackle = 0.85 + 0.15 * Math.sin(t * 11.0 + Math.sin(t * 3.7) * 2.0)
    const spark = 0.92 + 0.08 * Math.sin(t * 29.0 + Math.sin(t * 7.1))
    const intensity = MathUtils.clamp(breath * crackle * spark, 0.35, 1.35)
    this.fireIntensity.value = intensity

    // Planckian-ish warm swing ~1850K–2350K as orange ↔ pale amber
    const warm = 0.5 + 0.5 * Math.sin(t * 1.7 + 0.4)
    this.fireTint.value.setRGB(
      1.0,
      0.42 + 0.28 * warm,
      0.12 + 0.18 * warm,
    )
    this.firePoint.color.copy(this.fireTint.value)
    this.fireArea.color.copy(this.fireTint.value).multiplyScalar(1.05)
    this.firePoint.intensity = this.fireBaseIntensity * intensity
    this.fireArea.intensity = 22 * intensity

    const fire = this.field.fireOrigin
    const dance = 0.10
    this.firePoint.position.set(
      fire.x + Math.sin(t * 5.1) * dance * 0.6,
      fire.y + 0.05 + Math.sin(t * 7.3 + 1.2) * dance,
      fire.z + Math.cos(t * 4.4) * dance * 0.5,
    )
    this.fireArea.position.set(this.firePoint.position.x, this.firePoint.position.y + 0.12, this.firePoint.position.z - 0.3)
  }

  dispose() {
    this.skyProbeGrid.dispose()
    this.fireProbeGrid.dispose()
    this.lakeEnvMap?.dispose()
    this.skyEnvMap?.dispose()
    this.lakeEnvTarget?.dispose()
    this.skyEnvTarget?.dispose()
    this.pmrem?.dispose()
  }
}
