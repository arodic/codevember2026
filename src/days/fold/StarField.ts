import {
  AdditiveBlending, BufferAttribute, Color, InstancedBufferAttribute, InstancedBufferGeometry, MathUtils, Mesh,
  MeshBasicNodeMaterial, Vector3,
} from 'three/webgpu'
import {
  Fn, attribute, cameraProjectionMatrix, cameraViewMatrix, clamp, exp, float, length, positionGeometry, pow, screenSize,
  select, smoothstep, uniform, varying, vec2, vec3, vec4,
} from 'three/tsl'
import { BRIGHT_STARS } from './brightStars.js'
import { EQUATORIAL_TO_GALACTIC, GALACTIC_TO_EQUATORIAL, SUN_LUX, blackbodyColor, createRandom, equatorialDirection, magnitudeToLux } from './celestial.js'
import { SUN_INTENSITY, SkyUniforms, cloudOpacityToward, galacticDust } from './FoldSky.js'

/** Stars seeded along the galactic disk, bulge and halo, below the catalog's magnitude limit. */
export const GALAXY_STARS = 150000

/** Physical angular radius of a star's disc; far below a pixel at any usual field of view. */
const STAR_SIZE = 0.0005

/**
 * Integral of the tent kernel `(1 - |x|)(1 - |y|)` over the quad's [-1, 1]² corners. At a footprint a pixel in
 * half-width, its samples at the pixel centers add up to exactly that wherever the star falls between them (a
 * bilinear splat), so a star's light on screen never changes as it drifts across pixels.
 */
const KERNEL_AREA = 1

/** Atmospheric extinction at the zenith, in magnitudes per air mass (a clear desert night). */
const EXTINCTION = 0.2

function laplace(random: () => number, scale: number) {
  const u = random() - 0.5
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u))
}

function gaussian(random: () => number) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
}

/**
 * Star directions (equatorial), light (linear color × lux) and whether galactic dust dims them: the catalog's bright
 * stars as observed, then field stars of the thin and thick disk, the bulge and the halo, from a luminosity function
 * rising toward the faint end.
 */
function createStars() {
  const brightCount = BRIGHT_STARS.length / 4
  const count = brightCount + GALAXY_STARS
  const directions = new Float32Array(count * 3)
  const lights = new Float32Array(count * 4)
  const direction = new Vector3()
  const color = new Color()

  for (let i = 0; i < brightCount; i++) {
    const [rightAscension, declination, magnitude, temperature] = BRIGHT_STARS.slice(i * 4, i * 4 + 4)
    equatorialDirection(MathUtils.degToRad(rightAscension), MathUtils.degToRad(declination), direction).toArray(directions, i * 3)
    blackbodyColor(temperature * 100, color).multiplyScalar(magnitudeToLux(magnitude)).toArray(lights, i * 4)
    lights[i * 4 + 3] = 0
  }

  const random = createRandom(1572)
  const faintest = Math.pow(10, 0.38 * 5.8) - 1
  for (let i = brightCount; i < count; i++) {
    const population = random()
    let longitude: number
    let latitude: number
    let kelvin: number
    if (population < 0.8) {
      longitude = random() < 0.55 ? random() * Math.PI * 2 : laplace(random, 0.7)
      latitude = laplace(random, population < 0.62 ? 0.045 : 0.14)
      const kind = random()
      kelvin = kind < 0.55 ? 3300 + 1700 * random() : kind < 0.85 ? 5000 + 2500 * random() : 7500 + 15000 * random() * random()
    } else if (population < 0.92) {
      longitude = gaussian(random) * 0.14
      latitude = gaussian(random) * 0.1 - 0.02
      kelvin = 3200 + 2000 * random()
    } else {
      longitude = random() * Math.PI * 2
      latitude = Math.asin(random() * 2 - 1)
      kelvin = 3500 + 3500 * random()
    }
    direction.set(Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude))
    direction.applyMatrix3(GALACTIC_TO_EQUATORIAL).toArray(directions, i * 3)
    const magnitude = 3.6 + Math.log10(1 + random() * faintest) / 0.38
    blackbodyColor(kelvin, color).multiplyScalar(magnitudeToLux(magnitude)).toArray(lights, i * 4)
    lights[i * 4 + 3] = 1
  }

  return {count, directions, lights}
}

/**
 * Flicker-free stars after arodic/milkyway's `ParticleRender.shader`: each star is a quad of its physical angular
 * size, never drawn smaller than `minSize` pixels across its half-width, and never smaller than one: below a pixel the
 * kernel misses pixel centers, and a drifting star flashes up to five times its light and vanishes in turn. A star
 * whose projected size falls below that footprint is spread over it with its light scaled by the ratio of the areas,
 * so its energy on screen holds at any resolution or zoom. Quads sit at the far plane and add their light. The sky
 * turns with `celestialFrame`; air mass, the cloud deck and (for field stars) galactic dust dim them.
 */
export class StarField extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {

  /** Half-width of the smallest footprint, in pixels (the stars draw no smaller than 1; the meteors take it as is). */
  readonly minSize = uniform(1.5)
  readonly brightness = uniform(1)

  constructor(sky: SkyUniforms) {
    const {count, directions, lights} = createStars()
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.setAttribute('starDirection', new InstancedBufferAttribute(directions, 3))
    geometry.setAttribute('starLight', new InstancedBufferAttribute(lights, 4))
    geometry.instanceCount = count

    super(geometry, new MeshBasicNodeMaterial())
    this.name = 'Stars'
    this.frustumCulled = false
    this.renderOrder = 1
    this.userData.selectable = false

    const material = this.material
    material.name = 'Stars'
    material.transparent = true
    material.depthWrite = false
    material.blending = AdditiveBlending
    material.fog = false

    const galacticFromEquatorial = uniform(EQUATORIAL_TO_GALACTIC)
    const vLight = varying(vec3(), 'vStarLight')
    const vCorner = varying(vec2(), 'vStarCorner')
    const minSize = this.minSize.max(1.0)
    const brightness = this.brightness

    material.vertexNode = Fn(() => {
      const corner = positionGeometry.xy
      const equatorial = attribute<'vec3'>('starDirection', 'vec3')
      const starLight = attribute<'vec4'>('starLight', 'vec4')
      const local = sky.celestialFrame.mul(equatorial)

      // project the center and a corner of the star's physical quad, a unit away from the camera
      const center = cameraViewMatrix.mul(vec4(local, 0.0)).xyz
      const clipCenter = cameraProjectionMatrix.mul(vec4(center, 1.0))
      const clipCorner = cameraProjectionMatrix.mul(vec4(center.add(vec3(corner.mul(STAR_SIZE), 0.0)), 1.0))
      const ndcCenter = clipCenter.xy.div(clipCenter.w)
      const ndcCorner = clipCorner.xy.div(clipCorner.w)

      // never smaller than the minimum footprint; the light spreads over it by the ratio of the areas
      const projected = length(ndcCorner.sub(ndcCenter).mul(screenSize).mul(0.5))
      const smallest = length(corner).mul(minSize)
      const ndc = select(projected.lessThan(smallest), ndcCenter.add(corner.mul(minSize).mul(2.0).div(screenSize)), ndcCorner)
      const coverage = pow(clamp(projected.div(smallest), 0.0, 1.0), 2.0)

      const altitude = local.y
      const airMass = float(1.0).div(altitude.max(0.0).add(0.025))
      const extinction = pow(10.0, airMass.mul(-0.4 * EXTINCTION)).mul(smoothstep(-0.005, 0.02, altitude))
      const dust = exp(galacticDust(galacticFromEquatorial.mul(equatorial)).mul(-1.6).mul(starLight.w))
      const clouds = cloudOpacityToward(sky, local).mul(smoothstep(0.0, 0.06, altitude))
      const radiance = (SUN_INTENSITY / SUN_LUX) / (KERNEL_AREA * STAR_SIZE * STAR_SIZE)

      vLight.assign(starLight.xyz.mul(radiance).mul(sky.preExposure).mul(brightness).mul(coverage).mul(extinction).mul(dust).mul(float(1.0).sub(clouds)))
      vCorner.assign(corner)

      // at the far plane; behind the camera, outside the clip volume
      const w = clipCenter.w
      return select(w.greaterThan(0.0), vec4(ndc.mul(w), w, w), vec4(0.0, 0.0, 2.0, 1.0))
    })()

    const tent = float(1.0).sub(vCorner.abs()).max(0.0)
    material.colorNode = vLight.mul(tent.x.mul(tent.y))
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
