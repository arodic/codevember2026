import {
  BoxGeometry, Color, ComputeNode, FrontSide, Mesh, MeshBasicNodeMaterial, RepeatWrapping, Storage3DTexture,
  WebGPURenderer,
} from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  Break, Fn, If, Loop, abs, cameraPosition, clamp, cos, float, floor, hash, instanceIndex, int, ivec3, max, min, mix,
  mx_noise_float, positionWorld, screenCoordinate, select, sin, smoothstep, storage, storageTexture3D, texture3D, uint,
  uniform, uvec3, vec2, vec3, vec4,
} from 'three/tsl'
import { TILE_SIZE } from './RustSalt.js'
import { steelScratch } from './RustSteel.js'
import {
  BIRTH_SHIFT, BRICK, CRYSTAL, DEATH_SHIFT, KIND_MASK, MATRIX_BASE, RustVolume, STEEL, STEEL_LAYERS, TICK_MASK,
  VOLUME_BOTTOM, VOLUME_LAYERS, VOLUME_SIZE, VOLUME_TOP, VOXEL,
} from './RustVolume.js'

/** How far the specimen extends past the tile: its repeats each way, for wide views. */
const REPEATS = 3
/** March step (µm) through bricks with something in them. */
const STEP = VOXEL * 0.5
/** Ticks a voxel takes to grow in or go (its occupancy ramps over them): growth streams instead of popping. */
const GROW_TICKS = 3
/** Direction toward the Everhart–Thornley detector, off to the side and above: what faces away from it is darker. */
const DETECTOR = new Color(-0.55, 0.62, -0.56)
/**
 * The smooth density the surface is drawn from: each voxel there weighs `(1 − d²/KERNEL_REACH²)³` at `d` voxels over
 * its 3×3×3 neighbourhood, and the surface is where the weights sum to `SURFACE`: steps between columns become slopes
 * and corners round off, while two touching voxels still show (a crust's face sits ~0.4 voxel out). Stored as rgba8
 * up to `DENSITY_RANGE` (rust, steel, crystals).
 */
const KERNEL_REACH = 2
const SURFACE = 1.4
const DENSITY_RANGE = 4
/** The density's change across a surface per voxel: densities to distance (µm) for the sphere tracing. */
const DENSITY_SLOPE = 2
/** Fine-grained rust's granular texture under the voxels: amplitude (density) and grain (µm). */
const GRAIN = 0.45
const GRAIN_SIZE = 0.6
/** The density is redrawn when the playhead has moved this many ticks (its ramps are `GROW_TICKS` long). */
const REDRAW_TICKS = 0.25

const linear = (hex: number) => new Color(hex).convertSRGBToLinear()
/** False colors of the phases (colorized-SEM style), by volume phase, and of the steel. */
const PHASE_TINTS = [
  linear(0x5f8f5a), linear(0x8a4a24), linear(0xe08a32), linear(0xd2a63c), linear(0xb63a1e), linear(0x3a4050),
]
const STEEL_TINT = linear(0x9aa6b8)

/** How present a voxel `v` at layer `z` is at `tick` (0–1), whether it shows as steel, whether it is a crystal's. */
function presence(v: Node<'uint'>, z: Node<'int'>, tick: Node<'float'>) {
  const kind = v.bitAnd(KIND_MASK)
  const birth = float(v.shiftRight(BIRTH_SHIFT).bitAnd(TICK_MASK))
  const death = float(v.shiftRight(DEATH_SHIFT))
  const born = select(birth.equal(0), float(1), clamp(tick.sub(birth.sub(1)).div(GROW_TICKS), 0, 1))
  const gone = select(death.equal(0), float(0), clamp(tick.sub(death.sub(1)).div(GROW_TICKS), 0, 1))
  // rust in a pit: steel there until it formed
  const pitted = z.lessThan(STEEL_LAYERS).and(kind.notEqual(STEEL)).and(kind.greaterThan(0))
  const value = select(kind.equal(0), float(0), select(pitted, float(1), born.mul(float(1).sub(gone))))
  const steel = kind.equal(STEEL).or(pitted.and(born.lessThan(0.5)))
  return {value, steel, crystal: kind.bitAnd(CRYSTAL).greaterThan(0).and(steel.not())}
}

/**
 * The specimen as an SEM shows it: the volume at the playhead (`tick`). Each time the playhead moves, a compute pass
 * redraws a smooth density of the voxels there (each voxel growing in, or going, over `GROW_TICKS`; rust that grew
 * into a pit was steel there until it formed): fine-grained rust, steel, crystals. A ray walks the volume brick by
 * brick, skipping bricks with nothing born yet, then samples the density (hardware-filtered) until it is inside,
 * and sphere-traces the surface: the density's isosurface with a granular texture for the rust, the habit of each
 * crystal (needles, plates, octahedra) from its voxels. Shading follows secondary-electron imaging: the yield rises
 * with tilt (1/cos θ), thin edges and tips brighten, faces turned from the detector and deep pockets darken; the
 * phases blended around the point set the false color, the steel shows its grinding scratches. The tile repeats
 * `REPEATS`× each way.
 */
export class RustSEM extends Mesh<BoxGeometry, MeshBasicNodeMaterial> {

  /** The playhead in growth ticks (fractional). */
  readonly tick = uniform(0)
  /** The smooth density of the voxels at `tick`: (rust, steel, crystals) / `DENSITY_RANGE`. */
  readonly density: Storage3DTexture
  private readonly densityNode: ComputeNode
  private drawnTick = -1

  constructor(volume: RustVolume, steel: {seed: Node<'float'>}) {
    const width = TILE_SIZE * REPEATS
    const height = VOLUME_TOP - VOLUME_BOTTOM
    const geometry = new BoxGeometry(width, height, width)
    geometry.translate(0, VOLUME_BOTTOM + height / 2, 0)
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = 'RustSEM'
    this.frustumCulled = false
    material.name = this.name
    material.side = FrontSide

    const n = VOLUME_SIZE
    const L = VOLUME_LAYERS
    const density = new Storage3DTexture(n, n, L)
    density.wrapS = density.wrapT = RepeatWrapping
    density.generateMipmaps = false
    this.density = density
    this.densityNode = this.buildDensity(volume)

    const nb = n / BRICK
    const brickSize = BRICK * VOXEL
    const voxels = texture3D(volume.texture)
    const smooth = texture3D(density)
    const bricks = storage(volume.bricks, 'uint', volume.brickCount).toReadOnly()
    const clusters = storage(volume.clusters, 'vec4', n * n * 2).toReadOnly()
    const tick = this.tick

    /** The voxel at integer coordinates (column wrapped; under the volume, steel). */
    const voxelAt = (x: Node<'int'>, y: Node<'int'>, z: Node<'int'>) => {
      const zc = select(z.lessThan(0), int(0), select(z.greaterThan(L - 1), int(L - 1), z))
      const v = voxels.load(ivec3(x.mod(n).add(n).mod(n), y.mod(n).add(n).mod(n), zc)).x as unknown as Node<'uint'>
      return select(z.lessThan(0), uint(STEEL), select(z.greaterThan(L - 1), uint(0), v))
    }
    /** Voxel coordinates (fractional, centres at .5) of world `p`. */
    const toVoxel = (p: Node<'vec3'>) => vec3(p.x.add(TILE_SIZE / 2), p.y.sub(VOLUME_BOTTOM), p.z.add(TILE_SIZE / 2)).div(VOXEL)
    /** The density at `p`: (rust, steel, crystals). */
    const densityAt = (p: Node<'vec3'>) => {
      const g = toVoxel(p)
      return smooth.sample(vec3(g.x.div(n), g.z.div(n), g.y.div(L))).level(float(0)).xyz.mul(DENSITY_RANGE)
    }
    /**
     * The distance (µm) from `local` (relative to its voxel's centre) to a crystal voxel of the crystal nucleated at
     * column `col`: needles (goethite, akaganeite) elongated away from the nucleus, plates (lepidocrocite: the rosette
     * plate it lies in; green rust: across the axis) thin across their plane, octahedra (magnetite) in the frame.
     */
    const crystalShape = (col: Node<'int'>, centre: Node<'vec3'>, local: Node<'vec3'>, grown: Node<'float'>) => {
      const c0 = clusters.element(col.mul(2)).toVar()
      const c1 = clusters.element(col.mul(2).add(1)).toVar()
      const phase = int(c0.w).sub(1)
      const axis = c1.xyz.normalize().toVar()
      const helper = select(abs(axis.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0))
      const tangent = helper.cross(axis).normalize()
      const t = tangent.mul(cos(c1.w)).add(axis.cross(tangent).mul(sin(c1.w))).toVar()
      const b = axis.cross(t).toVar()
      const offset = centre.sub(c0.xyz).toVar()
      offset.assign(vec3(offset.x.sub(floor(offset.x.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE)), offset.y,
        offset.z.sub(floor(offset.z.div(TILE_SIZE).add(0.5)).mul(TILE_SIZE))))
      const dir = select(offset.length().lessThan(VOXEL * 0.3), axis, offset.normalize()).toVar()
      const size = grown.sqrt().mul(VOXEL)
      // needle: long along the radial direction
      const along = local.dot(dir)
      const across = local.sub(dir.mul(along)).length()
      const needle = vec2(along.div(size.mul(1.1)), across.div(size.mul(0.34))).length().sub(1).mul(size.mul(0.34))
      // plate: thin across the plate it lies in
      const at = dir.dot(t).abs()
      const aa = dir.dot(axis).abs()
      const ab = dir.dot(b).abs()
      const rosette = select(at.lessThan(aa).and(at.lessThan(ab)), t, select(aa.lessThan(ab), axis, b))
      const normal = select(phase.equal(0), axis, rosette)
      const off = local.dot(normal)
      const inPlane = local.sub(normal.mul(off)).length()
      const plate = vec2(inPlane.div(size.mul(1.05)), off.div(size.mul(0.3))).length().sub(1).mul(size.mul(0.3))
      // octahedron
      const octahedron = local.dot(t).abs().add(local.dot(axis).abs()).add(local.dot(b).abs()).sub(size.mul(1.05)).mul(0.577)
      return select(phase.equal(3).or(phase.equal(4)), needle, select(phase.equal(5), octahedron, plate))
    }
    /** The distance (µm) to the crystal voxels among the eight around `p`. */
    const crystalsNear = (p: Node<'vec3'>) => {
      const g = toVoxel(p).sub(0.5)
      const base = floor(g)
      const nearest = float(VOXEL * 2).toVar()
      for (let dz = 0; dz < 2; dz++) {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const vx = int(base.x).add(dx)
            const vy = int(base.z).add(dz)
            const vz = int(base.y).add(dy)
            const v = voxelAt(vx, vy, vz).toVar()
            const state = presence(v, vz, tick)
            If(state.crystal.and(state.value.greaterThan(0.02)), () => {
              const kind = v.bitAnd(KIND_MASK)
              const col = vy.add(int(kind.shiftRight(5).bitAnd(31))).sub(16).mod(n).add(n).mod(n).mul(n)
                .add(vx.add(int(kind.bitAnd(31))).sub(16).mod(n).add(n).mod(n))
              const centre = vec3(float(vx).add(0.5), float(vz).add(0.5), float(vy).add(0.5)).mul(VOXEL)
                .add(vec3(-TILE_SIZE / 2, VOLUME_BOTTOM, -TILE_SIZE / 2))
              nearest.assign(min(nearest, crystalShape(col, centre, p.sub(centre), state.value)))
            })
          }
        }
      }
      return nearest
    }
    /**
     * The surface as a distance (µm, negative inside): the density's isosurface, grainy where it is rust; the crystal
     * voxels' habits where there are any.
     */
    const field = (p: Node<'vec3'>) => {
      const d = densityAt(p).toVar()
      const grain = mx_noise_float(p.div(GRAIN_SIZE)).mul(GRAIN).mul(smoothstep(0.1, 0.8, d.x))
      const surface = min(float(SURFACE).sub(d.x).sub(grain), float(SURFACE).sub(d.y)).mul(VOXEL / DENSITY_SLOPE).toVar()
      If(d.z.greaterThan(0.05), () => {
        surface.assign(min(surface, crystalsNear(p)))
      })
      return surface
    }
    const solidAt = (p: Node<'vec3'>) => field(p).lessThan(0)

    material.colorNode = Fn(() => {
      const rd = positionWorld.sub(cameraPosition).normalize().toVar()
      const p = positionWorld.toVar()
      const hit = int(0).toVar()
      const last = p.toVar()
      const half = TILE_SIZE * REPEATS / 2

      Loop({start: 0, end: 240, type: 'int', condition: '<'}, () => {
        If(abs(p.x).greaterThan(half).or(abs(p.z).greaterThan(half)), () => {
          Break()
        })
        If(p.y.greaterThan(VOLUME_TOP), () => {
          If(rd.y.greaterThanEqual(-1e-4), () => {
            Break()
          })
          p.addAssign(rd.mul(p.y.sub(VOLUME_TOP).div(rd.y.negate()).add(1e-3)))
          last.assign(p)
        }).ElseIf(p.y.lessThan(VOLUME_BOTTOM), () => {
          hit.assign(1)
          Break()
        }).Else(() => {
          const g = toVoxel(p)
          const vx = int(floor(g.x))
          const vy = int(floor(g.z))
          const vz = int(floor(g.y))
          const brick = vz.div(BRICK).mul(nb * nb).add(vy.mod(n).add(n).mod(n).div(BRICK).mul(nb)).add(vx.mod(n).add(n).mod(n).div(BRICK))
          If(float(bricks.element(brick)).greaterThan(tick), () => {
            // nothing born in this brick yet: to its far side
            const lo = vec3(floor(p.x.add(TILE_SIZE / 2).div(brickSize)).mul(brickSize).sub(TILE_SIZE / 2),
              floor(p.y.sub(VOLUME_BOTTOM).div(brickSize)).mul(brickSize).add(VOLUME_BOTTOM),
              floor(p.z.add(TILE_SIZE / 2).div(brickSize)).mul(brickSize).sub(TILE_SIZE / 2))
            const hi = lo.add(brickSize)
            const exit = (d: Node<'float'>, from: Node<'float'>, low: Node<'float'>, high: Node<'float'>) =>
              select(d.greaterThan(0), high.sub(from), low.sub(from)).div(select(abs(d).lessThan(1e-6), float(1e-6), d))
            const t = min(min(exit(rd.x, p.x, lo.x, hi.x), exit(rd.y, p.y, lo.y, hi.y)), exit(rd.z, p.z, lo.z, hi.z))
            p.addAssign(rd.mul(max(t, 0).add(0.02)))
            // the density of rust next door reaches a voxel or two into the empty brick: refine from before it
            last.assign(p.sub(rd.mul(VOXEL * 2)))
          }).Else(() => {
            const d = densityAt(p)
            If(d.x.add(GRAIN).greaterThan(SURFACE).or(d.y.greaterThan(SURFACE)).or(d.z.greaterThan(0.3)), () => {
              hit.assign(1)
              Break()
            })
            last.assign(p)
            p.addAssign(rd.mul(STEP))
          })
        })
      })

      const color = vec3(0.012, 0.012, 0.016).toVar()
      const view = rd.negate()
      const detector = vec3(DETECTOR.r, DETECTOR.g, DETECTOR.b).normalize()

      If(hit.equal(1), () => {
        // sphere-trace the surface from a little before where the march found it
        const q = last.sub(rd.mul(VOXEL * 0.5)).toVar()
        for (let k = 0; k < 14; k++) {
          const d = field(q)
          q.addAssign(rd.mul(max(d.mul(0.9), VOXEL * 0.02)))
        }
        // the normal from the field's gradient
        const e = VOXEL * 0.25
        const gradient = vec3(
          field(q.add(vec3(e, 0, 0))).sub(field(q.sub(vec3(e, 0, 0)))),
          field(q.add(vec3(0, e, 0))).sub(field(q.sub(vec3(0, e, 0)))),
          field(q.add(vec3(0, 0, e))).sub(field(q.sub(vec3(0, 0, e)))),
        )
        const normal = select(gradient.length().lessThan(1e-6), vec3(0, 1, 0), gradient.normalize()).toVar()
        // what it is: steel, or the phases of the voxels around (crystals by their crystal's), blended
        const inside = q.sub(normal.mul(VOXEL * 0.4))
        const d = densityAt(inside)
        const isSteel = d.y.greaterThan(d.x.add(d.z)).toVar()
        const g = toVoxel(inside).sub(0.5)
        const base = floor(g)
        const t = g.sub(base)
        const tint = vec3(0).toVar()
        const weight = float(1e-4).toVar()
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const vx = int(base.x).add(dx)
              const vy = int(base.z).add(dz)
              const vz = int(base.y).add(dy)
              const v = voxelAt(vx, vy, vz).toVar()
              const state = presence(v, vz, tick)
              const kind = v.bitAnd(KIND_MASK)
              const cx = vx.add(int(kind.bitAnd(31))).sub(16).mod(n).add(n).mod(n)
              const cy = vy.add(int(kind.shiftRight(5).bitAnd(31))).sub(16).mod(n).add(n).mod(n)
              const phase = select(state.crystal, int(clusters.element(cy.mul(n).add(cx).mul(2)).w).sub(1), int(kind).sub(MATRIX_BASE))
              const w = (dx ? t.x : float(1).sub(t.x)).mul(dy ? t.y : float(1).sub(t.y)).mul(dz ? t.z : float(1).sub(t.z))
                .mul(select(state.steel.or(kind.equal(0)), float(0), state.value)).toVar()
              PHASE_TINTS.forEach((c, k) => {
                If(phase.equal(k), () => {
                  tint.addAssign(vec3(c.r, c.g, c.b).mul(w))
                  weight.addAssign(w)
                })
              })
            }
          }
        }
        tint.assign(select(isSteel.or(weight.lessThan(0.01)), vec3(STEEL_TINT.r, STEEL_TINT.g, STEEL_TINT.b), tint.div(weight)))
        // the bare metal's grinding scratches tilt its normal a little
        const scratch = steelScratch(q.xz, steel.seed)
        const shaded = select(isSteel, normal.add(vec3(scratch.mul(0.05), 0, scratch.mul(0.02))).normalize(), normal).toVar()
        // secondary electrons: tilt, thin edges, the detector's side, pockets
        const cosT = max(shaded.dot(view), 0.08)
        const tilt = float(1).div(cosT).pow(0.75)
        const thin = smoothstep(-0.2, 0.25, field(q.sub(normal.mul(1.1))))
        const facing = shaded.dot(detector).mul(0.5).add(0.5)
        const open = smoothstep(0.3, -0.3, field(q.add(normal.mul(1.5)))).add(smoothstep(0.3, -0.3, field(q.add(normal.mul(3.5)))))
        const pocket = float(1).sub(open.mul(0.3))
        const shadow = select(solidAt(q.add(detector.mul(2.5))), float(0.7), float(1))
        const brightness = tilt.mul(0.32).add(thin.mul(0.45)).add(0.04).mul(facing.mul(0.6).add(0.5)).mul(pocket).mul(shadow)
          .mul(select(isSteel, float(0.85), float(1)))
        color.assign(mix(vec3(brightness), tint.mul(brightness).mul(1.5), select(isSteel, float(0.3), float(0.5))))
      })

      // detector noise
      const grain = hash(uint(screenCoordinate.x).mul(73856093).bitXor(uint(screenCoordinate.y).mul(19349663))).sub(0.5)
      return color.add(color.mul(grain).mul(0.12)).max(0)
    })()
  }

  /** Redraws the density when the playhead (`tick`) has moved, or `force`d (the volume changed near it). */
  update(renderer: WebGPURenderer, force = false) {
    const tick = this.tick.value
    if (!force && Math.abs(tick - this.drawnTick) < REDRAW_TICKS) return
    this.drawnTick = tick
    void renderer.compute(this.densityNode)
  }

  /**
   * The smooth density of the voxels at the playhead, one thread per voxel over its 3×3×3 neighbourhood; a voxel whose
   * neighbourhood lies in bricks with nothing born yet (the air over the rust) is empty without looking.
   */
  private buildDensity(volume: RustVolume): ComputeNode {
    const n = VOLUME_SIZE
    const L = VOLUME_LAYERS
    const nb = n / BRICK
    const voxels = storageTexture3D(volume.texture).toReadOnly()
    const bricks = storage(volume.bricks, 'uint', volume.brickCount).toReadOnly()
    const out = storageTexture3D(this.density).toWriteOnly()
    const tick = this.tick
    return Fn(() => {
      const i = int(instanceIndex)
      const x = i.mod(n)
      const y = i.div(n).mod(n)
      const z = i.div(n * n)
      const sum = vec3(0).toVar()
      // the bricks of the neighbourhood's corners: all with nothing born yet, nothing to sum
      const born = float(1e9).toVar()
      for (const cz of [-1, 1]) {
        for (const cy of [-1, 1]) {
          for (const cx of [-1, 1]) {
            const bz = select(z.add(cz).lessThan(0), int(0), select(z.add(cz).greaterThan(L - 1), int(L - 1), z.add(cz))).div(BRICK)
            const by = y.add(cy + n).mod(n).div(BRICK)
            const bx = x.add(cx + n).mod(n).div(BRICK)
            born.assign(min(born, float(bricks.element(bz.mul(nb * nb).add(by.mul(nb)).add(bx)))))
          }
        }
      }
      If(born.lessThanEqual(tick), () => {
        this.sumDensity(voxels, x, y, z, sum)
      })
      out.store(uvec3(uint(x), uint(y), uint(z)), vec4(sum.div(DENSITY_RANGE), 0))
    })().compute(n * n * L) as ComputeNode
  }

  /** Adds the 3×3×3 neighbourhood of voxel (`x`, `y`, `z`) to `sum` by the kernel: (rust, steel, crystals). */
  private sumDensity(voxels: ReturnType<typeof storageTexture3D>, x: Node<'int'>, y: Node<'int'>, z: Node<'int'>, sum: Node<'vec3'>) {
    const n = VOLUME_SIZE
    const L = VOLUME_LAYERS
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = (1 - (dx * dx + dy * dy + dz * dz) / (KERNEL_REACH * KERNEL_REACH)) ** 3
          const zz = z.add(dz)
          const layer = select(zz.lessThan(0), int(0), select(zz.greaterThan(L - 1), int(L - 1), zz))
          const texel = uvec3(uint(x.add(dx + n).mod(n)), uint(y.add(dy + n).mod(n)), uint(layer))
          const loaded = voxels.load(texel).x as unknown as Node<'uint'>
          const v = select(zz.lessThan(0), uint(STEEL), select(zz.greaterThan(L - 1), uint(0), loaded)).toVar()
          const state = presence(v, zz, this.tick)
          const rust = state.steel.or(state.crystal).not()
          sum.addAssign(vec3(select(rust, state.value, float(0)), select(state.steel, state.value, float(0)),
            select(state.crystal, state.value, float(0))).mul(w))
        }
      }
    }
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.density.dispose()
    this.densityNode.dispose()
  }
}
