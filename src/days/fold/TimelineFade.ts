import { Register, Property } from '@io-gui/core'
import type { Node } from 'three/webgpu'
import { uniform, vec4 } from 'three/tsl'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { Effect, EffectContext, EffectInstance, EffectProps } from '@io-gui/three'

export type TimelineFadeProps = EffectProps & {
  fadeIn?: number
  fadeOut?: number
}

/**
 * Fades the picture in from black over the first `fadeIn` seconds of the document's timeline and out to black over
 * its last `fadeOut` (eased), so a loop of the timeline plays as a piece with a start and an end.
 */
@Register
export class TimelineFade extends Effect {

  static override readonly stage = 'post'

  @Property({type: Number, value: 1})
  declare fadeIn: number

  @Property({type: Number, value: 1})
  declare fadeOut: number

  constructor(args?: TimelineFadeProps) {
    super({id: 'timelineFade', ...args})
  }

  override build(color: Node<'vec4'>): EffectInstance {
    const level = uniform(1)
    return {
      output: vec4(color.rgb.mul(level), color.a),
      update: (ctx: EffectContext) => {
        const {currentTime, duration} = ctx.document.timeline
        const rising = this.fadeIn > 0 ? currentTime / this.fadeIn : 1
        const falling = this.fadeOut > 0 ? (duration - currentTime) / this.fadeOut : 1
        const t = Math.min(Math.max(Math.min(rising, falling), 0), 1)
        level.value = t * t * (3 - 2 * t)
      },
    }
  }
}

registerEditor(TimelineFade, {
  widgets: [
    ['fadeIn', ioNumberSlider({min: 0, max: 5, step: 0.1})],
    ['fadeOut', ioNumberSlider({min: 0, max: 5, step: 0.1})],
  ],
  groups: {
    Main: ['enabled', 'fadeIn', 'fadeOut'],
  },
})
