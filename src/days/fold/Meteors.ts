import {
  AdditiveBlending, BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, MathUtils, Mesh,
  MeshBasicNodeMaterial, Node, UniformNode, Vector3,
} from 'three/webgpu'
import {
  Fn, attribute, cameraProjectionMatrix, cameraViewMatrix, cos, cross, exp, float, floor, fract, hash, instanceIndex,
  length, max, min, mix, normalize, positionGeometry, pow, saturate, screenSize, select, sin, smoothstep, sub, uniform,
  varying, vec2, vec3, vec4,
} from 'three/tsl'
import { SUN_LUX, createRandom, equatorialDirection } from './celestial.js'
import { SUN_INTENSITY, SkyUniforms, cloudOpacityToward } from './FoldSky.js'

/** The Perseids' radiant in Perseus at their mid-August peak (J2000). */
const RADIANT = equatorialDirection(MathUtils.degToRad(48), MathUtils.degToRad(58), new Vector3())

/**
 * Meteor slots, and how many times each fires in one loop of the timeline (somewhere else each time): 2048 chances a
 * loop, of which `rate` fire while the radiant is high.
 */
export const METEOR_SLOTS = 256
const METEOR_CYCLES = 8

/** Integral of the `exp(-4 v²)` profile across the streak's [-1, 1] width. */
const PROFILE_WIDTH = 0.882

type Vec3 = Node<'vec3'>

/**
 * The Perseid shower as a night-sky time-lapse catches it. Each slot fires `METEOR_CYCLES` times per loop of the
 * timeline at its own moment in each cycle, if that cycle's draw is under `rate` (less while the radiant is low: the
 * shower builds through the night as Perseus climbs): a streak along a great circle away from the radiant that
 * flares up and runs for a fraction of a second of playback, its trail growing behind the head and dimmer toward its
 * end, then burns out from the tail up to the head; mostly faint, now and then a fireball. Clouds hide it point by
 * point. Driven by the timeline's time, so they scrub and loop; daylight drowns them like any star. Drawn at the far
 * plane, never thinner than `minSize` pixels (the stars' footprint), with a head as bright as a star of its magnitude.
 */
export class Meteors extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {

  readonly rate = uniform(0.4)
  /** Seconds of one loop of the timeline. */
  readonly loop = uniform(60)

  constructor(sky: SkyUniforms, minSize: UniformNode<'float', number>) {
    const random = createRandom(8128)
    // when in its cycle a slot fires (where, and how bright, are drawn anew each cycle); seconds of playback it lasts,
    // how far it travels and how long its trail (radians)
    const phase = new Float32Array(METEOR_SLOTS)
    const shape = new Float32Array(METEOR_SLOTS * 3)
    for (let i = 0; i < METEOR_SLOTS; i++) {
      phase[i] = (i + random()) / METEOR_SLOTS
      shape.set([0.5 + random() * 0.6, 0.25 + random() * 0.4, 0.15 + random() * 0.3], i * 3)
    }
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.setAttribute('meteorPhase', new InstancedBufferAttribute(phase, 1))
    geometry.setAttribute('meteorShape', new InstancedBufferAttribute(shape, 3))
    geometry.instanceCount = METEOR_SLOTS

    super(geometry, new MeshBasicNodeMaterial())
    this.name = 'Meteors'
    this.frustumCulled = false
    this.renderOrder = 2
    this.userData.selectable = false

    const material = this.material
    material.name = 'Meteors'
    material.transparent = true
    material.depthWrite = false
    material.blending = AdditiveBlending
    material.fog = false

    const vLight = varying(vec3(), 'vMeteorLight')
    const vStreak = varying(vec2(), 'vMeteorStreak')
    // along the path (radians from the radiant): the tail, the head, the front the fade-out sweeps up it, its softness
    const vPath = varying(vec4(), 'vMeteorPath')
    const vTail = varying(vec3(), 'vMeteorTail')
    const vHead = varying(vec3(), 'vMeteorHead')
    const rate = this.rate
    const loop = this.loop

    material.vertexNode = Fn(() => {
      const corner = positionGeometry.xy
      const phase = attribute<'float'>('meteorPhase', 'float')
      const shape = attribute<'vec3'>('meteorShape', 'vec3')
      const period = loop.div(METEOR_CYCLES)
      const cycles = sky.time.div(period).add(phase)
      const age = fract(cycles).mul(period).div(shape.x)
      // this cycle's draw against the rate, direction away from the radiant, distance from it, and peak magnitude
      const seed = float(instanceIndex).mul(METEOR_CYCLES).add(floor(cycles)).mul(4.0)
      const radiant = vec3(RADIANT)
      const climbing = saturate(sky.celestialFrame.mul(radiant).y.mul(1.5)).mul(0.75).add(0.25)
      const fires = age.lessThanEqual(1.0).and(hash(seed).lessThan(rate.mul(climbing)))
      const start = hash(seed.add(2.0)).mul(0.9).add(0.3)
      const magnitude = float(3.5).sub(pow(hash(seed.add(3.0)), 2.0).mul(6.5))

      // a great circle through the radiant, in the equatorial frame
      const east = normalize(cross(radiant, vec3(0, 0, 1)))
      const north = cross(radiant, east)
      const heading = hash(seed.add(1.0)).mul(Math.PI * 2)
      const away = east.mul(cos(heading)).add(north.mul(sin(heading)))
      const onCircle = (distance: Node<'float'>): Vec3 => sky.celestialFrame.mul(radiant.mul(cos(distance)).add(away.mul(sin(distance))))
      const headDistance = start.add(shape.y.mul(age))
      const tailDistance = max(start, headDistance.sub(shape.z.mul(min(age.mul(2.5), 1.0))))
      const head = onCircle(headDistance)
      const tail = onCircle(tailDistance)
      // it burns out from the tail: over the last part of its life a front sweeps up the trail and past the head
      const soft = shape.z.mul(0.12)
      const front = mix(tailDistance, headDistance.add(soft), smoothstep(0.55, 1.0, age))

      const project = (direction: Vec3) => cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(direction, 0.0)).xyz, 1.0))
      const clipHead = project(head)
      const clipTail = project(tail)
      const pixels = screenSize.mul(0.5)
      const headPixel = clipHead.xy.div(clipHead.w).mul(pixels)
      const tailPixel = clipTail.xy.div(clipTail.w).mul(pixels)

      // a screen-aligned band from tail to head, capped at both ends
      const along = headPixel.sub(tailPixel)
      const streakLength = length(along).max(1e-3)
      const direction = along.div(streakLength)
      const across = vec2(direction.y.negate(), direction.x)
      const pixel = mix(tailPixel, headPixel, corner.x)
        .add(across.mul(corner.y).mul(minSize))
        .add(direction.mul(corner.x.mul(2.0).sub(1.0)).mul(minSize))

      // the head as bright as a star of its magnitude seen at the smallest footprint
      const nudged = project(normalize(head.add(sky.celestialFrame.mul(away).mul(0.001))))
      const radiansPerPixel = float(0.001).div(length(nudged.xy.div(nudged.w).mul(pixels).sub(headPixel)).max(1e-4))
      const lux = pow(10.0, magnitude.add(13.98).mul(-0.4))
      const footprint = radiansPerPixel.mul(minSize)
      const radiance = lux.mul(SUN_INTENSITY / SUN_LUX).div(footprint.mul(footprint).mul(PROFILE_WIDTH * 2.0))
      const flare = smoothstep(0.0, 0.08, age).mul(sub(1.0, smoothstep(0.75, 1.0, age).mul(0.35)))
      vLight.assign(vec3(0.85, 1.0, 0.88).mul(radiance).mul(sky.preExposure).mul(flare))
      vStreak.assign(corner)
      vPath.assign(vec4(tailDistance, headDistance, front, soft))
      vTail.assign(tail)
      vHead.assign(head)

      const w = clipHead.w
      const position = vec4(pixel.div(pixels).mul(w), w, w)
      return select(fires.and(w.greaterThan(0.0)).and(clipTail.w.greaterThan(0.0)), position, vec4(0.0, 0.0, 2.0, 1.0))
    })()

    // brightest at the head and dimmer down the trail, cut from the tail by the burn-out front, soft across; behind the
    // clouds and the horizon at every point of it, as the sky draws them
    material.colorNode = Fn(() => {
      const along = mix(vPath.x, vPath.y, vStreak.x)
      const train = exp(vPath.y.sub(along).div(vPath.w.mul(3.75)).negate())
      const burning = smoothstep(vPath.z.sub(vPath.w), vPath.z.add(vPath.w), along)
      const direction = normalize(mix(vTail, vHead, vStreak.x))
      const clouds = cloudOpacityToward(sky, direction).mul(smoothstep(0.0, 0.06, direction.y))
      const visible = smoothstep(0.0, 0.03, direction.y).mul(sub(1.0, clouds))
      return vLight.mul(train.mul(burning).mul(visible)).mul(exp(vStreak.y.mul(vStreak.y).mul(-4.0)))
    })()
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
