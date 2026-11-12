import { IoCodevember } from './IoCodevember.js'
import type { CaptureOptions } from './Capture.js'

const app = new IoCodevember({id: 'Three'})
document.body.appendChild(app as HTMLElement)

// frame capture from the console: `capture({width: 4096, height: 1716, settle: 2, format: ['exr', 'png'], motionBlurFrames: 8, shutter: 0.5})`
Object.assign(window, {
  capture: (options?: CaptureOptions) => app.capture(options),
  stopCapture: () => app.stopCapture(),
})
