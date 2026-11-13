import { Register, Property } from '@io-gui/core'
import { Color, NeutralToneMapping, Vector3 } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { Fn, If, float, max, min, mix, neutralToneMapping, select, sqrt, uniform, vec3, vec4 } from 'three/tsl'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { ioColorRgba } from '@io-gui/colors'
import { Effect, EffectContext, EffectInstance, EffectProps } from '@io-gui/three'

export type TimelineFadeProps = EffectProps & {
  fadeIn?: number
  fadeOut?: number
  color?: Color
}

/** The brightest tone-mapped value the crossfade reaches: neutral tone mapping only approaches 1. */
const TOP = 0.998

/**
 * Inverse of three's `neutralToneMapping` (Khronos PBR Neutral) at exposure 1: the linear color that tone-maps to
 * `mapped` (each channel in `[0, 1)`).
 */
const inverseNeutralToneMapping = Fn(([mapped]: [Node<'vec3'>]) => {
  const start = float(0.76)
  const d = float(0.24)
  const color = vec3(mapped).toVar()
  // Compressed: the peak channel is the compressed peak, and the rest were mixed toward it
  const newPeak = max(mapped.r, max(mapped.g, mapped.b))
  If(newPeak.greaterThanEqual(start), () => {
    const peak = d.mul(d).div(float(1).sub(newPeak)).sub(d).add(start)
    const g = float(1).sub(float(1).div(float(0.15).mul(peak.sub(newPeak)).add(1)))
    color.assign(max(mapped.sub(vec3(newPeak.mul(g))).div(float(1).sub(g)), vec3(0)).mul(peak.div(newPeak)))
  })
  // The offset taken off every channel, from the lowest channel it left
  const low = max(min(color.r, min(color.g, color.b)), 0)
  const offset = select(low.lessThan(0.04), sqrt(low).mul(0.4).sub(low), float(0.04))
  return color.add(offset)
}, {mapped: 'vec3', return: 'vec3'})

/**
 * Fades the picture in from `color` over the first `fadeIn` seconds of the document's timeline and out to it over its
 * last `fadeOut` (eased), so a loop of the timeline plays as a piece with a start and an end. Under neutral tone
 * mapping, which it can undo, it crossfades the picture as shown: it tone-maps it as the viewport will, mixes in the
 * color and undoes the tone mapping, so a fade to white brightens evenly instead of blowing out in its first moment.
 * Under other tone mappings it mixes in linear light: black then dims the light, as exposure would.
 */
@Register
export class TimelineFade extends Effect {

  static override readonly stage = 'post'

  @Property({type: Number, value: 1})
  declare fadeIn: number

  @Property({type: Number, value: 1})
  declare fadeOut: number

  /** The color the picture fades from and to. */
  @Property({type: Color, value: new Color(0, 0, 0)})
  declare color: Color

  constructor(args?: TimelineFadeProps) {
    super({id: 'timelineFade', ...args})
  }

  override build(color: Node<'vec4'>): EffectInstance {
    const level = uniform(1)
    const target = uniform(new Vector3())
    const exposure = uniform(1)
    const shown = uniform(0)
    const linear = mix(color.rgb, target, float(1).sub(level))
    const shownColor = neutralToneMapping(color.rgb, exposure) as Node<'vec3'>
    const mapped = mix(shownColor, target, float(1).sub(level))
    const crossfaded = inverseNeutralToneMapping(min(mapped, vec3(TOP))).div(exposure)
    const faded = select(shown.greaterThan(0.5), crossfaded, linear)
    return {
      output: vec4(select(level.lessThan(1), faded, color.rgb), color.a),
      update: (ctx: EffectContext) => {
        const {timeline, toneMapping, toneMappingExposure} = ctx.document
        const {currentTime, duration} = timeline
        const rising = this.fadeIn > 0 ? currentTime / this.fadeIn : 1
        const falling = this.fadeOut > 0 ? (duration - currentTime) / this.fadeOut : 1
        const t = Math.min(Math.max(Math.min(rising, falling), 0), 1)
        level.value = t * t * (3 - 2 * t)
        target.value.set(this.color.r, this.color.g, this.color.b)
        exposure.value = Math.max(toneMappingExposure, 1e-4)
        shown.value = toneMapping === NeutralToneMapping ? 1 : 0
      },
    }
  }
}

registerEditor(TimelineFade, {
  widgets: [
    ['fadeIn', ioNumberSlider({min: 0, max: 10, step: 0.1})],
    ['fadeOut', ioNumberSlider({min: 0, max: 10, step: 0.1})],
    ['color', ioColorRgba()],
  ],
  groups: {
    Main: ['enabled', 'fadeIn', 'fadeOut', 'color'],
  },
})
