import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three/webgpu'
import type { Node, StorageBufferNode } from 'three/webgpu'
import {
  Fn, If, Loop, abs, clamp, cross, dFdx, dFdy, dot, float, instanceIndex, int, log, max, mix, normalize,
  positionGeometry, positionPrevious, positionWorld, select, smoothstep, storage, uniform, unpackHalf2x16,
  varying, vec2, vec3, vec4, vertexIndex,
} from 'three/tsl'
import { EVENT_CAPACITY, RustBake } from './RustChemistry.js'
import { steelSample } from './RustSteel.js'

/** What the stage shows: the SEM image of the volume, or debug maps of the bake (fields, steel, rust, section). */
export const RUST_FIELD_VIEWS = [
  'SEM', 'Steel', 'Electrolyte', 'pH', 'Chloride', 'Iron(II)', 'Anodic', 'Cathodic', 'Potential', 'Oxygen',
  'Rust', 'Phases', 'Iron lost', 'Nucleation', 'Section',
] as const
export type RustFieldView = typeof RUST_FIELD_VIEWS[number]
/** Views of the bake's live state (the bake then follows the playhead instead of running ahead). */
export const LIVE_FIELD_VIEWS: readonly RustFieldView[] = [
  'Electrolyte', 'pH', 'Chloride', 'Iron(II)', 'Anodic', 'Cathodic', 'Potential', 'Oxygen',
]

const linear = (hex: number) => new Color(hex).convertSRGBToLinear()
const toVec3 = (c: Color) => vec3(c.r, c.g, c.b)
/** Debug colors of the steel and the phases (sRGB hex). */
export const PHASE_COLORS = {
  steel: linear(0x8c9196), lepidocrocite: linear(0xd96b1f), goethite: linear(0xcc9e2e), akaganeite: linear(0x8c2e14),
  magnetite: linear(0x1a1a24), other: linear(0x5a3a22), water: linear(0x2a6fb8),
}

/** A three-stop ramp over `t` (0–1). */
function ramp(t: Node<'float'>, a: Color, b: Color, c: Color) {
  const x = clamp(t, 0, 1)
  return mix(mix(toVec3(a), toVec3(b), x.mul(2).min(1)), toVec3(c), x.mul(2).sub(1).max(0))
}

function log10(x: Node<'float'>) {
  return log(max(x, 1e-30)).div(Math.LN10)
}

/** Uniforms choosing what and when the surface shows. */
export type SurfaceUniforms = ReturnType<typeof createSurfaceUniforms>

export type Snapshots = StorageBufferNode<'uvec2'>

function clampInt(v: Node<'int'>, lo: number, hi: number) {
  return select(v.lessThan(lo), int(lo), select(v.greaterThan(hi), int(hi), v))
}

export function createSurfaceUniforms() {
  return {
    view: uniform(0, 'int'),
    layerA: uniform(0, 'int'),
    layerB: uniform(0, 'int'),
    weight: uniform(0),
    relief: uniform(1),
    time: uniform(0),
  }
}

/** Reads a bake's snapshot at texel `t` of layer `layer`: `(iron lost, crust)` and the phase mix (LP, GT, AK, MG). */
function readSnapshot(bake: RustBake, snapshots: Snapshots, layer: Node<'int'>, t: Node<'int'>) {
  const m = bake.snapshotSize
  const texel = snapshots.element(layer.mul(m * m).add(t))
  const heights = unpackHalf2x16(texel.x) as unknown as Node<'vec2'>
  const bits = texel.y
  const byte = (shift: number) => float(bits.shiftRight(shift).bitAnd(255)).div(255)
  return {heights, phases: vec4(byte(0), byte(8), byte(16), byte(24))}
}

/** The snapshot texel index of cell `(x, y)` of a bake. */
function snapshotTexel(bake: RustBake, x: Node<'int'>, y: Node<'int'>) {
  return y.mul(bake.snapshotSize).add(x)
}

/** The snapshot blend of cell `(x, y)` at the surface's display time: iron lost, crust and phase mix. */
export function blendedSnapshot(bake: RustBake, snapshots: Snapshots, s: SurfaceUniforms, x: Node<'int'>, y: Node<'int'>) {
  const t = snapshotTexel(bake, x, y)
  const a = readSnapshot(bake, snapshots, int(s.layerA), t)
  const b = readSnapshot(bake, snapshots, int(s.layerB), t)
  return {heights: mix(a.heights, b.heights, s.weight), phases: mix(a.phases, b.phases, s.weight)}
}

/** The rust's debug color from its phase mix (the rest is green rust and ferrihydrite). */
function phaseColor(phases: Node<'vec4'>) {
  const rest = max(float(1).sub(phases.x).sub(phases.y).sub(phases.z).sub(phases.w), 0)
  return toVec3(PHASE_COLORS.lepidocrocite).mul(phases.x)
    .add(toVec3(PHASE_COLORS.goethite).mul(phases.y))
    .add(toVec3(PHASE_COLORS.akaganeite).mul(phases.z))
    .add(toVec3(PHASE_COLORS.magnetite).mul(phases.w))
    .add(toVec3(PHASE_COLORS.other).mul(rest))
}

/**
 * The debug map of the tile: a height field with one vertex per cell, the steel at minus the iron lost and the crust
 * on top of it (from the snapshots at the display time, `relief`× exaggerated), flat-shaded, colored by `view`: the
 * live fields of the bake, or the rust. Diagnostics only: the specimen itself is drawn by the SEM volume.
 */
export class RustSurface extends Mesh<BufferGeometry, MeshBasicNodeMaterial> {

  /** Whether this mesh owns its geometry and material (a copy shares its source's). */
  private readonly owner: boolean

  constructor(bake: RustBake, s: SurfaceUniforms, steel: {seed: Node<'float'>; pearlite: Node<'float'>; inclusions: Node<'float'>},
    source?: RustSurface) {
    if (source) {
      super(source.geometry, source.material)
      this.owner = false
      this.name = 'RustSurface copy'
      this.frustumCulled = false
      return
    }
    const n = bake.grid.resolution
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * n * 3), 3))
    const index = new Uint32Array((n - 1) * (n - 1) * 6)
    let o = 0
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const i = y * n + x
        index.set([i, i + n, i + 1, i + 1, i + n, i + n + 1], o)
        o += 6
      }
    }
    geometry.setIndex(new BufferAttribute(index, 1))
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.owner = true
    this.name = 'RustSurface'
    this.frustumCulled = false
    material.name = this.name
    material.side = DoubleSide

    const snapshots = storage(bake.snapshots, 'uvec2', bake.snapshotCount * bake.snapshotSize * bake.snapshotSize).toReadOnly()
    const electro = storage(bake.electro, 'vec4', bake.cells).toReadOnly()
    const species = storage(bake.species, 'vec4', bake.cells).toReadOnly()
    const chem = storage(bake.chem, 'vec4', bake.cells).toReadOnly()
    const vColor = varying(vec3(), 'vRustColor')
    const vWorld = varying(vec3(), 'vRustWorld')

    material.positionNode = Fn(() => {
      const i = int(vertexIndex)
      const x = i.mod(n)
      const y = i.div(n)
      const X = float(x).add(0.5).mul(bake.cell).add(bake.originX)
      const Z = float(y).add(0.5).mul(bake.cell).add(bake.originZ)
      const snapshot = blendedSnapshot(bake, snapshots, s, x, y)
      const loss = snapshot.heights.x
      const crust = snapshot.heights.y
      const top = crust.sub(loss)

      const e = electro.element(i)
      const sp = species.element(i)
      const c = chem.element(i)
      const h = e.x
      const wet = h.greaterThan(0.02)
      const film = max(h, 1e-6)
      const dry = toVec3(PHASE_COLORS.steel).mul(0.25)
      const live = (value: Node<'vec3'>) => select(wet, value, dry)
      const colors: Node<'vec3'>[] = [
        // Surface
        mix(mix(toVec3(PHASE_COLORS.steel), phaseColor(snapshot.phases), smoothstep(0, 0.6, crust)),
          toVec3(PHASE_COLORS.water), smoothstep(0.3, 8, h).mul(0.6)),
        // Steel (per fragment)
        vec3(0),
        // Electrolyte: 0.01–100 µm
        live(ramp(log10(h).add(2).div(4), linear(0x0b1f3a), linear(0x2a6fb8), linear(0xd8f0ff))),
        // pH 4–11
        live(ramp(c.x.sub(4).div(7), linear(0xd9301a), linear(0x3fbf4a), linear(0x6a3dd9))),
        // Chloride 0–6 M
        live(ramp(sp.y.div(film).div(6), linear(0x10231a), linear(0x2fae8f), linear(0xeaffd8))),
        // Iron(II) 1e-4–1 M
        live(ramp(log10(sp.x.div(film)).add(4).div(4), linear(0x14101a), linear(0x2e8c3c), linear(0xb8ff7a))),
        // Anodic 1e-3–30 A/m²
        live(ramp(log10(e.z).add(3).div(4.5), linear(0x1a0d05), linear(0xd9651a), linear(0xfff08a))),
        // Cathodic 1e-3–30 A/m²
        live(ramp(log10(e.w).add(3).div(4.5), linear(0x050d1a), linear(0x1a7fd9), linear(0xc8f4ff))),
        // Potential ±0.2 V about the reference
        live(ramp(e.y.sub(0.45).div(0.4).add(0.5), linear(0x2a49d9), linear(0xf2f2f2), linear(0xd92a2a))),
        // Oxygen left 0–1
        live(ramp(c.y, linear(0x200830), linear(0x9c3fbf), linear(0xffe0ff))),
        // Rust thickness 0–40 µm
        mix(toVec3(PHASE_COLORS.steel).mul(0.4), ramp(crust.div(40), linear(0x3a1a0a), linear(0xd96b1f), linear(0xffe6b0)), smoothstep(0, 0.2, crust)),
        // Phases
        mix(toVec3(PHASE_COLORS.steel).mul(0.4), phaseColor(snapshot.phases), smoothstep(0, 0.2, crust)),
        // Iron lost 0–20 µm
        ramp(loss.div(20), linear(0x1a1a1a), linear(0x7a2ad9), linear(0xffd0f0)),
        // Nucleation (the surface under the events)
        mix(toVec3(PHASE_COLORS.steel).mul(0.5), phaseColor(snapshot.phases).mul(0.5), smoothstep(0, 0.6, crust)),
        // Section (the surface dimmed behind the slice)
        mix(toVec3(PHASE_COLORS.steel), phaseColor(snapshot.phases), smoothstep(0, 0.6, crust)).mul(0.3),
      ]
      let color: Node<'vec3'> = colors[0]
      for (let v = 1; v < colors.length; v++) color = select(s.view.equal(v), colors[v], color)
      vColor.assign(color)
      const position = vec3(X, top.mul(s.relief), Z)
      vWorld.assign(position)
      positionPrevious.assign(position)
      return position
    })()

    material.colorNode = Fn(() => {
      const normal = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)))
      const shade = abs(dot(normal, normalize(vec3(-0.45, 1, 0.3)))).mul(0.6).add(0.4)
      const grain = steelSample(vWorld.xz, steel.seed, steel.pearlite, steel.inclusions)
      const steelColor = toVec3(PHASE_COLORS.steel).mul(float(0.75).add(grain.x.mul(0.2)))
        .mul(float(1).sub(grain.y.mul(0.75))).mul(float(1).sub(grain.w.mul(0.35))).add(vec3(0.25, 0.08, 0).mul(grain.z))
      const color = select(s.view.equal(1), steelColor, vColor)
      return vec4(color.mul(shade), 1)
    })()
  }

  override dispose() {
    if (!this.owner) return
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * The nucleation events of a bake as small quads on the surface, colored by phase, those of the display time and before.
 */
export class RustEvents extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {

  constructor(bake: RustBake, s: SurfaceUniforms) {
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3))
    geometry.setIndex([0, 2, 1, 0, 3, 2])
    geometry.instanceCount = EVENT_CAPACITY
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = 'RustEvents'
    this.frustumCulled = false
    material.name = this.name
    material.side = DoubleSide

    const events = storage(bake.events, 'vec4', EVENT_CAPACITY).toReadOnly()
    const snapshots = storage(bake.snapshots, 'uvec2', bake.snapshotCount * bake.snapshotSize * bake.snapshotSize).toReadOnly()
    const vColor = varying(vec3(), 'vRustEvent')
    const palette = [PHASE_COLORS.other, PHASE_COLORS.lepidocrocite, PHASE_COLORS.goethite, PHASE_COLORS.akaganeite, linear(0x6fa8ff)]
    const n = bake.grid.resolution

    material.positionNode = Fn(() => {
      const event = events.element(instanceIndex)
      const shown = event.w.greaterThan(0.5).and(event.z.lessThanEqual(s.time))
      const phase = int(event.w).sub(1)
      let color: Node<'vec3'> = toVec3(palette[0])
      for (let k = 1; k < palette.length; k++) color = select(phase.equal(k), toVec3(palette[k]), color)
      vColor.assign(color)
      const x = clampInt(int(event.x.sub(bake.originX).div(bake.cell)), 0, n - 1)
      const y = clampInt(int(event.y.sub(bake.originZ).div(bake.cell)), 0, n - 1)
      const snapshot = blendedSnapshot(bake, snapshots, s, x, y)
      const top = snapshot.heights.y.sub(snapshot.heights.x).mul(s.relief).add(0.5)
      const size = select(shown, float(bake.cell * 0.9), float(0))
      const position = vec3(event.x, top, event.y).add(positionGeometry.mul(size))
      positionPrevious.assign(position)
      return position
    })()
    material.colorNode = vec4(vColor, 1)
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * The debug section (not in the film): a vertical cut through a bake at `z`, its steel and rust drawn from every
 * snapshot so far, `exaggeration`× in height, one band per snapshot (outer growth), colored by the phase mix of its
 * layer; to compare with the reference cross-sections.
 */
export class RustSection extends Mesh<BufferGeometry, MeshBasicNodeMaterial> {

  readonly written = uniform(1, 'int')
  readonly exaggeration = uniform(6)

  constructor(bake: RustBake, s: SurfaceUniforms, z: number) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const material = new MeshBasicNodeMaterial()
    super(geometry, material)
    this.name = 'RustSection'
    this.frustumCulled = false
    material.name = this.name
    material.side = DoubleSide

    const snapshots = storage(bake.snapshots, 'uvec2', bake.snapshotCount * bake.snapshotSize * bake.snapshotSize).toReadOnly()
    const depth = 40
    const height = 80
    const exaggeration = this.exaggeration
    const vLocal = varying(vec2(), 'vRustSection')
    const n = bake.grid.resolution
    material.positionNode = Fn(() => {
      const X = positionGeometry.x.mul(bake.grid.size).add(bake.originX)
      const Y = positionGeometry.y.mul(depth + height).sub(depth)
      vLocal.assign(vec2(X, Y))
      const position = vec3(X, Y.mul(exaggeration), z)
      positionPrevious.assign(position)
      return position
    })()
    const written = this.written
    material.colorNode = Fn(() => {
      const X = vLocal.x
      const Y = vLocal.y
      const x = clampInt(int(X.sub(bake.originX).div(bake.cell)), 0, n - 1)
      const y = clampInt(int(float(z).sub(bake.originZ).div(bake.cell)), 0, n - 1)
      const t = snapshotTexel(bake, x, y)
      const now = blendedSnapshot(bake, snapshots, s, x, y)
      const steelTop = now.heights.x.negate()
      const crustTop = now.heights.y.sub(now.heights.x)
      const band = int(-1).toVar()
      const bandPhases = vec4(0).toVar()
      Loop({start: int(0), end: int(written), type: 'int'}, ({i}) => {
        const layer = readSnapshot(bake, snapshots, i, t)
        const top = layer.heights.y.sub(layer.heights.x)
        If(band.lessThan(0).and(Y.lessThanEqual(top)).and(Y.greaterThan(steelTop)), () => {
          band.assign(i)
          bandPhases.assign(layer.phases)
        })
      })
      const parity = select(band.mod(2).equal(0), float(1), float(0.78))
      const rust = phaseColor(bandPhases).mul(parity)
      const steel = toVec3(PHASE_COLORS.steel).mul(0.8)
      const color = select(Y.lessThanEqual(steelTop), steel,
        select(Y.lessThanEqual(crustTop).and(band.greaterThanEqual(0)), rust, vec3(0.02, 0.02, 0.03)))
      return vec4(color, 1)
    })()
  }

  override dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
