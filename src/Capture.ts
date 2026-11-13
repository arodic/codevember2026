import {
  FloatType, HalfFloatType, LinearSRGBColorSpace, MathUtils, MeshBasicNodeMaterial, NearestFilter, NoBlending,
  NoToneMapping, OrthographicCamera, PerspectiveCamera, QuadMesh, Quaternion, RenderTarget, SRGBColorSpace, Texture,
  UnsignedByteType, Vector3,
} from 'three/webgpu'
import type { TextureNode, ToneMapping, WebGPURenderer } from 'three/webgpu'
import { float, screenUV, texture, toneMapping, uniform, vec2, vec4, workingToColorSpace } from 'three/tsl'
import type { Document } from '@io-gui/three'
import type { DrawnViewport } from './DrawnViewport.js'
import type { EncodeDone, EncodeJob } from './CaptureWorker.js'

/**
 * What a frame is saved as: `exr` the image as it reaches the tone mapping (linear Rec.709, the document's exposure
 * applied, half float, ZIP), for grading; `png` the image as the screen shows it (tone-mapped, sRGB, 8 bits). Either is
 * the average of the frame's subframes, summed in 32-bit float.
 */
export type CaptureFormat = 'exr' | 'png'

/** A camera's thin lens (`CaptureLens`), in world units. */
export type CaptureLensConfig = {
  /** Distance of the plane in focus ahead of the camera, along its view axis. */
  focusDistance: number
  /** Radius of the entrance pupil (`0` is a pinhole). */
  apertureRadius: number
  /** Iris blades (`0` or omitted: a round iris). */
  blades?: number
  /** How round the blades make the iris, from `0` (a polygon) to `1` (a circle); default `0.35`. */
  roundness?: number
}

/**
 * A document whose camera has a lens: a capture with `samples` draws its depth of field by looking through the lens
 * from as many points of its aperture, the plane in focus held still, and averaging what it sees.
 */
export interface CaptureLens {
  getCaptureLens(): CaptureLensConfig | null
}

/** A document that captures best with options of its own, which the options given to `capture` override. */
export interface CaptureDefaults {
  getCaptureDefaults(): CaptureOptions
}

export type CaptureOptions = {
  /** Size of the frames in pixels (default 4096 × 1716, DCI scope). */
  width?: number
  height?: number
  /** Frames per second of timeline time (default the timeline's frame rate). */
  fps?: number
  /** Seconds each frame keeps drawing before it is saved, refining what converges over draws (Fold's GI). Default 2. */
  settle?: number
  /** Timeline seconds to capture (default all of it). Frames are numbered from time 0, so a capture can resume. */
  from?: number
  to?: number
  /**
   * Seconds of timeline played before the first frame, a frame at a time, each drawn once and not saved, so that a
   * simulation comes to the first frame in motion (default 0). A looping timeline plays them from its end: frame 0 then
   * follows the last frame.
   */
  preroll?: number
  /** Default `exr`. */
  format?: CaptureFormat | CaptureFormat[]
  /**
   * Subframes averaged into each frame (default 1). Spread over the shutter, across the lens's aperture (`dof`) and
   * each a sub-pixel apart (`jitter`), they add up to motion blur, depth of field and anti-aliasing. The first settles;
   * each of the others draws once.
   */
  samples?: number
  /** The part of the frame interval the shutter is open, centered on the frame's time (default 0.5: 180°; 0 is no blur). */
  shutter?: number
  /**
   * Whether the subframes look through the document's lens (`CaptureLens`), each from its own point of the aperture
   * (default true; it takes `samples` > 1).
   */
  dof?: boolean
  /** The lens's aperture radius and focus distance (world units), in place of the document's. */
  aperture?: number
  focusDistance?: number
  /**
   * How far a document fills in between its lens samples' images, where it can (default 1; 0 leaves each sample as
   * drawn). Feather draws each fiber blurred across as the part of the aperture a sample stands for would blur it, so
   * the images of a defocused barbule merge into its bokeh instead of showing as fine copies of it.
   */
  fill?: number
  /** Whether the subframes move the camera a sub-pixel apart, anti-aliasing the frame (default true). */
  jitter?: boolean
  /** Where the frames go (default: a folder picker, which needs a user gesture; the DevTools console counts as one). */
  directory?: FileSystemDirectoryHandle
  /** File name prefix (default the document's name). */
  name?: string
}

/** The options `capture` takes. */
const OPTIONS: Record<keyof CaptureOptions, true> = {
  width: true, height: true, fps: true, settle: true, from: true, to: true, preroll: true, format: true, samples: true,
  shutter: true, dof: true, aperture: true, focusDistance: true, fill: true, jitter: true, directory: true, name: true,
}

/** Throws on an option `capture` doesn't take, such as a misspelt one, which would otherwise change nothing. */
export function checkCaptureOptions(options: object) {
  const unknown = Object.keys(options).filter(key => !Object.hasOwn(OPTIONS, key))
  if (unknown.length) throw new Error(`capture: no option ${unknown.join(', ')} (the options: ${Object.keys(OPTIONS).join(', ')})`)
}

export type CaptureResult = {frames: number; stopped: boolean; seconds: number}

/**
 * What a capture does: `preroll` plays the timeline up to the first frame, `settle` draws a frame's first subframe and
 * `subframes` its others; `off` once it is over.
 */
export type CaptureStage = 'off' | 'preroll' | 'settle' | 'subframes'

/** How a capture draws (`CaptureListener`). */
export type CaptureStageInfo = {
  /** Subframes averaged into each frame. */
  samples: number
  /**
   * The lens the subframes look through, from as many points of its aperture, spread evenly (`irisSample`); null: the
   * camera is a pinhole. A document drawing its own depth of field leaves it to the lens meanwhile.
   */
  lens: CaptureLensConfig | null
  /** How far the document fills in between the lens samples' images (`CaptureOptions.fill`). */
  fill: number
}

/**
 * A document that captures better knowing what the capture does: Fold computes its landscape in full while it
 * captures and refines its GI through the subframes; Feather simulates in fixed steps from rest and leaves its depth
 * of field to the lens.
 */
export interface CaptureListener {
  captureChanged(stage: CaptureStage, info: CaptureStageInfo): void
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

/** The golden angle: each point of a Vogel spiral turns by it from the one before. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Point `index` of `count` on the unit disc, along a Vogel (sunflower) spiral: the points spread evenly, each standing
 * for an equal part of the disc. `blades` (3 or more) shape the disc into an iris of that many sides, its corners on
 * the circle, rounded by `roundness` (0 a polygon, 1 the disc).
 */
export function irisSample(index: number, count: number, blades = 0, roundness = 0.35): {x: number; y: number} {
  let r = Math.sqrt((index + 0.5) / count)
  const phi = index * GOLDEN_ANGLE
  if (blades >= 3 && roundness < 1) {
    const sector = 2 * Math.PI / blades
    const edge = Math.cos(sector / 2) / Math.cos(phi - sector * Math.round(phi / sector))
    r *= MathUtils.lerp(edge, 1, MathUtils.clamp(roundness, 0, 1))
  }
  return {x: r * Math.cos(phi), y: r * Math.sin(phi)}
}

/**
 * Sets the view offset that keeps the plane `focusDistance` ahead of a perspective camera where it was in the picture
 * while the camera moves `(dx, dy)` along its right and up axes (world units): a point at depth `z` then moves by
 * `(z - focusDistance) / z` of that, as through a thin lens. The picture is `width × height` pixels, with the camera's
 * frame fitted inside it as io's views fit it (a picture narrower than the frame shows more above and below); `jitterX`
 * and `jitterY` move it that many pixels more. The offset is set in a picture of the camera's own aspect, which
 * `setViewOffset` would otherwise change to the picture's.
 */
export function setThinLensViewOffset(
  camera: PerspectiveCamera, dx: number, dy: number, focusDistance: number, width: number, height: number, jitterX = 0, jitterY = 0,
) {
  const aspect = width / height
  const halfHeight = focusDistance * Math.tan(MathUtils.degToRad(camera.fov / 2)) / Math.max(camera.zoom, 1e-6) *
    Math.max(1, camera.aspect / aspect)
  const fullWidth = width
  const fullHeight = width / camera.aspect
  const offsetX = (jitterX / width - dx / (2 * halfHeight * aspect)) * fullWidth
  const offsetY = (jitterY / height + dy / (2 * halfHeight)) * fullHeight
  camera.setViewOffset(fullWidth, fullHeight, offsetX, offsetY, fullWidth, fullHeight)
}

/**
 * A step through `count` items that comes back to the start only after visiting them all, in a well-mixed order: the
 * one nearest the golden ratio of `count` that is coprime with it.
 */
export function goldenStride(count: number) {
  let stride = Math.max(1, Math.round(count * (Math.sqrt(5) - 1) / 2))
  while (gcd(stride, count) !== 1) stride++
  return stride
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** Workers encoding and writing frames: EXR takes seconds a frame, so several overlap the frames that follow. */
const ENCODERS = 3

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const _right = new Vector3()
const _up = new Vector3()

/** The camera's own place, which the lens and the jitter move it from. */
type Pose = {position: Vector3; quaternion: Quaternion}

/**
 * Renders a document's timeline frame by frame through a viewport and saves each frame to a folder. The caller puts
 * the viewport on screen at the capture's resolution and pauses playback. The capture plays the timeline forward and
 * never back (a simulation follows it), after a `preroll` before the first frame. Each frame is the average of its
 * subframes (`samples`): at times spread over the shutter, each looking through its own point of the document's lens
 * (`CaptureLens`) with the plane in focus held still, and a sub-pixel apart (`jitter`). After each draw the pipeline's
 * linear output (the document's effects, no overlays), exposed, is added into a 32-bit float sum; a pass per format
 * reads the average.
 */
export class FrameCapture {

  readonly width: number
  readonly height: number
  readonly fps: number
  readonly settle: number
  readonly preroll: number
  readonly first: number
  readonly last: number
  readonly formats: CaptureFormat[]
  readonly name: string
  readonly samples: number
  readonly shutter: number
  readonly jitter: boolean
  /** The lens the subframes look through, or null: the camera stays a pinhole. */
  readonly lens: CaptureLensConfig | null
  readonly fill: number
  private stopped = false
  private viewport: DrawnViewport
  private document: Document
  private directory: FileSystemDirectoryHandle
  /**
   * Subframe `i` looks through lens sample `i × lensStride` (mod `samples`): the spiral runs from the middle of the
   * aperture out, and under an open shutter time and the lens would otherwise go together.
   */
  private lensStride: number
  /** The pipeline's output, the sum of the subframes before this one, the exposure and the weight of a subframe. */
  private output = texture(new Texture(), screenUV)
  private before = texture(new Texture(), screenUV)
  private exposure = uniform(1)
  private weight = uniform(1)
  /**
   * The sum of the subframes so far, and the target the next one adds into, swapped after each. 32-bit float: in half
   * floats the small additions of many subframes round away unevenly.
   */
  private sum: RenderTarget
  private spare: RenderTarget
  private firstSubframe: MeshBasicNodeMaterial
  private nextSubframe: MeshBasicNodeMaterial
  private quad = new QuadMesh(new MeshBasicNodeMaterial())
  private passes = new Map<CaptureFormat, {target: RenderTarget; material: MeshBasicNodeMaterial; sum: TextureNode; toneMapping: ToneMapping}>()
  private encoders: {worker: Worker; busy: Promise<void>}[] = []
  private jobs = new Map<number, {resolve: () => void; reject: (error: Error) => void}>()
  private jobId = 0
  private error: Error | null = null

  /** `given` overrides the document's own options (`CaptureDefaults`). */
  constructor(viewport: DrawnViewport, document: Document, directory: FileSystemDirectoryHandle, given: CaptureOptions & {name: string}) {
    checkCaptureOptions(given)
    const options = {
      ...(document as Partial<CaptureDefaults>).getCaptureDefaults?.(),
      ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    } as CaptureOptions & {name: string}
    this.viewport = viewport
    this.document = document
    this.directory = directory
    this.width = options.width ?? 4096
    this.height = options.height ?? 1716
    this.fps = options.fps ?? document.timeline.frameRate
    this.settle = options.settle ?? 2
    this.preroll = Math.max(0, options.preroll ?? 0)
    const duration = document.timeline.duration
    this.first = Math.max(0, Math.ceil((options.from ?? 0) * this.fps - 1e-6))
    this.last = Math.ceil(Math.min(options.to ?? duration, duration) * this.fps - 1e-6) - 1
    this.formats = [...new Set([options.format ?? 'exr'].flat())]
    this.name = options.name
    this.samples = Math.max(1, Math.round(options.samples ?? 1))
    this.shutter = Math.max(0, options.shutter ?? 0.5)
    this.jitter = options.jitter ?? true
    this.lens = this.samples > 1 && options.dof !== false ? documentLens(document, options) : null
    this.fill = Math.max(0, options.fill ?? 1)
    this.lensStride = goldenStride(this.samples)
    const limit = (viewport.renderer.backend as {device?: GPUDevice}).device?.limits.maxTextureDimension2D ?? 8192
    if (!(this.width >= 1 && this.height >= 1 && this.width <= limit && this.height <= limit)) {
      throw new Error(`capture: ${this.width} × ${this.height} is outside 1 … ${limit} pixels`)
    }
    // read texel by texel: 32-bit float textures need not be filterable
    const sum = {type: FloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter}
    this.sum = new RenderTarget(this.width, this.height, sum)
    this.spare = new RenderTarget(this.width, this.height, sum)
    const subframe = this.output.rgb.mul(this.exposure).mul(this.weight)
    this.firstSubframe = quadMaterial(vec4(subframe, 1))
    this.nextSubframe = quadMaterial(vec4(this.before.rgb.add(subframe), 1))
  }

  get frames() {
    return Math.max(0, this.last - this.first + 1)
  }

  stop() {
    this.stopped = true
  }

  async run(): Promise<CaptureResult> {
    const {frames, samples, lens} = this
    const started = performance.now()
    const written: Promise<void>[] = []
    const camera = this.document.activeCamera
    const aspect = camera instanceof PerspectiveCamera ? camera.aspect : 1
    const initial: Pose = {position: camera?.position.clone() ?? new Vector3(), quaternion: camera?.quaternion.clone() ?? new Quaternion()}
    const pose: Pose = {position: initial.position.clone(), quaternion: initial.quaternion.clone()}
    let done = 0
    const through = lens ? `, through the lens (aperture ${lens.apertureRadius}, focus ${lens.focusDistance}, fill ${this.fill})` : ''
    const detail = samples > 1
      ? `, ${samples} subframes${this.shutter > 0 ? ` over ${this.shutter} of a frame` : ''}${through}${this.jitter ? ', jittered' : ''}`
      : ''
    console.info(`capture: ${frames} frames of ${this.name} at ${this.width} × ${this.height}, ${this.fps} fps, ` +
      `${this.settle} s each${detail} (${this.formats.join(', ')}); Escape or stopCapture() stops`)
    try {
      if (await this.playPreroll()) {
        frames: for (let frame = this.first; frame <= this.last && !this.stopped; frame++) {
          for (let subframe = 0; subframe < samples; subframe++) {
            this.stage(subframe === 0 ? 'settle' : 'subframes')
            this.place(frame, subframe, pose)
            if (!await this.drawn(subframe === 0 ? this.settle : 0)) break frames
            this.accumulate(subframe)
          }
          const names = await this.read(frame, written)
          done++
          const elapsed = (performance.now() - started) / 1000
          const eta = elapsed / done * (frames - done)
          console.info(`capture: ${names.join(', ')} (${done}/${frames}, ${(elapsed / done).toFixed(1)} s a frame, ${formatSeconds(eta)} left)`)
        }
      }
      await Promise.all(written)
    } finally {
      if (camera) {
        camera.position.copy(initial.position)
        camera.quaternion.copy(initial.quaternion)
      }
      if (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera) {
        camera.clearViewOffset()
        if (camera instanceof PerspectiveCamera) camera.aspect = aspect
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld()
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
    const listener = this.document as Partial<CaptureListener>
    listener.captureChanged?.(stage, {samples: this.samples, lens: this.lens, fill: this.fill})
  }

  /**
   * Plays the `preroll` seconds before the first frame, a frame at a time, each drawn once and not kept (a looping
   * timeline plays them from its end); false once the capture is stopped.
   */
  private async playPreroll() {
    const count = Math.round(this.preroll * this.fps)
    if (count <= 0) return true
    const timeline = this.document.timeline
    console.info(`capture: playing the ${formatSeconds(count / this.fps)} before the first frame`)
    this.stage('preroll')
    for (let k = count; k > 0; k--) {
      let time = (this.first - k) / this.fps
      if (time < 0) {
        if (!timeline.loop) continue
        time += timeline.duration
      }
      timeline.currentTime = time
      this.viewport.tag('content')
      if (!await this.drawn(0)) return false
    }
    return true
  }

  /**
   * Moves the timeline to a subframe's time on the shutter and the camera to the subframe's point of the lens's
   * aperture, holding the plane in focus still (`setThinLensViewOffset`), and a Halton (2, 3) sub-pixel apart.
   */
  private place(frame: number, subframe: number, pose: Pose) {
    const {document, samples} = this
    const camera = document.activeCamera
    if (camera) {
      camera.position.copy(pose.position)
      camera.quaternion.copy(pose.quaternion)
    }
    const offset = ((subframe + 0.5) / samples - 0.5) * this.shutter
    document.timeline.currentTime = Math.min(Math.max((frame + offset) / this.fps, 0), document.timeline.duration)
    // the document may have moved the camera (Fold flies it): the lens and the jitter move it from there
    if (camera) {
      pose.position.copy(camera.position)
      pose.quaternion.copy(camera.quaternion)
    }
    if (samples > 1 && (camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera)) {
      const {width, height, lens} = this
      const jitterX = this.jitter ? halton(subframe + 1, 2) - 0.5 : 0
      const jitterY = this.jitter ? halton(subframe + 1, 3) - 0.5 : 0
      if (camera instanceof PerspectiveCamera) {
        const iris = lens ? irisSample(subframe * this.lensStride % samples, samples, lens.blades, lens.roundness) : {x: 0, y: 0}
        const dx = iris.x * (lens?.apertureRadius ?? 0)
        const dy = iris.y * (lens?.apertureRadius ?? 0)
        _right.set(1, 0, 0).applyQuaternion(pose.quaternion)
        _up.set(0, 1, 0).applyQuaternion(pose.quaternion)
        camera.position.copy(pose.position).addScaledVector(_right, dx).addScaledVector(_up, dy)
        camera.updateMatrixWorld()
        setThinLensViewOffset(camera, dx, dy, lens?.focusDistance ?? 1, width, height, jitterX, jitterY)
      } else {
        camera.setViewOffset(width, height, jitterX, jitterY, width, height)
      }
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

  /** Adds the viewport's last draw, exposed and weighted, to the sum of the subframes (the first starts it). */
  private accumulate(subframe: number) {
    const output = this.viewport.compositor.pipeline?.output
    if (!output) throw new Error('capture: the viewport has drawn nothing')
    this.output.value = output.color
    this.before.value = this.sum.texture
    this.exposure.value = this.viewport.view?.toneMappingExposure ?? this.document.toneMappingExposure
    this.weight.value = 1 / this.samples
    this.render(this.spare, subframe === 0 ? this.firstSubframe : this.nextSubframe)
    const sum = this.spare
    this.spare = this.sum
    this.sum = sum
  }

  /** Reads the frame in each format and hands it to an encoder; adds the writes to `written`. */
  private async read(frame: number, written: Promise<void>[]): Promise<string[]> {
    const renderer = this.viewport.renderer
    const number = String(frame).padStart(5, '0')
    const names: string[] = []
    for (const format of this.formats) {
      const pass = this.pass(format)
      pass.sum.value = this.sum.texture
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

  /** Draws a full-target quad with `material` into `target`, leaving the shared renderer as found. */
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
    // the exporter writes the rows bottom up, as WebGL reads them: sample upside down so the file is upright; the png
    // as the viewport presents, tone-mapped (the sum is exposed already), then encoded as the canvas is
    const sum = texture(this.sum.texture, format === 'exr' ? vec2(screenUV.x, screenUV.y.oneMinus()) : screenUV)
    const material = format === 'exr'
      ? quadMaterial(vec4(sum.rgb, 1))
      : quadMaterial(workingToColorSpace(toneMapping(toneMappingType, float(1), vec4(sum.rgb, 1)), SRGBColorSpace))
    const target = new RenderTarget(this.width, this.height, {type: format === 'exr' ? HalfFloatType : UnsignedByteType, depthBuffer: false})
    pass = {target, material, sum, toneMapping: toneMappingType}
    this.passes.set(format, pass)
    return pass
  }

  private dispose() {
    for (const pass of this.passes.values()) {
      pass.target.dispose()
      pass.material.dispose()
    }
    this.passes.clear()
    this.sum.dispose()
    this.spare.dispose()
    this.firstSubframe.dispose()
    this.nextSubframe.dispose()
    for (const {worker} of this.encoders) worker.terminate()
    this.encoders = []
  }
}

/** The document's lens with the options' changes, or null: it has none, or a pinhole. */
function documentLens(document: Document, options: CaptureOptions): CaptureLensConfig | null {
  if (!(document.activeCamera instanceof PerspectiveCamera)) return null
  const lens = (document as Partial<CaptureLens>).getCaptureLens?.() ?? null
  const focusDistance = options.focusDistance ?? lens?.focusDistance ?? 0
  const apertureRadius = options.aperture ?? lens?.apertureRadius ?? 0
  if (!(focusDistance > 0 && apertureRadius > 0)) return null
  return {focusDistance, apertureRadius, blades: lens?.blades, roundness: lens?.roundness}
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
export function halton(index: number, base: number) {
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
