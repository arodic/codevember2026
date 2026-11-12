import { Register, Property } from '@io-gui/core'
import type { Node } from 'three/webgpu'
import { dot, max, min, mix, smoothstep, uniform, vec3, vec4 } from 'three/tsl'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { Effect, EffectContext, EffectInstance, EffectProps } from '@io-gui/three'

export type ColorGradeProps = EffectProps & {
  vibrance?: number
  splitTone?: number
  goldenHour?: number
}

const LUMINANCE = vec3(0.2126, 0.7152, 0.0722)

/** Tints for the shades and the lights, at unit luminance. */
const COOL = vec3(0.86, 0.93, 1.28).div(0.2126 * 0.86 + 0.7152 * 0.93 + 0.0722 * 1.28)
const WARM = vec3(1.14, 1.0, 0.84).div(0.2126 * 1.14 + 0.7152 + 0.0722 * 0.84)

/**
 * A photographic grade for the desert: vibrance, which saturates the muted colors most (sandstone, dusk sky) and
 * leaves the vivid ones, and split toning that cools the shades toward the sky and warms the lights toward the sun,
 * strongest at golden and blue hour (`goldenHour`, set by the document). Applied to the resolved linear color, its
 * luminance measured against the document's exposure.
 */
@Register
export class ColorGrade extends Effect {

  static override readonly stage = 'post'

  @Property({type: Number, value: 0.45})
  declare vibrance: number

  @Property({type: Number, value: 0.35})
  declare splitTone: number

  /** 0 midday or deep night, 1 the sun low or just set. */
  @Property({type: Number, value: 0})
  declare goldenHour: number

  constructor(args?: ColorGradeProps) {
    super({id: 'colorGrade', ...args})
  }

  override build(color: Node<'vec4'>): EffectInstance {
    const vibrance = uniform(0)
    const splitTone = uniform(0)
    const exposure = uniform(1)
    const rgb = color.rgb
    const luminance = dot(rgb, LUMINANCE)
    const brightest = max(rgb.r, max(rgb.g, rgb.b))
    const saturation = brightest.sub(min(rgb.r, min(rgb.g, rgb.b))).div(brightest.max(1e-6))
    const vivid = mix(vec3(luminance), rgb, vibrance.mul(saturation.oneMinus()).add(1.0))
    const exposed = luminance.mul(exposure)
    const tint = mix(COOL, WARM, smoothstep(0.03, 0.5, exposed.div(exposed.add(1.0))))
    return {
      output: vec4(vivid.mul(mix(vec3(1.0), tint, splitTone)), color.a),
      update: (ctx: EffectContext) => {
        vibrance.value = this.vibrance
        splitTone.value = this.splitTone * (0.35 + 0.65 * this.goldenHour)
        exposure.value = ctx.document.toneMappingExposure
      },
    }
  }
}

registerEditor(ColorGrade, {
  widgets: [
    ['vibrance', ioNumberSlider({min: 0, max: 1.5, step: 0.01})],
    ['splitTone', ioNumberSlider({min: 0, max: 1, step: 0.01})],
    ['goldenHour', ioNumberSlider({min: 0, max: 1, step: 0.01})],
  ],
  groups: {
    Main: ['enabled', 'vibrance', 'splitTone', 'goldenHour'],
  },
})
