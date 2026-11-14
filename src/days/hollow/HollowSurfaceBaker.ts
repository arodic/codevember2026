import {
  BufferGeometry, LinearFilter, Mesh, Node, NodeMaterial, OrthographicCamera, Points, QuadMesh, RenderTarget, RendererUtils, Scene,
  Texture, UnsignedByteType, WebGPURenderer,
} from 'three/webgpu'
import {Fn, float, ivec2, screenCoordinate, select, textureLoad, vec4} from 'three/tsl'
import {ATLAS_SIZE} from './HollowChunks.js'
import {type HollowSurfaceControls, type HollowSurfaceMaps, createHollowSurfaceBake} from './HollowSurface.js'

type RendererState = ReturnType<typeof RendererUtils.resetRendererState>


/** Passes that grow the charts into their padding (`ATLAS_PAD` and the filter's reach beyond). */
const DILATIONS = 3
/** The map names, as the bake material's outputs and the render target's textures. */
const MAPS = ['albedo', 'surface', 'normal'] as const
const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const

/**
 * Whether a texel of the normal map holds a normal: an encoded unit normal (`n * 0.5 + 0.5`) is at least
 * `(√3 − 1) / 2` long, the cleared texels are black. (Its alpha can't mark it: an MRT clear leaves it `1`.)
 */
function isCovered(normal: Node<'vec4'>) {
  return normal.xyz.length().greaterThan(0.15)
}

/**
 * Bakes the cave's surface (`hollowSurfaceNodes`) into its maps over the atlas (`buildHollowChunks`): draws the
 * chunks at their `uv` into a target of three textures, then grows each chart a texel per pass into its padding (each
 * empty texel the mean of its covered neighbours), so filtering at a chart's edge reads the chart. A bake is a draw
 * of the surface and a few full-target passes: redone whenever the surface's dials change.
 */
export class HollowSurfaceBaker {

  readonly target: RenderTarget
  private readonly scratch: RenderTarget
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera()
  private readonly material: NodeMaterial
  private readonly dilations: QuadMesh[]
  private readonly dilationMaterials: NodeMaterial[]
  private state: RendererState | undefined

  constructor(controls: HollowSurfaceControls) {
    const options = {
      type: UnsignedByteType, depthBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter,
    }
    this.target = new RenderTarget(ATLAS_SIZE, ATLAS_SIZE, {...options, count: MAPS.length})
    MAPS.forEach((name, i) => {
      this.target.textures[i].name = name
    })
    this.scratch = new RenderTarget(ATLAS_SIZE, ATLAS_SIZE, options)
    this.material = createHollowSurfaceBake(controls)

    const coverage = this.target.textures[MAPS.indexOf('normal')]
    this.dilationMaterials = this.target.textures.map((map) => {
      const material = new NodeMaterial()
      material.name = `Hollow Surface Dilation (${map.name})`
      material.depthTest = false
      material.depthWrite = false
      material.fragmentNode = Fn(() => {
        const coord = ivec2(screenCoordinate.xy)
        const own = textureLoad(map, coord)
        let sum: Node<'vec4'> = vec4(0)
        let weight: Node<'float'> = float(0)
        for (const [dx, dy] of NEIGHBOURS) {
          // (Past the atlas' edge a load reads nothing covered: the charts keep off it)
          const at = coord.add(ivec2(dx, dy))
          const covered = isCovered(textureLoad(coverage, at)).select(float(1), float(0))
          sum = sum.add(textureLoad(map, at).mul(covered))
          weight = weight.add(covered)
        }
        const filled = isCovered(textureLoad(coverage, coord)).or(weight.equal(0))
        return select(filled, own, sum.div(weight.max(1)))
      })()
      return material
    })
    this.dilations = this.dilationMaterials.map(material => new QuadMesh(material))
  }

  /** The baked maps (the target's textures: they stay the same textures across bakes). */
  get maps(): HollowSurfaceMaps {
    const [albedo, surface, normal] = this.target.textures as [Texture, Texture, Texture]
    return {albedo, surface, normal}
  }

  /**
   * The geometries to bake: the cave's chunks with their zones (`HollowChunks.bake`). Their vertices first, as points:
   * a chart too small to hold a texel's centre in any face still gets its corners' texels, for the dilation to grow.
   */
  setGeometries(geometries: BufferGeometry[]) {
    this.scene.clear()
    for (const geometry of geometries) {
      for (const object of [new Points(geometry, this.material), new Mesh(geometry, this.material)]) {
        object.frustumCulled = false
        object.matrixAutoUpdate = false
        object.renderOrder = object instanceof Points ? 0 : 1
        this.scene.add(object)
      }
    }
  }

  bake(renderer: WebGPURenderer) {
    const state = this.state = RendererUtils.resetRendererState(renderer, this.state as RendererState)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    // Albedo and surface grow over the coverage before the normal (which marks it) does
    for (let pass = 0; pass < DILATIONS; pass++) {
      this.dilations.forEach((quad, i) => {
        renderer.setRenderTarget(this.scratch)
        quad.render(renderer)
        renderer.copyTextureToTexture(this.scratch.texture, this.target.textures[i])
      })
    }
    RendererUtils.restoreRendererState(renderer, state)
  }

  dispose() {
    this.target.dispose()
    this.scratch.dispose()
    this.material.dispose()
    for (const material of this.dilationMaterials) material.dispose()
    // The bake meshes share the chunks' attributes: the chunks dispose them
    this.scene.clear()
  }
}
