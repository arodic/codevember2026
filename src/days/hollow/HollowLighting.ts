import {
  Color, CubeCamera, CubeRenderTarget, DirectionalLight, HalfFloatType, HemisphereLight, MathUtils, PMREMGenerator,
  PointLight, RectAreaLight, RectAreaLightNode, Scene, Vector3, WebGPURenderer,
} from 'three/webgpu'
import {uniform} from 'three/tsl'
import {LightProbeGrid} from 'three/addons/lighting/LightProbeGrid.js'
import {RectAreaLightTexturesLib} from 'three/addons/lights/RectAreaLightTexturesLib.js'
import {HOLLOW_MAX, HOLLOW_MIN, HollowField} from './HollowField.js'

export type HollowBakeStage = 'idle' | 'clear' | 'direct' | 'bounce' | 'env' | 'done'

/** Static light levels the inspector tweaks before hitting rebake. */
export interface HollowLightLevels {
  skylightIntensity: number
  skyAreaIntensity: number
  firePointIntensity: number
  fireAreaIntensity: number
  fillIntensity: number
  probeIntensity: number
}

export const DEFAULT_HOLLOW_LIGHTS: HollowLightLevels = {
  skylightIntensity: 6.5,
  skyAreaIntensity: 22,
  firePointIntensity: 58,
  fireAreaIntensity: 26,
  fillIntensity: 0.55,
  probeIntensity: 1.15,
}

const PROBES_X = 8
const PROBES_Y = 5
const PROBES_Z = 12
const CUBEMAP_SIZE = 16
const BOUNCES = 2
const PROBES_PER_FRAME = 40
const ENV_SIZE = 128

let ltcReady = false

function ensureRectAreaLtc() {
  if (ltcReady) return
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
  ltcReady = true
}

function lightOn(intensity: number) {
  return intensity > 1e-4
}

/**
 * Static `LightProbeGrid` GI + static direct lights for tweak/rebake isolation.
 * - **Before each bake:** probe atlas + env maps wiped to black/null so rebakes don't inherit prior light.
 * - **Bake:** only lights with intensity > 0 contribute. Fire point stays off (area authors GI).
 * - **Realtime:** fire point on when its intensity > 0 (no flicker). Zero-intensity lights are hidden.
 */
export class HollowLighting {

  probeGrid: LightProbeGrid
  skyProbeGrid: LightProbeGrid
  fireProbeGrid: LightProbeGrid
  readonly skylight: DirectionalLight
  readonly skyArea: RectAreaLight
  readonly firePoint: PointLight
  readonly fireArea: RectAreaLight
  readonly fill: HemisphereLight
  /** Kept for material hooks; flicker disabled (always 1). */
  readonly fireIntensity = uniform(1.0)
  readonly fireTint = uniform(new Color(0xff8c2e))
  /** Scales the cyan sky-portal emitter with sky light levels (0 when both sky lights are off). */
  readonly skyEmitter = uniform(1.0)

  levels: HollowLightLevels = {...DEFAULT_HOLLOW_LIGHTS}

  private readonly field: HollowField
  private readonly scene: Scene
  private readonly gridSize: Vector3
  private readonly gridCenter: Vector3
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
  /** Cleared env/atlas once per bake request, before direct pass. */
  private needsClear = false

  constructor(field: HollowField, scene: Scene) {
    ensureRectAreaLtc()
    this.field = field
    this.scene = scene

    this.gridSize = new Vector3().subVectors(HOLLOW_MAX, HOLLOW_MIN)
    this.gridCenter = new Vector3().addVectors(HOLLOW_MIN, HOLLOW_MAX).multiplyScalar(0.5)

    this.probeGrid = this.createProbeGrid()
    this.skyProbeGrid = this.probeGrid
    this.fireProbeGrid = this.probeGrid

    this.skylight = new DirectionalLight(0x8ad8f0, this.levels.skylightIntensity)
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

    this.skyArea = new RectAreaLight(0x96cfdc, this.levels.skyAreaIntensity, 6.5, 5.5)
    this.skyArea.name = 'Skylight Area'
    this.skyArea.rotation.x = Math.PI / 2

    this.firePoint = new PointLight(0xff8c2e, this.levels.firePointIntensity, 30, 1.55)
    this.firePoint.name = 'Hidden Fire Point'
    this.firePoint.castShadow = true
    this.firePoint.shadow.mapSize.setScalar(1024)
    this.firePoint.shadow.camera.near = 0.35
    this.firePoint.shadow.camera.far = 26
    this.firePoint.shadow.bias = -0.0015
    this.firePoint.shadow.normalBias = 0.05

    this.fireArea = new RectAreaLight(0xffa04a, this.levels.fireAreaIntensity, 2.6, 2.0)
    this.fireArea.name = 'Fire Area'

    this.fill = new HemisphereLight(0x5a8fb0, 0x4a2a14, this.levels.fillIntensity)
    this.fill.name = 'Cave Fill'

    scene.add(this.skylight)
    scene.add(this.skylight.target)
    scene.add(this.skyArea)
    scene.add(this.firePoint)
    scene.add(this.fireArea)
    scene.add(this.fill)
    scene.add(this.probeGrid)

    this.applyLevels()
  }

  private createProbeGrid() {
    const grid = new LightProbeGrid(
      this.gridSize.x, this.gridSize.y, this.gridSize.z,
      PROBES_X, PROBES_Y, PROBES_Z,
    )
    grid.name = 'Hollow Probe Grid'
    grid.position.copy(this.gridCenter)
    grid.visible = true
    grid.intensity = this.levels.probeIntensity
    grid.updateBoundingBox()
    return grid
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

  /** Align light rigs to the seeded cavern; intensities stay at current `levels`. */
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
    this.fireArea.lookAt(fire.x, fire.y + 0.4, fire.z - 4.0)

    this.applyLevels()
  }

  setLevels(partial: Partial<HollowLightLevels>) {
    this.levels = {...this.levels, ...partial}
    this.applyLevels()
  }

  get skyLightsOn() {
    return lightOn(this.levels.skylightIntensity) || lightOn(this.levels.skyAreaIntensity)
  }

  /** Push static intensities/colors; hide any light whose intensity is ~0. */
  applyLevels() {
    const L = this.levels
    this.skylight.intensity = L.skylightIntensity
    this.skylight.color.set(0x8ad8f0)
    this.skyArea.intensity = L.skyAreaIntensity
    this.skyArea.color.set(0x96cfdc)
    this.firePoint.intensity = L.firePointIntensity
    this.firePoint.color.set(0xff8c2e)
    this.fireArea.intensity = L.fireAreaIntensity
    this.fireArea.color.set(0xffa04a)
    this.fill.intensity = L.fillIntensity
    this.probeGrid.intensity = L.probeIntensity
    this.fireIntensity.value = 1.0
    this.fireTint.value.set(0xff8c2e)

    const skyScale = Math.max(
      L.skylightIntensity / Math.max(DEFAULT_HOLLOW_LIGHTS.skylightIntensity, 1e-6),
      L.skyAreaIntensity / Math.max(DEFAULT_HOLLOW_LIGHTS.skyAreaIntensity, 1e-6),
    )
    this.skyEmitter.value = this.skyLightsOn ? MathUtils.clamp(skyScale, 0, 4) : 0

    if (!this.baking) this.applyRuntimeVisibility()
  }

  private applyRuntimeVisibility() {
    const L = this.levels
    this.skylight.visible = lightOn(L.skylightIntensity)
    this.skyArea.visible = lightOn(L.skyAreaIntensity)
    this.firePoint.visible = lightOn(L.firePointIntensity)
    this.fireArea.visible = lightOn(L.fireAreaIntensity)
    this.fill.visible = lightOn(L.fillIntensity)
    this.probeGrid.visible = lightOn(L.probeIntensity)
  }

  /**
   * Queue a bake. Atlas + env are wiped on the first `stepBake` so a zero-light bake can go black.
   */
  requestBake() {
    this.bakeStage = 'clear'
    this.bakeIndex = 0
    this.bouncePass = 0
    this.needsClear = true
  }

  get baking() {
    return this.bakeStage !== 'idle' && this.bakeStage !== 'done'
  }

  get bakeProgress() {
    const stages = ['clear', 'direct', 'bounce', 'env'] as const
    const si = stages.indexOf(this.bakeStage as typeof stages[number])
    if (si < 0) return this.bakeStage === 'done' ? 1 : 0
    const bounceFrac = this.bakeStage === 'bounce' ? this.bouncePass / Math.max(1, BOUNCES) : 0
    const probeFrac = this.bakeIndex / this.totalProbes
    return MathUtils.clamp((si + probeFrac * 0.7 + bounceFrac * 0.25) / stages.length, 0, 0.99)
  }

  /** Drop PMREM env maps so materials / next bake don't inherit prior IBL. */
  clearEnvMaps() {
    this.lakeEnvMap?.dispose()
    this.skyEnvMap?.dispose()
    this.lakeEnvMap = null
    this.skyEnvMap = null
  }

  /**
   * Replace the probe grid so the SH atlas starts black. Public dispose+recreate —
   * LightProbeGrid has no clear API.
   */
  clearProbeAtlas() {
    const intensity = this.levels.probeIntensity
    this.scene.remove(this.probeGrid)
    this.probeGrid.dispose()
    this.probeGrid = this.createProbeGrid()
    this.probeGrid.intensity = intensity
    this.skyProbeGrid = this.probeGrid
    this.fireProbeGrid = this.probeGrid
    this.scene.add(this.probeGrid)
  }

  stepBake(renderer: WebGPURenderer) {
    if (!this.baking) return

    if (this.bakeStage === 'clear' || this.needsClear) {
      this.clearEnvMaps()
      this.clearProbeAtlas()
      this.needsClear = false
      this.bakeStage = 'direct'
      this.bakeIndex = 0
      this.bouncePass = 0
      return
    }

    if (this.bakeStage === 'direct' || this.bakeStage === 'bounce') {
      this.setBakeLights()
      const pass = this.bakeStage === 'direct' ? 0 : this.bouncePass
      const count = Math.min(PROBES_PER_FRAME, this.totalProbes - this.bakeIndex)
      this.probeGrid.bake(renderer, this.scene, {
        cubemapSize: CUBEMAP_SIZE,
        near: 0.2,
        far: 55,
        bounces: 0,
        start: this.bakeIndex,
        count,
        pass,
      })
      this.bakeIndex += count
      if (this.bakeIndex >= this.totalProbes) {
        this.bakeIndex = 0
        if (this.bakeStage === 'direct') {
          this.bakeStage = 'bounce'
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
      this.applyLevels()
      this.captureEnvProbes(renderer)
      this.bakeStage = 'done'
    }
  }

  /**
   * Bake visibility from current levels. Fire point stays off so GI is authored from the fire area.
   * Zero-intensity lights stay hidden so solo-light bakes isolate one contributor.
   */
  private setBakeLights() {
    const L = this.levels
    this.skylight.visible = lightOn(L.skylightIntensity)
    this.skyArea.visible = lightOn(L.skyAreaIntensity)
    this.fill.visible = lightOn(L.fillIntensity)
    this.fireArea.visible = lightOn(L.fireAreaIntensity)
    this.firePoint.visible = false
    this.probeGrid.visible = false

    this.skylight.intensity = L.skylightIntensity
    this.skylight.color.set(0x8ad8f0)
    this.skyArea.intensity = L.skyAreaIntensity
    this.skyArea.color.set(0x96cfdc)
    this.fireArea.intensity = L.fireAreaIntensity
    this.fireArea.color.set(0xffa04a)
    this.fill.intensity = L.fillIntensity
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

  dispose() {
    this.probeGrid.dispose()
    this.clearEnvMaps()
    this.lakeEnvTarget?.dispose()
    this.skyEnvTarget?.dispose()
    this.pmrem?.dispose()
  }
}
