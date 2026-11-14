import type {BufferGeometry} from 'three/webgpu'
import type {HollowField} from './HollowField.js'
import {type HollowBody, type HollowSculptPart, assembleSculpt, hollowSlabs} from './HollowSculpt.js'
import type {HollowSculptReply, HollowSculptRequest} from './HollowSculptWorker.js'

/**
 * Meshes the cave (`HollowSculpt`) on worker threads, a slab per task, so a rebuild neither takes as long nor
 * freezes the page. Each worker rebuilds the field from its parameters and the bodies.
 */
export class HollowSculptPool {

  private readonly workers: Worker[]
  private job = 0
  /** Settles the build in flight as superseded. */
  private cancel: (() => void) | null = null

  constructor(count = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1))) {
    this.workers = Array.from({length: count}, () =>
      new Worker(new URL('./HollowSculptWorker.ts', import.meta.url), {type: 'module', name: 'Hollow Sculpt'}))
  }

  /** The cave's geometry, or `null` when a later `build` superseded this one. */
  build(field: HollowField, bodies: HollowBody[]): Promise<BufferGeometry | null> {
    this.cancel?.()
    const job = ++this.job
    const slabs = hollowSlabs()
    const parts: HollowSculptPart[] = new Array(slabs.length)
    let next = 0
    let done = 0
    return new Promise((resolve, reject) => {
      this.cancel = () => resolve(null)
      const post = (worker: Worker, request: HollowSculptRequest) => worker.postMessage(request)
      const dispatch = (worker: Worker) => {
        if (next < slabs.length) post(worker, {kind: 'slab', job, index: next, slab: slabs[next++]})
      }
      for (const worker of this.workers) {
        worker.onmessage = (event: MessageEvent<HollowSculptReply>) => {
          const {job: replied, index, part} = event.data
          if (replied !== job) return
          parts[index] = part
          if (++done === slabs.length) {
            this.cancel = null
            resolve(assembleSculpt(parts))
          } else {
            dispatch(worker)
          }
        }
        worker.onerror = (event) => {
          this.cancel = null
          reject(new Error(`Hollow sculpt worker: ${event.message}`))
        }
        post(worker, {kind: 'init', job, params: {...field.params}, bodies})
        dispatch(worker)
      }
    })
  }

  dispose() {
    this.cancel?.()
    for (const worker of this.workers) worker.terminate()
  }
}
