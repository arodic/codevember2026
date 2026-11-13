import {
  AdditiveBlending, BoxGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, UniformNode, Vector3,
} from 'three/webgpu'
import {
  Loop, cameraPosition, color, exp, float, fog, fract, hash, max, mix, mx_noise_float, normalize, positionWorld,
  saturate, smoothstep, uniform, vec3,
} from 'three/tsl'
import type { HollowField } from './HollowField.js'

/**
 * In-scene volumetric skylight shafts + cave mist.
 * Shafts use `colorNode` only (`fragmentNode === null`) so TRAA MRT views stay valid and the lake reflector sees them.
 */
export class HollowVolumetrics {

  readonly shaftMesh: Mesh<BoxGeometry, MeshBasicNodeMaterial>
  private readonly waterLevel: UniformNode<'float', number>
  private readonly skyEmitter: UniformNode<'float', number>
  private readonly shaftIntensity = uniform(1.15)
  private readonly shaftCenter = uniform(new Vector3())
  private readonly shaftDir = uniform(new Vector3(0.1, 0.8, -0.5))

  constructor(waterLevel: UniformNode<'float', number>, skyEmitter?: UniformNode<'float', number>) {
    this.waterLevel = waterLevel
    this.skyEmitter = skyEmitter ?? uniform(1.0)
    this.shaftMesh = this.createShaftMesh()
  }

  applyFog(scene: {fogNode?: unknown}) {
    const camDist = positionWorld.sub(cameraPosition).length()
    const rearChamberFactor = smoothstep(-7.5, -22.5, positionWorld.z)
    const heightMist = exp(max(positionWorld.y.sub(this.waterLevel).mul(0.22), 0.0).negate())
    const distFog = smoothstep(8.0, 34.0, camDist)
    const fogAmount = saturate(
      rearChamberFactor.mul(0.62).mul(heightMist.mul(0.55).add(0.45)).add(distFog.mul(0.22)),
    )
    const mistColor = mix(color(0x16384c), color(0x3998d1), rearChamberFactor)
    scene.fogNode = fog(mistColor, fogAmount)
  }

  syncToField(field: HollowField) {
    const c = field.skylightCenter
    const d = field.skylightDirection
    this.shaftCenter.value.set(c.x, (c.y + field.params.waterLevel + 2.0) * 0.5, c.z + 3.2)
    this.shaftDir.value.copy(d).normalize()
    this.shaftMesh.position.copy(this.shaftCenter.value)
    const s = field.params.skylightSize
    this.shaftMesh.scale.set(7.2 * s, 10.0, 7.2 * s)
    this.shaftMesh.lookAt(
      this.shaftCenter.value.x + d.x,
      this.shaftCenter.value.y + d.y,
      this.shaftCenter.value.z + d.z,
    )
    this.shaftMesh.rotateX(Math.PI / 2)
  }

  private createShaftMesh() {
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    mat.name = 'Hollow Skylight Shaft'
    mat.fog = false

    const steps = 18
    const raymarch = (() => {
      const cam = cameraPosition
      const worldP = positionWorld
      const view = normalize(worldP.sub(cam))
      const density = float(0.0).toVar()
      const stepLen = float(0.6)
      const pos = worldP.toVar()
      Loop(steps, () => {
        const toCenter = pos.sub(this.shaftCenter)
        const along = toCenter.dot(this.shaftDir)
        const radial = toCenter.sub(this.shaftDir.mul(along)).length()
        const cone = saturate(float(1.0).sub(radial.div(float(3.6).add(along.mul(0.1)))))
        const heightFade = smoothstep(-0.5, 2.2, pos.y.sub(this.waterLevel))
          .mul(smoothstep(10.8, 6.2, pos.y))
        const humidity = mx_noise_float(pos.mul(0.17)).mul(0.5).add(0.5)
        const cosTheta = view.dot(this.shaftDir.negate())
        const g = float(0.65)
        const hgDenom = float(1.0).add(g.mul(g)).sub(g.mul(2.0).mul(cosTheta)).max(0.05).pow(1.5)
        const hg = float(1.0).sub(g.mul(g)).div(float(12.566).mul(hgDenom))
        const jitter = fract(hash(pos).mul(43758.5453))
        density.addAssign(
          cone.mul(heightFade).mul(humidity.mul(0.65).add(0.35)).mul(hg).mul(stepLen).mul(jitter.mul(0.3).add(0.85)),
        )
        pos.assign(pos.add(view.mul(stepLen.negate())))
      })
      const a = saturate(density.mul(0.2))
      return color(0x6bbbd6).mul(2.1).mul(this.shaftIntensity).mul(this.skyEmitter).mul(a)
    })()

    mat.colorNode = raymarch
    mat.opacityNode = float(1.0)

    const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat)
    mesh.name = 'Volumetric Skylight Shafts'
    mesh.renderOrder = 2
    mesh.userData.selectable = false
    mesh.frustumCulled = false
    return mesh
  }

  dispose() {
    this.shaftMesh.geometry.dispose()
    this.shaftMesh.material.dispose()
  }
}

void vec3
