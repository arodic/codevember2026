import {
  BufferAttribute, BufferGeometry, CustomBlending, HalfFloatType, type Mesh, NearestFilter, NodeMaterial, OneFactor,
  OrthographicCamera, Points, QuadMesh, RenderTarget, RendererUtils, Scene, type Texture, type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, attribute, float, int, ivec2, normalWorldGeometry, positionWorld, screenCoordinate, textureLoad, uniform,
  varying, vec4,
} from 'three/tsl'
import type Node from 'three/src/nodes/core/Node.js'
import type {RendererState} from 'three/src/renderers/common/RendererUtils.js'

/** Texels per row of a vertex light map: vertex texel `aLightTexel` sits at `(texel % width, texel / width)`. */
export const VERTEX_LIGHT_WIDTH = 2048

/** Rows a vertex light map needs for `count` vertices. */
export function vertexLightRows(count: number) {
  return Math.max(1, Math.ceil(count / VERTEX_LIGHT_WIDTH))
}

/** Gives the meshes consecutive light map texels (`aLightTexel`); returns the vertex count. */
export function assignLightTexels(meshes: Mesh[]): number {
  let next = 0
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute('position').count
    const texels = new Float32Array(count)
    for (let i = 0; i < count; i++) texels[i] = next + i
    mesh.geometry.setAttribute('aLightTexel', new BufferAttribute(texels, 1))
    next += count
  }
  return next
}

/** A vertex's value from a vertex light map (`texture`), fetched in the vertex stage and interpolated over faces. */
export function vertexLight(texture: Texture): Node<'vec3'> {
  const texel = attribute('aLightTexel', 'float')
  const coord = ivec2(int(texel.mod(VERTEX_LIGHT_WIDTH)), int(texel.div(VERTEX_LIGHT_WIDTH).floor()))
  return varying(textureLoad(texture, coord).rgb) as unknown as Node<'vec3'>
}

/**
 * Bakes diffuse irradiance per vertex, the way `LightMapper` bakes it per texel: each sample draws every vertex of
 * the meshes as a point into its own texel (`aLightTexel`, see `assignLightTexels`) and accumulates the irradiance
 * at its position and normal. Light maps of a mesh as fine as its vertices (2.5–20 cm here, finer than the VXGI
 * voxels it samples), without an atlas to unwrap. Read it back with `vertexLight`.
 */
export class VertexLightMapper {

  /** Accumulated samples. */
  samples = 0
  /** Irradiance (`lux`, linear Rec. 709) per vertex texel. */
  readonly texture: Texture

  private readonly renderer: WebGPURenderer
  private readonly accumulation: RenderTarget
  private readonly target: RenderTarget
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera()
  private readonly material: NodeMaterial
  private readonly quad: QuadMesh
  private readonly resolveMaterial: NodeMaterial
  private readonly sample = uniform(0)
  /** Reused between updates (`resetRendererState` fills it in). */
  private rendererState: RendererState | undefined
  private readonly objects: Mesh[] = []

  constructor(
    renderer: WebGPURenderer,
    rows: number,
    irradiance: (position: Node<'vec3'>, normal: Node<'vec3'>, sample: Node<'float'>) => Node<'vec3'>,
  ) {
    this.renderer = renderer
    const options = {type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false}
    this.accumulation = new RenderTarget(VERTEX_LIGHT_WIDTH, rows, options)
    this.target = new RenderTarget(VERTEX_LIGHT_WIDTH, rows, options)
    this.texture = this.target.texture

    const material = new NodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    // Additive: the sample count accumulates in alpha
    material.blending = CustomBlending
    material.blendSrc = OneFactor
    material.blendDst = OneFactor
    const texel = attribute('aLightTexel', 'float')
    const column = texel.mod(VERTEX_LIGHT_WIDTH).add(0.5).div(VERTEX_LIGHT_WIDTH)
    const row = texel.div(VERTEX_LIGHT_WIDTH).floor().add(0.5).div(rows)
    material.vertexNode = vec4(column.mul(2).sub(1), float(1).sub(row.mul(2)), 0, 1)
    material.fragmentNode = vec4(irradiance(positionWorld, normalWorldGeometry, this.sample), 1)
    this.material = material

    const accumulated = this.accumulation.texture
    const resolve = Fn(() => {
      const sum = textureLoad(accumulated, ivec2(screenCoordinate.xy))
      return vec4(sum.rgb.div(sum.a.max(1e-4)), 1)
    })
    const resolveMaterial = new NodeMaterial()
    resolveMaterial.fragmentNode = resolve()
    this.resolveMaterial = resolveMaterial
    this.quad = new QuadMesh(resolveMaterial)
  }

  /** Adds meshes with `aLightTexel` (their vertices, not their faces: each once). */
  addObjects(meshes: Mesh[]) {
    for (const mesh of meshes) {
      const source = mesh.geometry
      const geometry = new BufferGeometry()
      for (const name of ['position', 'normal', 'aLightTexel']) geometry.setAttribute(name, source.getAttribute(name))
      const points = new Points(geometry, this.material)
      points.matrixAutoUpdate = false
      points.frustumCulled = false
      this.scene.add(points)
      this.objects.push(mesh)
    }
  }

  update(samples = 1) {
    const renderer = this.renderer
    const state = this.rendererState = RendererUtils.resetRendererState(renderer, this.rendererState as RendererState)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.accumulation)
    if (this.samples === 0) renderer.clear()
    this.objects.forEach((mesh, i) => {
      mesh.updateWorldMatrix(true, false)
      this.scene.children[i].matrix.copy(mesh.matrixWorld)
    })
    for (let i = 0; i < samples; i++) {
      this.sample.value = this.samples
      renderer.render(this.scene, this.camera)
      this.samples++
    }
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
    RendererUtils.restoreRendererState(renderer, state)
  }

  reset() {
    this.samples = 0
  }

  dispose() {
    this.accumulation.dispose()
    this.target.dispose()
    this.material.dispose()
    this.resolveMaterial.dispose()
    // The point views share the meshes' attributes: disposing a view would free the meshes' buffers
    this.scene.clear()
  }
}
