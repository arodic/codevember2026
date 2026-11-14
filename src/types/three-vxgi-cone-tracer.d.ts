// three r187 ships `VXGIConeTracer.js` without a declaration; Hollow traces its cones from compute kernels.
declare module 'three/addons/lighting/vxgi/VXGIConeTracer.js' {
  import type {Node} from 'three/webgpu'
  import type {VXGIVolume} from 'three/addons/lighting/vxgi/VXGIVolume.js'

  export interface VXGICone {
    /** Radiance gathered along the cone. */
    color: Node<'vec3'>
    /** Accumulated occlusion. */
    alpha: Node<'float'>
  }

  export function createConeTracer(
    volume: VXGIVolume,
    options?: {radianceNode?: Node | null; directionalNode?: Node | null; maxSteps?: number},
  ): (origin: Node<'vec3'>, direction: Node<'vec3'>, tanHalfAngle: Node<'float'>, maxDistance: Node<'float'>) => VXGICone
}
