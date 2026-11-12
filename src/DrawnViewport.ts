import { Register } from '@io-gui/core'
import { ThreeViewport, ThreeViewportProps } from '@io-gui/three'
import type { Document, DirtyReason, FrameInfo, ViewRenderResult } from '@io-gui/three'

/** Detail of `document-drawn`. */
export type DocumentDrawn = {document: Document}

/**
 * A ThreeViewport that reports the first time it draws each document, once the GPU has done that draw (its pipelines
 * compiled, the document's first GPU work run): `document-drawn` (bubbles, `DocumentDrawn`). Only a visible viewport
 * draws, so the document is then on screen.
 */
@Register
export class DrawnViewport extends ThreeViewport {

  declare private _drawn: WeakSet<Document> | undefined

  override renderView(reasons: ReadonlySet<DirtyReason>, frame: FrameInfo): ViewRenderResult | void {
    const result = super.renderView(reasons, frame)
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
