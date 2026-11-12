import {
  CustomBlending, HalfFloatType, LinearSRGBColorSpace, MeshBasicNodeMaterial, NoBlending, NoToneMapping, OneFactor,
  OrthographicCamera, PerspectiveCamera, QuadMesh, RenderTarget, SRGBColorSpace, Texture, UnsignedByteType,
} from 'three/webgpu'
import type { ToneMapping, WebGPURenderer } from 'three/webgpu'
import { float, screenUV, texture, toneMapping, uniform, vec2, vec4, workingToColorSpace } from 'three/tsl'
import type { Document } from '@io-gui/three'
import type { DrawnViewport } from './DrawnViewport.js'
import type { EncodeDone, EncodeJob } from './CaptureWorker.js'

/**
 * What a frame is saved as: `exr` the image as it reaches the tone mapping (linear Rec.709, the document's exposure
 * applied, half float, ZIP), for grading; `png` the image as the screen shows it (tone-mapped, sRGB, 8 bits). Either is
 * the average of the frame's subframes, taken in linear light.
 */
export type CaptureFormat = 'exr' | 'png'

export type CaptureOptions = {
  /** Size of the frames in pixels (default 4096 × 1716, DCI scope). */
  width?: number
  height?: number
  /** Frames per second of timeline time (default the timeline's frame rate). */
  fps?: number
  /** Seconds each frame keeps drawing before it is saved, refining what converges over draws (GI). Default 2. */
  settle?: number
  /** Timeline seconds to capture (default all of it). Frames are numbered from time 0, so a capture can resume. */
  from?: number
  to?: number
  /** Default `exr`. */
  format?: CaptureFormat | CaptureFormat[]
  /**
   * Subframes averaged into each frame (default 1): spread over the shutter, and each a sub-pixel apart while
   * `jitter`, they blur motion and anti-alias. The first settles; each of the others draws once.
   */
  motionBlurFrames?: number
  /** The part of the frame interval the shutter is open, centered on the frame's time (default 0.5: 180°; 0 is no blur). */
  shutter?: number
  /** Whether the subframes move the camera a sub-pixel apart, anti-aliasing the frame (default true). */
  jitter?: boolean
  /** Where the frames go (default: a folder picker, which needs a user gesture; the DevTools console counts as one). */
  directory?: FileSystemDirectoryHandle
  /** File name prefix (default the document's name). */
  name?: string
}

export type CaptureResult = {frames: number; stopped: boolean; seconds: number}

/** What a capture does: `settle` the first subframe of a frame, `subframes` the others, `off` once it is over. */
export type CaptureStage = 'off' | 'settle' | 'subframes'

/**
 * A document that captures better knowing what the capture does: Fold computes its landscape in full while it
 * captures, and goes on refining its global illumination through the subframes.
 */
export interface CaptureListener {
  captureChanged(stage: CaptureStage): void
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {id?: string; mode?: 'read' | 'readwrite'}) => Promise<FileSystemDirectoryHandle>
  }
}

/** Asks for the folder the frames go to. Call before any `await`, while the gesture that asked counts. */
export function pickCaptureDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    return Promise.reject(new Error('capture: this browser cannot write to a folder (showDirectoryPicker); use Chrome or Edge'))
  }
  return window.showDirectoryPicker({id: 'codevember-capture', mode: 'readwrite'})
}

/** Workers encoding and writing frames: EXR takes seconds a frame, so several overlap the frames that follow. */
const ENCODERS = 3

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

/**
 * Renders a document's timeline frame by frame through a viewport and saves each frame to a folder. The caller puts
 * the viewport on screen at the capture's resolution and pauses playback. Each frame is the average of its subframes
 * (`motionBlurFrames`), at times spread over the shutter and with the active camera a sub-pixel apart (`jitter`): the
 * first lets the viewport draw for `settle` seconds (paused, the document refines what it accumulates, such as Fold's
 * global illumination), each of the others draws once. After each draw the pipeline's linear output (the document's
 * effects, no overlays), exposed, is added into a half-float target; a pass per format reads the average. Workers
 * (`CaptureWorker`) encode and write the frames while the next ones draw. Escape (the app's) or `stop()` ends it
 * after the frame in hand.
 */
export class FrameCapture {

  readonly width: number
  readonly height: number
  readonly fps: number
  readonly settle: number
  readonly first: number
  readonly last: number
  readonly formats: CaptureFormat[]
  readonly name: string
  readonly subframes: number
  readonly shutter: number
  readonly jitter: boolean
  private stopped = false
  private viewport: DrawnViewport
  private document: Document
  private directory: FileSystemDirectoryHandle
  /** The pipeline's output; the exposure and the weight of a subframe. */
  private output = texture(new Texture(), screenUV)
  private exposure = uniform(1)
  private weight = uniform(1)
  /** The sum of the subframes, written by the first and added to by the others. */
  private accumulation: RenderTarget
  private firstSubframe: MeshBasicNodeMaterial
  private nextSubframe: MeshBasicNodeMaterial
  private quad = new QuadMesh(new MeshBasicNodeMaterial())
  private passes = new Map<CaptureFormat, {target: RenderTarget; material: MeshBasicNodeMaterial; toneMapping: ToneMapping}>()
  private encoders: {worker: Worker; busy: Promise<void>}[] = []
  private jobs = new Map<number, {resolve: () => void; reject: (error: Error) => void}>()
  private jobId = 0
  private error: Error | null = null

  constructor(viewport: DrawnViewport, document: Document, directory: FileSystemDirectoryHandle, options: CaptureOptions & {name: string}) {
    this.viewport = viewport
    this.document = document
    this.directory = directory
    this.width = options.width ?? 4096
    this.height = options.height ?? 1716
    this.fps = options.fps ?? document.timeline.frameRate
    this.settle = options.settle ?? 2
    const duration = document.timeline.duration
    this.first = Math.max(0, Math.ceil((options.from ?? 0) * this.fps - 1e-6))
    this.last = Math.ceil(Math.min(options.to ?? duration, duration) * this.fps - 1e-6) - 1
    this.formats = [...new Set([options.format ?? 'exr'].flat())]
    this.name = options.name
    this.subframes = Math.max(1, Math.round(options.motionBlurFrames ?? 1))
    this.shutter = Math.max(0, options.shutter ?? 0.5)
    this.jitter = options.jitter ?? true
    const limit = (viewport.renderer.backend as {device?: GPUDevice}).device?.limits.maxTextureDimension2D ?? 8192
    if (!(this.width >= 1 && this.height >= 1 && this.width <= limit && this.height <= limit)) {
      throw new Error(`capture: ${this.width} × ${this.height} is outside 1 … ${limit} pixels`)
    }
    this.accumulation = new RenderTarget(this.width, this.height, {type: HalfFloatType, depthBuffer: false})
    // the weights sum to 1 in alpha too
    const subframe = vec4(this.output.rgb.mul(this.exposure).mul(this.weight), this.weight)
    this.firstSubframe = quadMaterial(subframe)
    this.nextSubframe = quadMaterial(subframe)
    Object.assign(this.nextSubframe, {blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor})
  }

  get frames() {
    return Math.max(0, this.last - this.first + 1)
  }

  stop() {
    this.stopped = true
  }

  async run(): Promise<CaptureResult> {
    const {frames, subframes} = this
    const started = performance.now()
    const written: Promise<void>[] = []
    const camera = this.document.activeCamera
    const aspect = camera instanceof PerspectiveCamera ? camera.aspect : 1
    let done = 0
    const blur = subframes > 1 ? `, ${subframes} subframes over ${this.shutter} of a frame${this.jitter ? ', jittered' : ''}` : ''
    console.info(`capture: ${frames} frames of ${this.name} at ${this.width} × ${this.height}, ${this.fps} fps, ` +
      `${this.settle} s each${blur} (${this.formats.join(', ')}); Escape or stopCapture() stops`)
    try {
      frames: for (let frame = this.first; frame <= this.last && !this.stopped; frame++) {
        for (let subframe = 0; subframe < subframes; subframe++) {
          this.stage(subframe === 0 ? 'settle' : 'subframes')
          this.place(frame, subframe, aspect)
          if (!await this.drawn(subframe === 0 ? this.settle : 0)) break frames
          this.accumulate(subframe)
        }
        const names = await this.read(frame, written)
        done++
        const elapsed = (performance.now() - started) / 1000
        const eta = elapsed / done * (frames - done)
        console.info(`capture: ${names.join(', ')} (${done}/${frames}, ${(elapsed / done).toFixed(1)} s a frame, ${formatSeconds(eta)} left)`)
      }
      await Promise.all(written)
    } finally {
      if (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera) {
        camera.clearViewOffset()
        if (camera instanceof PerspectiveCamera) camera.aspect = aspect
        camera.updateProjectionMatrix()
      }
      this.stage('off')
      this.dispose()
    }
    if (this.error) throw this.error
    const seconds = (performance.now() - started) / 1000
    console.info(`capture: ${this.stopped ? 'stopped after' : 'done,'} ${done} frames in ${formatSeconds(seconds)}`)
    return {frames: done, stopped: this.stopped, seconds}
  }

  private stage(stage: CaptureStage) {
    (this.document as Partial<CaptureListener>).captureChanged?.(stage)
  }

  /**
   * Moves the timeline to a subframe's time, within the shutter around the frame's, and the active camera by its
   * sub-pixel offset (a Halton (2, 3) point; its aspect kept); the viewport draws it.
   */
  private place(frame: number, subframe: number, aspect: number) {
    const {document, subframes} = this
    const offset = ((subframe + 0.5) / subframes - 0.5) * this.shutter
    document.timeline.currentTime = Math.min(Math.max((frame + offset) / this.fps, 0), document.timeline.duration)
    const camera = document.activeCamera
    if (this.jitter && subframes > 1 && (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera)) {
      const {width, height} = this
      const fullHeight = camera instanceof PerspectiveCamera ? width / aspect : height
      camera.setViewOffset(width, fullHeight, halton(subframe + 1, 2) - 0.5, halton(subframe + 1, 3) - 0.5, width, fullHeight)
    }
    // a subframe at the time already shown changes nothing: draw it anyway
    this.viewport.tag('content')
  }

  /** Waits for the viewport to draw, and for `seconds` to pass; false once the capture is stopped. */
  private async drawn(seconds: number) {
    const draws = this.viewport.draws
    const until = performance.now() + seconds * 1000
    while (!this.stopped && (this.viewport.draws <= draws || performance.now() < until)) await nextFrame()
    return !this.stopped
  }

  /** Adds the viewport's last draw, exposed and weighted, into the sum of the subframes (the first replaces it). */
  private accumulate(subframe: number) {
    const output = this.viewport.compositor.pipeline?.output
    if (!output) throw new Error('capture: the viewport has drawn nothing')
    this.output.value = output.color
    this.exposure.value = this.viewport.view?.toneMappingExposure ?? this.document.toneMappingExposure
    this.weight.value = 1 / this.subframes
    this.render(this.accumulation, subframe === 0 ? this.firstSubframe : this.nextSubframe)
  }

  /** Reads the frame in each format and hands it to an encoder; adds the writes to `written`. */
  private async read(frame: number, written: Promise<void>[]): Promise<string[]> {
    const renderer = this.viewport.renderer
    const number = String(frame).padStart(5, '0')
    const names: string[] = []
    for (const format of this.formats) {
      const pass = this.pass(format)
      this.render(pass.target, pass.material)
      const target = pass.target
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, this.width, this.height) as EncodeJob['pixels']
      const name = `${this.name}_${number}.${format}`
      names.push(name)
      written.push((await this.encode({name, format, width: this.width, height: this.height, pixels})).written)
    }
    return names
  }

  /**
   * Hands a frame to the first encoder free (waiting for one), and returns its write (wrapped: a promise would wait). A failed write stops the
   * capture, which then throws its error.
   */
  private async encode(job: Omit<EncodeJob, 'id' | 'directory'>): Promise<{written: Promise<void>}> {
    if (!this.encoders.length) {
      for (let i = 0; i < ENCODERS; i++) {
        const worker = new Worker(new URL('./CaptureWorker.ts', import.meta.url), {type: 'module'})
        worker.addEventListener('message', (event: MessageEvent<EncodeDone>) => {
          const {id, error} = event.data
          const pending = this.jobs.get(id)
          this.jobs.delete(id)
          if (error) pending?.reject(new Error(`capture: ${error}`))
          else pending?.resolve()
        })
        this.encoders.push({worker, busy: Promise.resolve()})
      }
    }
    const encoder = await Promise.race(this.encoders.map(encoder => encoder.busy.then(() => encoder)))
    const id = ++this.jobId
    const done = new Promise<void>((resolve, reject) => this.jobs.set(id, {resolve, reject}))
    encoder.busy = done.catch(() => {})
    encoder.worker.postMessage({...job, id, directory: this.directory} satisfies EncodeJob, [job.pixels.buffer])
    return {written: done.catch((error: Error) => {
      this.error ??= error
      this.stopped = true
    })}
  }

  /**
   * Draws a full-target quad with `material` (over what the target holds: the subframes add up), leaving the shared
   * renderer as found.
   */
  private render(target: RenderTarget, material: MeshBasicNodeMaterial) {
    const renderer: WebGPURenderer = this.viewport.renderer
    const previous = {
      target: renderer.getRenderTarget(), toneMapping: renderer.toneMapping, colorSpace: renderer.outputColorSpace, autoClear: renderer.autoClear,
    }
    try {
      renderer.autoClear = false
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = LinearSRGBColorSpace
      renderer.setRenderTarget(target)
      this.quad.material = material
      this.quad.render(renderer)
    } finally {
      renderer.setRenderTarget(previous.target)
      renderer.toneMapping = previous.toneMapping
      renderer.outputColorSpace = previous.colorSpace
      renderer.autoClear = previous.autoClear
    }
  }

  private pass(format: CaptureFormat) {
    const toneMappingType = this.viewport.view?.toneMapping ?? this.document.toneMapping
    let pass = this.passes.get(format)
    if (pass && pass.toneMapping === toneMappingType) return pass
    pass?.target.dispose()
    pass?.material.dispose()
    const sum = this.accumulation.texture
    // the exporter writes the rows bottom up, as WebGL reads them: sample upside down so the file is upright; the png
    // as the viewport presents, tone-mapped (the sum is exposed already), then encoded as the canvas is
    const material = format === 'exr'
      ? quadMaterial(vec4(texture(sum, vec2(screenUV.x, screenUV.y.oneMinus())).rgb, 1))
      : quadMaterial(workingToColorSpace(toneMapping(toneMappingType, float(1), vec4(texture(sum, screenUV).rgb, 1)), SRGBColorSpace))
    const target = new RenderTarget(this.width, this.height, {type: format === 'exr' ? HalfFloatType : UnsignedByteType, depthBuffer: false})
    pass = {target, material, toneMapping: toneMappingType}
    this.passes.set(format, pass)
    return pass
  }

  private dispose() {
    for (const pass of this.passes.values()) {
      pass.target.dispose()
      pass.material.dispose()
    }
    this.passes.clear()
    this.accumulation.dispose()
    this.firstSubframe.dispose()
    this.nextSubframe.dispose()
    for (const {worker} of this.encoders) worker.terminate()
    this.encoders = []
  }
}

function quadMaterial(colorNode: MeshBasicNodeMaterial['colorNode']) {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = colorNode
  material.blending = NoBlending
  material.depthTest = false
  material.depthWrite = false
  return material
}

/** The `index`th point (from 1) of the Halton sequence in `base`, in [0, 1). */
function halton(index: number, base: number) {
  let result = 0
  let fraction = 1 / base
  for (let i = index; i > 0; i = Math.floor(i / base), fraction /= base) result += fraction * (i % base)
  return result
}

function formatSeconds(seconds: number) {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
