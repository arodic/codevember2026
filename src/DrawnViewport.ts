import { Register } from '@io-gui/core'
import { ThreeViewport, ThreeViewportProps } from '@io-gui/three'
import type { Document, DirtyReason, FrameInfo, ViewRenderResult } from '@io-gui/three'

/** Detail of `document-drawn`. */
export type DocumentDrawn = {document: Document}

/** A size in device pixels. */
export type Resolution = {width: number; height: number}

/**
 * A ThreeViewport that reports the first time it draws each document, once the GPU has done that draw (its pipelines
 * compiled, the document's first GPU work run): `document-drawn` (bubbles, `DocumentDrawn`). Only a visible viewport
 * draws, so the document is then on screen. It counts its draws (`draws`), and can draw at a fixed `resolution`
 * whatever its size on the page (the capture's): the canvas then keeps that many pixels and CSS fits it to the element.
 */
@Register
export class DrawnViewport extends ThreeViewport {

  declare private _drawn: WeakSet<Document> | undefined
  declare private _resolution: Resolution | null | undefined
  declare private _draws: number | undefined

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
