import { Register } from '@io-gui/core'
import { Raycaster, Vector2, Vector3 } from 'three/webgpu'
import { Behavior, BehaviorPriority, ThreeViewport, ThreeViewportProps } from '@io-gui/three'
import type { Document, DirtyReason, FrameInfo, ViewInputEvent, ViewRenderResult } from '@io-gui/three'

/** Detail of `document-drawn`. */
export type DocumentDrawn = {document: Document}

/** A size in device pixels. */
export type Resolution = {width: number; height: number}

/** Pointer ray and motion delivered to a document that responds to viewport hover and drag (`GestureListener`). */
export type ViewportGesture = {
  /** Ray origin in world space. */
  origin: Vector3
  /** Unit ray direction in world space. */
  direction: Vector3
  /** Change in ray direction per second (multiply by depth to obtain lateral world velocity at that depth). */
  angularVelocity: Vector3
  /** True while primary button or touch is held/dragging; false during passive pointer hover. */
  pressed: boolean
  /** False when the pointer leaves or releases. */
  active: boolean
}

/** A document whose simulation responds to subtle pointer air-wakes and brush drags in a viewport. */
export interface GestureListener {
  gestureChanged(gesture: ViewportGesture): void
}

const _ndc = new Vector2()
const _raycaster = new Raycaster()

/**
 * A ThreeViewport that reports the first time it draws each document, once the GPU has done that draw (its pipelines
 * compiled, the document's first GPU work run): `document-drawn` (bubbles, `DocumentDrawn`). Only a visible viewport
 * draws, so the document is then on screen. It counts its draws (`draws`), can draw at a fixed `resolution` whatever
 * its size on the page (the capture's), and forwards pointer hover and drag rays through `inputRouter` to documents
 * implementing `GestureListener` without interfering with camera navigation in free views.
 */
@Register
export class DrawnViewport extends ThreeViewport {

  declare private _drawn: WeakSet<Document> | undefined
  declare private _resolution: Resolution | null | undefined
  declare private _draws: number | undefined
  declare private _gestureBehavior: Behavior | undefined

  /** How many times the viewport has drawn. */
  get draws() {
    return this._draws ?? 0
  }

  get resolution() {
    return this._resolution ?? null
  }

  /** Draws at `resolution` device pixels from now on; `null` goes back to the element's size and the device's pixels. */
  set resolution(resolution: Resolution | null) {
    this._resolution = resolution
    this.width = 0
    this.height = 0
    this.onResized()
  }

  constructor(args: ThreeViewportProps) {
    super(args)
    this._installGestureBehavior()
  }

  private _installGestureBehavior() {
    if (this._gestureBehavior) return
    const prevDirection = new Vector3()
    const origin = new Vector3()
    const direction = new Vector3()
    const angularVelocity = new Vector3()
    let prevTime = 0
    let hasPrev = false

    const listener = (): Partial<GestureListener> | null => (this.document as Partial<GestureListener> | null)

    const emit = (event: ViewInputEvent | undefined, pressed: boolean, active: boolean) => {
      const doc = listener()
      if (!doc?.gestureChanged) return
      if (!active || !event || this.clientWidth <= 0 || this.clientHeight <= 0) {
        hasPrev = false
        angularVelocity.set(0, 0, 0)
        doc.gestureChanged({origin, direction, angularVelocity, pressed: false, active: false})
        return
      }
      _ndc.set((event.x / this.clientWidth) * 2 - 1, -(event.y / this.clientHeight) * 2 + 1)
      const camera = this.getViewCamera()
      _raycaster.setFromCamera(_ndc, camera)
      origin.copy(_raycaster.ray.origin)
      direction.copy(_raycaster.ray.direction)
      const now = performance.now()
      if (hasPrev) {
        const dt = Math.min(Math.max((now - prevTime) * 0.001, 1 / 240), 0.1)
        angularVelocity.subVectors(direction, prevDirection).divideScalar(dt)
        const maxRate = 12
        if (angularVelocity.lengthSq() > maxRate * maxRate) angularVelocity.setLength(maxRate)
      } else {
        angularVelocity.set(0, 0, 0)
      }
      prevDirection.copy(direction)
      prevTime = now
      hasPrev = true
      doc.gestureChanged({origin, direction, angularVelocity, pressed, active: true})
    }

    const behavior: Behavior = {
      // Below NavigationBehavior (300) so free/axis views orbit normally; active in scene-camera views (#Fullscreen, #Active).
      priority: BehaviorPriority.navigation - 10,
      wantsCapture: (event: ViewInputEvent) => {
        return event.type === 'pointerdown' && event.button === 0 && typeof listener()?.gestureChanged === 'function'
      },
      begin: (event: ViewInputEvent) => {
        hasPrev = false
        emit(event, true, true)
      },
      update: (event: ViewInputEvent) => {
        if (event.type === 'pointermove') emit(event, true, true)
      },
      end: (event: ViewInputEvent) => {
        emit(event, false, false)
      },
      cancel: () => {
        emit(undefined, false, false)
      },
      hover: (event: ViewInputEvent) => {
        emit(event, false, true)
        return false
      },
      hoverEnd: () => {
        emit(undefined, false, false)
      },
    }
    this._gestureBehavior = behavior
    this.inputRouter.add(behavior)
  }

  override onResized() {
    const resolution = this._resolution
    if (!resolution) return super.onResized()
    if (this.width === resolution.width && this.height === resolution.height) return
    this.width = resolution.width
    this.height = resolution.height
    this.renderTarget.setPixelRatio(1)
    this.renderTarget.setSize(resolution.width, resolution.height)
    this.tag('resize')
  }

  override renderView(reasons: ReadonlySet<DirtyReason>, frame: FrameInfo): ViewRenderResult | void {
    const result = super.renderView(reasons, frame)
    this._draws = this.draws + 1
    const document = this.document
    const drawn = this._drawn ??= new WeakSet()
    if (document && !drawn.has(document)) {
      drawn.add(document)
      // the WebGL fallback has no device: its draws are done when they return
      const device = (this.renderer.backend as {device?: GPUDevice}).device
      const done = device ? device.queue.onSubmittedWorkDone() : Promise.resolve()
      void done.then(() => this.dispatch('document-drawn', {document} satisfies DocumentDrawn, true))
    }
    return result
  }
}

export const drawnViewport = (arg0: ThreeViewportProps) => DrawnViewport.vConstructor(arg0)
