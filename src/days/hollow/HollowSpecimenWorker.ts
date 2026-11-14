import {HOLLOW_SPECIMENS, sculptSpecimen} from './HollowSpecimens.js'

/** Meshes the specimen of the index it's sent (`HOLLOW_SPECIMENS`) and replies with its arrays, transferred. */
self.onmessage = (event: MessageEvent<number>) => {
  const index = event.data
  const mesh = sculptSpecimen(HOLLOW_SPECIMENS[index])
  const transfer = [mesh.positions, mesh.normals, mesh.index, mesh.zones, mesh.sheets, mesh.occlusion].map(array => array.buffer)
  ;(self as unknown as Worker).postMessage({index, mesh}, transfer)
}
