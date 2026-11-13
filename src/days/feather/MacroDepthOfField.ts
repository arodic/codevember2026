import { Register, Property } from '@io-gui/core'
import {
  HalfFloatType, LinearFilter, MathUtils, Node, NodeBuilder, NodeFrame, NodeMaterial, NodeUpdateType, PerspectiveCamera,
  QuadMesh, RenderTarget, RendererUtils, TextureNode, Vector2, WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, Loop, clamp, context, convertToTexture, float, max, min, mix, select, smoothstep, texture, uniform,
  uniformArray, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { Effect, EffectContext, EffectInstance, EffectProps } from '@io-gui/three'

const _quadMesh = new QuadMesh(new NodeMaterial())
let _rendererState: RendererUtils.RendererState

const DISC_SAMPLES = 48
const TILE_DILATE_SAMPLES = 16
const MAX_COC_PIXELS = 46

function buildVogelDisc(count: number): Vector2[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const points: Vector2[] = []
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count)
    const theta = i * goldenAngle
    points.push(new Vector2(r * Math.cos(theta), r * Math.sin(theta)))
  }
  return points
}

/**
 * Custom multi-pass optical macro Depth-of-Field TSL node:
 * 1. Full-res `cocRT`: evaluates closest 5-tap cross depth so `1.35 px` anti-aliased focal hairs get a continuous
 *    unbroken `CoC ≈ 0` corridor (zero dotted-hair fringes against the far backdrop).
 * 2. Half-res `prefilterRT`: 9-tap tent prefilter of color + CoC so wide Vogel bokeh gathers never stipple on thin hairs.
 * 3. Half-res `nearTileRT`: dilates foreground negative CoC so near out-of-focus barbs veil smoothly over behind layers.
 * 4. Half-res `farBlurRT` & `nearBlurRT`: 48-tap CoC-weighted Vogel optical disc gathers.
 * 5. Full-res `compositeRT`: 9-tap tent post-filter upsample + crisp focal-strand preservation.
 */
class MacroDofNode extends Node {

  static get type() {
    return 'MacroDofNode'
  }

  readonly textureNode: TextureNode
  readonly viewZNode: Node<'float'>
  readonly focusDistanceUniform = uniform(5.65)
  readonly lensScaleUniform = uniform(0.08)
  readonly maxBokehPixelsUniform = uniform(MAX_COC_PIXELS)
  readonly bypassUniform = uniform(0)

  private readonly invFullSize = uniform(new Vector2(1 / 1920, 1 / 1080))
  private readonly invHalfSize = uniform(new Vector2(2 / 1920, 2 / 1080))
  private readonly fullHeightPx = uniform(1080)

  private readonly cocRT: RenderTarget
  private readonly prefilterRT: RenderTarget
  private readonly nearTileRT: RenderTarget
  private readonly farBlurRT: RenderTarget
  private readonly nearBlurRT: RenderTarget
  private readonly compositeRT: RenderTarget

  private readonly cocMaterial = new NodeMaterial()
  private readonly prefilterMaterial = new NodeMaterial()
  private readonly nearTileMaterial = new NodeMaterial()
  private readonly farBlurMaterial = new NodeMaterial()
  private readonly nearBlurMaterial = new NodeMaterial()
  private readonly compositeMaterial = new NodeMaterial()

  private readonly cocTexNode: TextureNode
  private readonly prefilterTexNode: TextureNode
  private readonly nearTileTexNode: TextureNode
  private readonly farBlurTexNode: TextureNode
  private readonly nearBlurTexNode: TextureNode
  private readonly outputTexNode: TextureNode

  constructor(textureNode: TextureNode, viewZNode: Node<'float'>) {
    super('vec4')
    this.textureNode = textureNode
    this.viewZNode = viewZNode

    const rtOpts = {depthBuffer: false, type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter}
    this.cocRT = new RenderTarget(1, 1, rtOpts)
    this.prefilterRT = new RenderTarget(1, 1, rtOpts)
    this.nearTileRT = new RenderTarget(1, 1, rtOpts)
    this.farBlurRT = new RenderTarget(1, 1, rtOpts)
    this.nearBlurRT = new RenderTarget(1, 1, rtOpts)
    this.compositeRT = new RenderTarget(1, 1, rtOpts)

    this.cocTexNode = texture(this.cocRT.texture)
    this.prefilterTexNode = texture(this.prefilterRT.texture)
    this.nearTileTexNode = texture(this.nearTileRT.texture)
    this.farBlurTexNode = texture(this.farBlurRT.texture)
    this.nearBlurTexNode = texture(this.nearBlurRT.texture)
    this.outputTexNode = texture(this.compositeRT.texture)

    this.updateBeforeType = NodeUpdateType.FRAME
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    const hw = Math.max(1, Math.round(w * 0.5))
    const hh = Math.max(1, Math.round(h * 0.5))

    this.fullHeightPx.value = h
    this.invFullSize.value.set(1 / w, 1 / h)
    this.invHalfSize.value.set(1 / hw, 1 / hh)

    this.cocRT.setSize(w, h)
    this.compositeRT.setSize(w, h)
    this.prefilterRT.setSize(hw, hh)
    this.nearTileRT.setSize(hw, hh)
    this.farBlurRT.setSize(hw, hh)
    this.nearBlurRT.setSize(hw, hh)
  }

  override updateBefore(frame: NodeFrame): undefined {
    if (this.bypassUniform.value > 0.5 || this.lensScaleUniform.value <= 1e-6) return
    const renderer = frame.renderer as WebGPURenderer | null
    if (!renderer) return

    const map = this.textureNode.value
    const image = map?.image as {width?: number; height?: number} | undefined
    if (!image?.width || !image?.height) return
    this.setSize(image.width, image.height)

    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState)
    renderer.setClearColor(0x000000, 0)

    _quadMesh.material = this.cocMaterial
    renderer.setRenderTarget(this.cocRT)
    _quadMesh.render(renderer)

    _quadMesh.material = this.prefilterMaterial
    renderer.setRenderTarget(this.prefilterRT)
    _quadMesh.render(renderer)

    _quadMesh.material = this.nearTileMaterial
    renderer.setRenderTarget(this.nearTileRT)
    _quadMesh.render(renderer)

    _quadMesh.material = this.farBlurMaterial
    renderer.setRenderTarget(this.farBlurRT)
    _quadMesh.render(renderer)

    _quadMesh.material = this.nearBlurMaterial
    renderer.setRenderTarget(this.nearBlurRT)
    _quadMesh.render(renderer)

    _quadMesh.material = this.compositeMaterial
    renderer.setRenderTarget(this.compositeRT)
    _quadMesh.render(renderer)

    RendererUtils.restoreRendererState(renderer, _rendererState)
  }

  override setup(builder: NodeBuilder) {
    const sharedContext = context((builder as unknown as {getSharedContext(): Record<string, unknown>}).getSharedContext())
    const discPoints = uniformArray(buildVogelDisc(DISC_SAMPLES))
    const dilatePoints = uniformArray(buildVogelDisc(TILE_DILATE_SAMPLES))

    const focusDist = this.focusDistanceUniform
    const lensScale = this.lensScaleUniform
    const maxCoc = this.maxBokehPixelsUniform
    const heightPx = this.fullHeightPx
    const invFull = this.invFullSize
    const invHalf = this.invHalfSize
    const bypass = this.bypassUniform

    // Pass 1: Full-res color + signed thin-lens pixel CoC (`rgb = beauty`, `a = signedCoCPixels`)
    this.cocMaterial.contextNode = sharedContext
    this.cocMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const col = this.textureNode.sample(uvCoord).rgb
      const depth = max(this.viewZNode.negate(), 0.05)
      const signedCoc = lensScale.mul(heightPx).mul(depth.sub(focusDist)).div(depth.mul(focusDist))
      const clampedCoc = clamp(signedCoc, maxCoc.negate(), maxCoc)
      return vec4(col, clampedCoc)
    })()
    this.cocMaterial.needsUpdate = true

    // Pass 2: Half-res 9-tap tent prefilter + closest-CoC preservation so sub-pixel hairs blur smoothly without Vogel dots
    this.prefilterMaterial.contextNode = sharedContext
    this.prefilterMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const px = invFull.x
      const py = invFull.y
      const nx = px.negate()
      const ny = py.negate()

      const c0 = this.cocTexNode.sample(uvCoord)
      const c1 = this.cocTexNode.sample(uvCoord.add(vec2(nx, ny)))
      const c2 = this.cocTexNode.sample(uvCoord.add(vec2(px, ny)))
      const c3 = this.cocTexNode.sample(uvCoord.add(vec2(nx, py)))
      const c4 = this.cocTexNode.sample(uvCoord.add(vec2(px, py)))
      const c5 = this.cocTexNode.sample(uvCoord.add(vec2(px, 0.0)))
      const c6 = this.cocTexNode.sample(uvCoord.add(vec2(nx, 0.0)))
      const c7 = this.cocTexNode.sample(uvCoord.add(vec2(0.0, py)))
      const c8 = this.cocTexNode.sample(uvCoord.add(vec2(0.0, ny)))

      const avgRgb = c0.rgb.mul(0.25)
        .add(c5.rgb.add(c6.rgb).add(c7.rgb).add(c8.rgb).mul(0.125))
        .add(c1.rgb.add(c2.rgb).add(c3.rgb).add(c4.rgb).mul(0.0625))

      // Minimum signed CoC across the 1-px neighborhood protects anti-aliased fringes of foreground/focal hairs!
      const minSignedCoc = min(c0.a, min(min(c5.a, c6.a), min(c7.a, c8.a)))
      return vec4(avgRgb, minSignedCoc)
    })()
    this.prefilterMaterial.needsUpdate = true

    // Pass 3: Dilate foreground (negative CoC) radius
    this.nearTileMaterial.contextNode = sharedContext
    this.nearTileMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const maxNear = float(0.0).toVar()
      const avgNear = float(0.0).toVar()
      const spread = invFull.mul(maxCoc)
      Loop(TILE_DILATE_SAMPLES, ({i}) => {
        const offset = dilatePoints.element(i) as unknown as Node<'vec2'>
        const sampleUv = clamp(uvCoord.add(offset.mul(spread)), 0.001, 0.999)
        const coc = this.prefilterTexNode.sample(sampleUv).a
        const nearMag = max(coc.negate(), 0.0)
        maxNear.assign(max(maxNear, nearMag))
        avgNear.addAssign(nearMag)
      })
      const dilated = mix(maxNear, avgNear.div(TILE_DILATE_SAMPLES), 0.25)
      return vec4(dilated, 0.0, 0.0, 1.0)
    })()
    this.nearTileMaterial.needsUpdate = true

    // Pass 4: Far-field CoC-weighted Vogel optical disc gather on prefiltered half-res buffer
    this.farBlurMaterial.contextNode = sharedContext
    this.farBlurMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const center = this.prefilterTexNode.sample(uvCoord)
      const centerFar = max(center.a, 0.0)
      const outRgb = center.rgb.toVar()

      If(centerFar.greaterThan(0.25), () => {
        const sumRgb = vec3(0.0).toVar()
        const sumW = float(0.0).toVar()
        const stepUv = invFull.mul(centerFar)

        Loop(DISC_SAMPLES, ({i}) => {
          const offset = discPoints.element(i) as unknown as Node<'vec2'>
          const sUv = clamp(uvCoord.add(offset.mul(stepUv)), 0.001, 0.999)
          const tap = this.prefilterTexNode.sample(sUv)
          const tapFar = max(tap.a, 0.0)
          const rNorm = float(i).add(0.5).div(DISC_SAMPLES).sqrt()
          const cocCover = smoothstep(rNorm.mul(centerFar).sub(1.8), rNorm.mul(centerFar).add(1.0), tapFar.add(0.5))
          const diaphragm = float(1.0).sub(smoothstep(0.78, 1.0, rNorm).mul(0.32))
          const w = cocCover.mul(diaphragm).add(1e-4)
          sumRgb.addAssign(tap.rgb.mul(w))
          sumW.addAssign(w)
        })

        outRgb.assign(sumRgb.div(max(sumW, 1e-4)))
      })

      return vec4(outRgb, centerFar)
    })()
    this.farBlurMaterial.needsUpdate = true

    // Pass 5: Near-field foreground scatter-as-gather with creamy bokeh alpha
    this.nearBlurMaterial.contextNode = sharedContext
    this.nearBlurMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const dilatedNear = this.nearTileTexNode.sample(uvCoord).r
      const sumRgb = vec3(0.0).toVar()
      const sumAlpha = float(0.0).toVar()
      const sumW = float(0.0).toVar()

      If(dilatedNear.greaterThan(0.25), () => {
        const stepUv = invFull.mul(max(dilatedNear, 1.25))
        Loop(DISC_SAMPLES, ({i}) => {
          const offset = discPoints.element(i) as unknown as Node<'vec2'>
          const sUv = clamp(uvCoord.add(offset.mul(stepUv)), 0.001, 0.999)
          const tap = this.prefilterTexNode.sample(sUv)
          const tapNear = max(tap.a.negate(), 0.0)
          const distPx = float(i).add(0.5).div(DISC_SAMPLES).sqrt().mul(dilatedNear)
          const scatter = smoothstep(tapNear.add(1.8), max(tapNear.sub(1.0), 0.0), distPx)
            .mul(smoothstep(0.2, 1.6, tapNear))
          sumRgb.addAssign(tap.rgb.mul(scatter))
          sumAlpha.addAssign(scatter)
          sumW.addAssign(scatter)
        })
      })

      const nearColor = sumRgb.div(max(sumW, 1e-4))
      const coverage = clamp(sumAlpha.div(DISC_SAMPLES * 0.44), 0.0, 1.0)
      const smoothAlpha = smoothstep(0.0, 1.0, coverage)
      return vec4(nearColor, smoothAlpha)
    })()
    this.nearBlurMaterial.needsUpdate = true

    // Pass 6: Full-resolution optical composite with 9-tap tent post-filter & 1-px focal-corridor protection
    this.compositeMaterial.contextNode = sharedContext
    this.compositeMaterial.fragmentNode = Fn(() => {
      const uvCoord = uv()
      const beauty = this.cocTexNode.sample(uvCoord)

      // Check 1-px cross CoC so anti-aliased edges of sharp focal hairs stay crisp rather than picking up backdrop CoC!
      const fx = invFull.x
      const fy = invFull.y
      const cL = this.cocTexNode.sample(uvCoord.add(vec2(fx.negate(), 0.0))).a
      const cR = this.cocTexNode.sample(uvCoord.add(vec2(fx, 0.0))).a
      const cU = this.cocTexNode.sample(uvCoord.add(vec2(0.0, fy))).a
      const cD = this.cocTexNode.sample(uvCoord.add(vec2(0.0, fy.negate()))).a
      const localMinAbs = min(beauty.a.abs(), min(min(cL.abs(), cR.abs()), min(cU.abs(), cD.abs())))
      const farCoc = select(localMinAbs.lessThan(0.85), localMinAbs, max(beauty.a, 0.0))

      // 9-tap 3×3 tent filter on half-res far & near buffers eliminates any remaining Vogel ring grain
      const hx = invHalf.x
      const hy = invHalf.y
      const nhx = hx.negate()
      const nhy = hy.negate()

      const far = this.farBlurTexNode.sample(uvCoord).rgb.mul(0.25)
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(hx, 0.0))).rgb.mul(0.125))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(nhx, 0.0))).rgb.mul(0.125))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(0.0, hy))).rgb.mul(0.125))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(0.0, nhy))).rgb.mul(0.125))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(hx, hy))).rgb.mul(0.0625))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(nhx, hy))).rgb.mul(0.0625))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(hx, nhy))).rgb.mul(0.0625))
        .add(this.farBlurTexNode.sample(uvCoord.add(vec2(nhx, nhy))).rgb.mul(0.0625))

      const near = this.nearBlurTexNode.sample(uvCoord).mul(0.25)
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(hx, 0.0))).mul(0.125))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(nhx, 0.0))).mul(0.125))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(0.0, hy))).mul(0.125))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(0.0, nhy))).mul(0.125))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(hx, hy))).mul(0.0625))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(nhx, hy))).mul(0.0625))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(hx, nhy))).mul(0.0625))
        .add(this.nearBlurTexNode.sample(uvCoord.add(vec2(nhx, nhy))).mul(0.0625))

      const farBlend = smoothstep(0.55, 2.6, farCoc)
      const withFar = mix(beauty.rgb, far, farBlend)
      const withNear = mix(withFar, near.rgb, near.a)
      return vec4(withNear, 1.0)
    })()
    this.compositeMaterial.needsUpdate = true

    return Fn(() => {
      const uvCoord = uv()
      const out = vec4(0.0, 0.0, 0.0, 1.0).toVar()
      If(bypass.greaterThan(0.5).or(lensScale.lessThanEqual(1e-6)), () => {
        out.assign(this.textureNode.sample(uvCoord))
      }).Else(() => {
        out.assign(this.outputTexNode.sample(uvCoord))
      })
      return out
    })()
  }

  override dispose() {
    super.dispose()
    this.cocRT.dispose()
    this.prefilterRT.dispose()
    this.nearTileRT.dispose()
    this.farBlurRT.dispose()
    this.nearBlurRT.dispose()
    this.compositeRT.dispose()
    this.cocMaterial.dispose()
    this.prefilterMaterial.dispose()
    this.nearTileMaterial.dispose()
    this.farBlurMaterial.dispose()
    this.nearBlurMaterial.dispose()
    this.compositeMaterial.dispose()
  }
}

export type MacroDepthOfFieldProps = EffectProps & {
  focusDistance?: number
  apertureRadius?: number
  maxBokehPixels?: number
}

@Register
export class MacroDepthOfField extends Effect {

  static override readonly stage = 'post'

  @Property({type: Number, value: 5.65})
  declare focusDistance: number

  @Property({type: Number, value: 0.19})
  declare apertureRadius: number

  @Property({type: Number, value: 46})
  declare maxBokehPixels: number

  bypassed = false

  constructor(args?: MacroDepthOfFieldProps) {
    super({id: 'macroDepthOfField', ...args})
  }

  override build(color: Node<'vec4'>, ctx: EffectContext): EffectInstance {
    const texNode = convertToTexture(color)
    const ownsTex = texNode !== color
    const dofNode = new MacroDofNode(texNode, ctx.scenePass.getViewZNode())

    return {
      output: dofNode as unknown as Node<'vec4'>,
      update: (effectCtx: EffectContext) => {
        const cam = effectCtx.camera
        let halfTan = Math.tan(MathUtils.degToRad(10))
        if (cam instanceof PerspectiveCamera) {
          halfTan = Math.tan(MathUtils.degToRad(0.5 * cam.fov)) / Math.max(cam.zoom, 1e-6)
        }
        dofNode.focusDistanceUniform.value = Math.max(this.focusDistance, 0.2)
        dofNode.lensScaleUniform.value = Math.max(this.apertureRadius, 0) / Math.max(2 * halfTan, 1e-6)
        dofNode.maxBokehPixelsUniform.value = Math.max(this.maxBokehPixels, 2)
        dofNode.bypassUniform.value = this.bypassed ? 1 : 0
      },
      dispose: () => {
        dofNode.dispose()
        if (ownsTex) texNode.dispose()
      },
    }
  }
}

registerEditor(MacroDepthOfField, {
  widgets: [
    ['focusDistance', ioNumberSlider({min: 1.5, max: 24, step: 0.02})],
    ['apertureRadius', ioNumberSlider({min: 0, max: 0.45, step: 0.005})],
    ['maxBokehPixels', ioNumberSlider({min: 4, max: 64, step: 1})],
  ],
  groups: {
    Main: ['enabled', 'focusDistance', 'apertureRadius', 'maxBokehPixels'],
  },
})
