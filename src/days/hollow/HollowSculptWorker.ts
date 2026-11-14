import {HollowField, type HollowFieldParams} from './HollowField.js'
import {type HollowBody, type HollowSculptPart, HollowSculpt, reviveBody} from './HollowSculpt.js'
import type {OctreeSlab} from './HollowOctree.js'

/** Messages to a sculpt worker: a cave to mesh (`init`), then its slabs one at a time. */
export type HollowSculptRequest =
  | {kind: 'init'; job: number; params: HollowFieldParams; bodies: HollowBody[]}
  | {kind: 'slab'; job: number; index: number; slab: OctreeSlab}

export interface HollowSculptReply {
  job: number
  index: number
  part: HollowSculptPart
}

let sculpt: HollowSculpt | null = null
let job = -1

self.onmessage = (event: MessageEvent<HollowSculptRequest>) => {
  const request = event.data
  if (request.kind === 'init') {
    sculpt = new HollowSculpt(new HollowField(request.params), request.bodies.map(reviveBody))
    job = request.job
    return
  }
  if (!sculpt || request.job !== job) return
  const part = sculpt.sculptSlab(request.slab)
  const {contour} = part
  const reply: HollowSculptReply = {job, index: request.index, part}
  const transfer = [
    contour.positions, contour.cells, contour.quads, contour.foreign, contour.boundaryKeys, contour.boundaryVertices,
    part.normals, part.zones, part.sheets, part.occlusion,
  ].map(array => array.buffer)
  ;(self as unknown as Worker).postMessage(reply, transfer)
}
