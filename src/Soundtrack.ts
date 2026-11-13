import { MathUtils } from 'three/webgpu'
import type { Document } from '@io-gui/three'

/**
 * How far the soundtrack may part from the timeline (seconds) before it is moved to the playhead: a scrub, or the loop's
 * wrap. Short of that it plays on its own clock (a little drift is fine; easing its rate as it plays crackles).
 */
const SLACK = 1

/**
 * A document's music, played with its timeline, which it makes as long as itself once it has loaded. The document
 * passes on when the editor starts or stops playing it (`playbackChanged`, see `PlaybackListener`) and each time its
 * timeline animates (`sync`).
 */
export class Soundtrack {

  private readonly audio: HTMLAudioElement
  /** Whether the editor plays the document. */
  private playing = false
  /** Whether the browser holds the sound back until a gesture. */
  private held = false

  constructor(url: string, private readonly document: Document) {
    this.audio = Object.assign(new Audio(url), {preload: 'auto', loop: false})
    this.audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(this.audio.duration)) this.document.timeline.duration = this.audio.duration
    })
  }

  set volume(volume: number) {
    this.audio.volume = MathUtils.clamp(volume, 0, 1)
  }

  /** The editor started or stopped playing the document: the music plays along. */
  playbackChanged(playing: boolean) {
    this.playing = playing
    if (playing) this.play()
    else this.audio.pause()
  }

  /**
   * Keeps the music loosely with the timeline at `time` while it plays: it starts at the playhead (`play`) and is moved
   * there again only when the two part by more than `SLACK` (a scrub, the loop's wrap); having ended a moment early, it
   * waits for the wrap.
   */
  sync(time: number) {
    const audio = this.audio
    if (!this.playing || this.held || audio.readyState < HTMLMediaElement.HAVE_METADATA) return
    if (audio.ended && time > audio.duration - SLACK) return
    if (audio.paused || Math.abs(audio.currentTime - time) > SLACK) this.play()
  }

  /**
   * Starts the music where the timeline is. Browsers hold sound back until the page has been touched: then it starts
   * with the first pointer press or key, if the document still plays.
   */
  private play() {
    const audio = this.audio
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) audio.currentTime = this.document.timeline.currentTime
    audio.play().then(() => {
      this.held = false
    }, (error: DOMException) => {
      if (error.name !== 'NotAllowedError' || this.held) return
      this.held = true
      const resume = () => {
        window.removeEventListener('pointerdown', resume, true)
        window.removeEventListener('keydown', resume, true)
        this.held = false
        if (this.playing) this.play()
      }
      window.addEventListener('pointerdown', resume, true)
      window.addEventListener('keydown', resume, true)
    })
  }

  dispose() {
    this.playing = false
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }
}
