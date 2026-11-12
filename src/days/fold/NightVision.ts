import { Register, Property } from '@io-gui/core'
import type { Node } from 'three/webgpu'
import { dot, mix, uniform, vec3, vec4 } from 'three/tsl'
import { registerEditor } from '@io-gui/editors'
import { ioNumberSlider } from '@io-gui/sliders'
import { Effect, EffectInstance, EffectProps } from '@io-gui/three'

export type NightVisionProps = EffectProps & {
  scotopic?: number
}

/**
 * The Purkinje shift of night vision: as light fades the rods take over, colors drain toward their scotopic
 * luminance (weighted to blue-green, so reds go dark first) and the scene turns cool. `scotopic` is how far
 * vision has gone over to the rods.
 */
@Register
export class NightVision extends Effect {

  static override readonly stage = 'post'

  /** 0 daylight (cones), 1 starlight (rods). */
  @Property({type: Number, value: 0})
  declare scotopic: number

  constructor(args?: NightVisionProps) {
    super({id: 'nightVision', ...args})
  }

  override build(color: Node<'vec4'>): EffectInstance {
    const amount = uniform(0)
    const rods = dot(color.rgb, vec3(0.04, 0.46, 0.5))
    const night = vec3(0.7, 0.86, 1.2).mul(rods)
    return {
      output: vec4(mix(color.rgb, night, amount), color.a),
      update: () => {
        amount.value = this.scotopic
      },
    }
  }
}

registerEditor(NightVision, {
  widgets: [
    ['scotopic', ioNumberSlider({min: 0, max: 1, step: 0.01})],
  ],
  groups: {
    Main: ['enabled', 'scotopic'],
  },
})
