import { ComputeNode, FloatType, Node, StorageTexture, Vector2, Vector3, Vector4, WebGPURenderer } from 'three/webgpu'
import {
  Fn, If, Loop, atan, clamp, cos, dot, float, instanceIndex, normalize, sin, sqrt, texture, textureStore, uniform,
  uniformArray, uvec2, vec2, vec4,
} from 'three/tsl'

type Vec2 = Node<'vec2'>

/** Harmonics of the loop's radius (the first would only move it). */
const HARMONICS = [2, 3, 4, 5] as const

/**
 * How deep the lobes are: the dominant harmonic's amplitude is this over its square, so the loop bends back between
 * its lobes (a right turn after every left one) for any number of them.
 */
const LOBE_DEPTH = 1.5

/** Samples of the loop's length, for flying it at an even speed. */
const ARC_SAMPLES = 1024

/** Points of the centerline the distance field is measured to, and texels per side of the field over the block. */
const CURVE_POINTS = 256
const FIELD_RESOLUTION = 512

/**
 * The entrenched loop of the canyon: a closed curve around `center` whose radius swells into lobes and pinches between
 * them, like a chain of horseshoe bends closing on itself (two lobes: a figure eight that never crosses), and the
 * floor the river has cut down to. A distance field over the block (`field`: distance to the centerline, offset
 * outward from it and the angle of the nearest point) is computed from it when its shape changes; the landscape
 * carves the canyon from that, and the camera flies along it at an even speed (`angleAt`).
 */
export class CanyonPath {

  /** Distance to the centerline, signed offset outward of it, cosine and sine of the nearest point's angle. */
  readonly field = new StorageTexture(FIELD_RESOLUTION, FIELD_RESOLUTION)
  /** Bumped when the loop's shape changes (its field must be computed again). */
  shapeVersion = 0
  private shapeKey = ''
  private readonly points = uniformArray(Array.from({length: CURVE_POINTS}, () => new Vector2()), 'vec2')
  private readonly fieldCompute: ComputeNode

  readonly center = new Vector2()
  /** Amplitudes, as fractions of the radius, and phases of the 2nd to 5th harmonic. */
  readonly amplitudes = new Vector4()
  readonly phases = new Vector4()
  radius = 40
  /** Height of the floor; it follows the incision as the belt rises. */
  floor = -22
  /** Half the width of the flat floor. */
  halfWidth = 7
  /** How far the walls spread beyond the floor. */
  wall = 15
  /** Length of the centerline. */
  length = 0
  /** The angle at evenly spaced fractions of the length. */
  private readonly arcAngles = new Float32Array(ARC_SAMPLES + 1)

  readonly uniforms = {
    floor: uniform(-22),
    halfWidth: uniform(7),
    wall: uniform(15),
  }

  /** `size`: width of the block the field covers. */
  constructor(readonly size: number) {
    this.field.name = 'Canyon Field'
    this.field.type = FloatType
    this.fieldCompute = this.createFieldCompute()
  }

  /** A loop of `lobes` (2 to 5) from a PRNG: where it sits, how deep its lobes are and how they wander. */
  randomize(random: () => number, lobes: number) {
    this.center.set((random() - 0.5) * 8, (random() - 0.5) * 8)
    const amplitudes = HARMONICS.map(k => k === lobes
      ? Math.min(0.36, LOBE_DEPTH / (k * k)) * (0.92 + random() * 0.16)
      : random() * 0.025)
    this.amplitudes.set(amplitudes[0], amplitudes[1], amplitudes[2], amplitudes[3])
    this.phases.set(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2)
    this.sync()
  }

  sync() {
    const u = this.uniforms
    u.floor.value = this.floor
    u.halfWidth.value = this.halfWidth
    u.wall.value = this.wall
    const key = [this.radius, ...this.center.toArray(), ...this.amplitudes.toArray(), ...this.phases.toArray()].join()
    if (key === this.shapeKey) return
    this.shapeKey = key
    this.shapeVersion++
    const points = this.points.array as Vector2[]
    const point = new Vector3()
    points.forEach((target, i) => {
      this.pointAt(i / CURVE_POINTS * Math.PI * 2, 0, point)
      target.set(point.x, point.z)
    })
    this.measure()
  }

  /** Computes the distance field of the loop (after its shape changed). */
  update(renderer: WebGPURenderer) {
    void renderer.compute(this.fieldCompute)
  }

  /** For each texel, the nearest point on the centerline's segments. */
  private createFieldCompute() {
    const points = this.points
    const field = this.field
    return Fn(() => {
      const x = instanceIndex.mod(FIELD_RESOLUTION)
      const y = instanceIndex.div(FIELD_RESOLUTION)
      const xz = vec2(float(x), float(y)).add(0.5).div(FIELD_RESOLUTION).sub(0.5).mul(this.size)
      const nearest = float(1e12).toVar()
      const angle = float(0.0).toVar()
      const offset = float(0.0).toVar()
      Loop(CURVE_POINTS, ({i}) => {
        const a = points.element(i) as unknown as Vec2
        const b = points.element(i.add(1).mod(CURVE_POINTS)) as unknown as Vec2
        const segment = b.sub(a)
        const t = clamp(dot(xz.sub(a), segment).div(dot(segment, segment)), 0.0, 1.0)
        const away = xz.sub(a.add(segment.mul(t)))
        const distance = dot(away, away)
        If(distance.lessThan(nearest), () => {
          nearest.assign(distance)
          angle.assign(float(i).add(t).div(CURVE_POINTS).mul(Math.PI * 2))
          offset.assign(dot(away, normalize(vec2(segment.y, segment.x.negate()))))
        })
      })
      textureStore(field, uvec2(x, y), vec4(sqrt(nearest), offset, cos(angle), sin(angle))).toWriteOnly()
    })().compute(FIELD_RESOLUTION * FIELD_RESOLUTION)
  }

  radiusAt(angle: number) {
    const a = this.amplitudes
    const p = this.phases
    return this.radius * (1 + a.x * Math.cos(2 * angle + p.x) + a.y * Math.cos(3 * angle + p.y) + a.z * Math.cos(4 * angle + p.z) + a.w * Math.cos(5 * angle + p.w))
  }

  /** A point on the loop at `height`, `offset` outward from the centerline. */
  pointAt(angle: number, height: number, target: Vector3, offset = 0) {
    const r = this.radiusAt(angle) + offset
    return target.set(this.center.x + r * Math.cos(angle), height, this.center.y + r * Math.sin(angle))
  }

  /** The angle `fraction` of the way around the loop by length. */
  angleAt(fraction: number) {
    const position = (((fraction % 1) + 1) % 1) * ARC_SAMPLES
    const i = Math.floor(position)
    return this.arcAngles[i] + (this.arcAngles[i + 1] - this.arcAngles[i]) * (position - i)
  }

  /** Tabulates the angle at even steps of length around the loop. */
  private measure() {
    const lengths = new Float32Array(ARC_SAMPLES + 1)
    const a = new Vector3()
    const b = new Vector3()
    this.pointAt(0, 0, a)
    for (let i = 1; i <= ARC_SAMPLES; i++) {
      this.pointAt(i / ARC_SAMPLES * Math.PI * 2, 0, b)
      lengths[i] = lengths[i - 1] + a.distanceTo(b)
      a.copy(b)
    }
    this.length = lengths[ARC_SAMPLES]
    let j = 0
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const target = i / ARC_SAMPLES * this.length
      while (j < ARC_SAMPLES - 1 && lengths[j + 1] < target) j++
      const t = (target - lengths[j]) / Math.max(lengths[j + 1] - lengths[j], 1e-9)
      this.arcAngles[i] = (j + Math.min(Math.max(t, 0), 1)) / ARC_SAMPLES * Math.PI * 2
    }
  }

  /** Where a map position sits relative to the loop: the angle of the nearest point, how far outward of it, how far. */
  coordinates(xz: Vec2) {
    const sample = texture(this.field, xz.div(this.size).add(0.5)).level(float(0))
    return {angle: atan(sample.w, sample.z), offset: sample.y, distance: sample.x}
  }
}
