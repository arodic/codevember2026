import { DataTexture, HalfFloatType, RGBAFormat } from 'three'
import { EXRExporter, ZIP_COMPRESSION } from 'three/addons/exporters/EXRExporter.js'

/**
 * A frame for `CaptureWorker` to encode and write: `exr` from half-float RGBA rows bottom up (as the exporter reads
 * them), `png` from sRGB RGBA bytes top down.
 */
export type EncodeJob = {
  id: number
  directory: FileSystemDirectoryHandle
  name: string
  format: 'exr' | 'png'
  width: number
  height: number
  pixels: Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>
}

/** The job is written, or failed with `error`. */
export type EncodeDone = {id: number; error?: string}

const exporter = new EXRExporter()

/** Encodes captured frames and writes them off the main thread, which goes on drawing the next frame meanwhile. */
self.addEventListener('message', (event: MessageEvent<EncodeJob>) => {
  const job = event.data
  encode(job).then(data => write(job, data)).then(
    () => self.postMessage({id: job.id} satisfies EncodeDone),
    (error: unknown) => self.postMessage({id: job.id, error: String(error)} satisfies EncodeDone),
  )
})

async function encode(job: EncodeJob): Promise<Uint8Array<ArrayBuffer> | Blob> {
  const {width, height, pixels} = job
  if (job.format === 'exr') {
    const image = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType)
    return exporter.parse(image, {type: HalfFloatType, compression: ZIP_COMPRESSION})
  }
  const canvas = new OffscreenCanvas(width, height)
  const bytes = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  canvas.getContext('2d')!.putImageData(new ImageData(bytes, width, height), 0, 0)
  return canvas.convertToBlob({type: 'image/png'})
}

async function write(job: EncodeJob, data: Uint8Array<ArrayBuffer> | Blob) {
  const file = await job.directory.getFileHandle(job.name, {create: true})
  const writable = await file.createWritable()
  await writable.write(data)
  await writable.close()
}
