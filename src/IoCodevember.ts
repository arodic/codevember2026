import { Register, ReactiveElement, ReactiveElementProps, Property, div, Field, Storage as $, isReactiveNode } from '@io-gui/core'
import { IoField, ioField, ioButton } from '@io-gui/inputs'
import { IoPropertyEditor, ioPropertyEditor } from '@io-gui/editors'
import { ioOptionSelect, Menu } from '@io-gui/menus'
import { Object3D } from 'three/webgpu'
import { SelectionModel, Document, Editor, View, ViewOverlays, ThreeViewport, threeTimeline, threeScenegraph, threeViewSettings, renderScheduler, ScheduledTicker } from '@io-gui/three'
import { ioLayout, IoTab, Layout } from '@io-gui/layout'
import { threeEditorStatus } from './ThreeEditorStatus.js'
import { documentHeader } from './DocumentHeader.js'
import { drawnViewport, DocumentDrawn, DrawnViewport } from './DrawnViewport.js'
import { CaptureOptions, CaptureResult, FrameCapture, pickCaptureDirectory } from './Capture.js'

const editorLayout = new Layout({
  child: {
      type: 'split',
      children: [
        {
          type: 'panel',
          size: '240px',
          tabs: [
            { id: 'Scene' }
          ]
        }, {
          type: 'split',
          size: 'auto',
          children: [
            {
              type: 'panel',
              tabs: [
                { id: 'Front', selected: true },
                { id: 'Back' }
              ]
            }, {
              type: 'panel',
              tabs: [
                { id: 'Perspective', selected: true },
                { id: 'Right' },
                { id: 'Left' }
              ]
            }
          ],
          orientation: 'vertical'
      }, {
          type: 'split',
          size: 'auto',
          children: [
            {
              type: 'panel',
              tabs: [
                { id: 'Top', selected: true },
                { id: 'Bottom' }
              ]
            }, {
              type: 'panel',
              tabs: [
                { id: 'UV' },
                { id: 'Active', selected: true },
              ]
            }
          ],
          orientation: 'vertical'
      }, {
        type: 'panel',
        size: '280px',
        tabs: [
          { id: 'Document', selected: true  },
          { id: 'Inspector' },
          { id: 'View' },
        ]
      }
    ]
  }
})

// Document subclasses, imported when first opened.
const DOCUMENTS: Record<string, () => Promise<Document>> = {
  Fold: () => import('./days/Fold.js').then(module => new module.Fold()),
  // Shatter: () => import('./days/Shatter.js').then(module => new module.Shatter()),
  // Melt: () => import('./days/Melt.js').then(module => new module.Melt()),
  // Tangle: () => import('./days/Tangle.js').then(module => new module.Tangle()),
  // Moss: () => import('./days/Moss.js').then(module => new module.Moss()),
  // Orrery: () => import('./days/Orrery.js').then(module => new module.Orrery()),
  // Hollow: () => import('./days/Hollow.js').then(module => new module.Hollow()),
  // Tesseract: () => import('./days/Tesseract.js').then(module => new module.Tesseract()),
  // Membrane: () => import('./days/Membrane.js').then(module => new module.Membrane()),
  // Caustic: () => import('./days/Caustic.js').then(module => new module.Caustic()),
  // Rust: () => import('./days/Rust.js').then(module => new module.Rust()),
  // Feather: () => import('./days/Feather.js').then(module => new module.Feather()),
  // Labyrinth: () => import('./days/Labyrinth.js').then(module => new module.Labyrinth()),
  // Tension: () => import('./days/Tension.js').then(module => new module.Tension()),
  // Mirage: () => import('./days/Mirage.js').then(module => new module.Mirage()),
  // Spore: () => import('./days/Spore.js').then(module => new module.Spore()),
  // Kelp: () => import('./days/Kelp.js').then(module => new module.Kelp()),
  // Pendulum: () => import('./days/Pendulum.js').then(module => new module.Pendulum()),
  // Erosion: () => import('./days/Erosion.js').then(module => new module.Erosion()),
  // Cocoon: () => import('./days/Cocoon.js').then(module => new module.Cocoon()),
  // Bolt: () => import('./days/Bolt.js').then(module => new module.Bolt()),
  // Echo: () => import('./days/Echo.js').then(module => new module.Echo()),
  // Magma: () => import('./days/Magma.js').then(module => new module.Magma()),
  // Nest: () => import('./days/Nest.js').then(module => new module.Nest()),
  // Veil: () => import('./days/Veil.js').then(module => new module.Veil()),
  // Anamorph: () => import('./days/Anamorph.js').then(module => new module.Anamorph()),
  // Burrow: () => import('./days/Burrow.js').then(module => new module.Burrow()),
  // Hive: () => import('./days/Hive.js').then(module => new module.Hive()),
  // Portal: () => import('./days/Portal.js').then(module => new module.Portal()),
  // Dissolve: () => import('./days/Dissolve.js').then(module => new module.Dissolve()),
}

const EXAMPLE_MENU = new Menu({
  id: 'codevember-menu',
  options: Object.keys(DOCUMENTS).map(name => ({id: name})),
  selectedID: $({key: 'codevember', storage: 'hash', value: ''})
})
let _SELECTED_EXAMPLE = 'Fold'

let _isPlaying = false

/**
 * A document that plays sound with its timeline: told when the editor starts playing it and when that stops (paused,
 * or another document opened, or the host leaves the page).
 */
export interface PlaybackListener {
  playbackChanged(playing: boolean): void
}

/** The layout's viewport tabs, by id, and the view each shows (a key of `IoCodevember.views`). */
const VIEWPORTS = {
  Top: 'top',
  Bottom: 'bottom',
  Left: 'left',
  Right: 'right',
  Front: 'front',
  Back: 'back',
  Perspective: 'perspective',
  UV: 'uv',
  Active: 'camera',
} as const

/** Whether what the key event reached handles Space itself: a field or button, the timeline's scrub bar, or edited text. */
function handlesSpace(event: KeyboardEvent) {
  return event.composedPath().some(target => target instanceof IoField || (target instanceof HTMLElement && (
    target.localName === 'three-timeline-range' || target.isContentEditable || target.localName === 'input' || target.localName === 'textarea'
  )))
}

/** What the 3D views draw over the content: overlays are off unless a view turns them on. */
const VIEW_OVERLAYS: ViewOverlays = {
  grid: true,
  components: true,
  selection: true,
  cameraFrame: false,
  cameraHelpers: true,
  lightHelpers: true,
  skeletonHelpers: true,
  clippingHelpers: true,
  probeHelpers: true,
  gizmos: true,
}

/**
 * One Editor in tabbed views, each with its own pipeline (ADR-0006) and interaction profile: a forward
 * perspective view with the Move tool, select-only axis views post-processed with TRAA, and a
 * select-only UV view of the selection, and a select-only Camera view through the document's active camera (the source
 * example's camera; ADR-0011).
 * The 3D views turn on every overlay (`VIEW_OVERLAYS`). The Camera view draws only the camera frame, no grid or
 * helpers, so it shows the document as its source does. It follows the document's active camera, so it draws the
 * document's effects (bloom, ADR-0013); the navigation views draw none. The View tab shows the view focused or selected
 * last, first the Camera view (`ThreeViewSettings`): its overlays and the document's effects as checklists, the buffer
 * it displays (ADR-0014), then its other settings.
 * The inspector follows the active object; the Document tab shows the document's own properties. The Scene tab is
 * the document's scene graph: click a row to select its object, its triangle to collapse it, double-click or F2 to
 * rename it; what is collapsed is kept in localStorage by object uuid. Selecting in a view reveals the object there.
 * The heading buttons load a Document subclass and make it the editor's document. Each loaded document keeps
 * its edits, selection and view navigation when switching back (ADR-0002). The timeline above the status bar plays, steps
 * and scrubs the document's timeline, whose current time drives its `onAnimate`; opening a document plays or pauses it
 * by its timeline's `autoplay`. A document with `playbackChanged` (`PlaybackListener`) hears when it starts and stops
 * playing, to play its sound with the timeline.
 * Until a viewport has drawn the document asked for (`DrawnViewport`), a loading cover hides the editor and timeline.
 * Fullscreen (Escape leaves it) hides the editor and shows the document through its own camera view and viewport,
 * outside the layout: a viewport of exactly the camera's frame on black, with the timeline and the document's header under it.
 * Click selects (Shift toggles, Ctrl removes), Alt+drag box-selects, Ctrl+A selects all, Escape clears, F frames the
 * selection. Drag a gizmo arrow to move along an axis, the center to move in the view plane; X / Y / Z switch the
 * axis while dragging, Escape or right click cancels. Tab enters edit mode on the selection; 1 / 2 / 3 pick points,
 * edges or faces; the UV view then edits UVs of the faces selected in 3D.
 */
@Register
export class IoCodevember extends ReactiveElement {

  static override get Style() {
    return /* css */`
      :host {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        max-width: 100%;
        max-height: 100%;
        font-family: 'Courier New', Courier, monospace;
        letter-spacing: 0.3px !important;
        --io_fontSize: 11px;
      }
      :host > .heading {
        display: flex;
        flex-wrap: wrap;
        gap: var(--io_spacing);
        padding: var(--io_spacing);
        background-color: var(--io_bgColorStrong);
      }
      /* Fullscreen shows its own viewport, outside the layout: the layout may collapse any panel into a drawer, whose
         transform would hold a fixed viewport inside it (a landscape phone collapses the Active panel). The hidden
         layout's viewports stop rendering (their visibility observer says so), and so does the hidden fullscreen one. */
      :host > .fullscreen {
        display: none;
      }
      :host[fullscreen] > .heading,
      :host[fullscreen] > .content,
      :host[fullscreen] > three-editor-status {
        display: none;
      }
      /* The fullscreen viewport is the active camera's frame (aspect --frame-aspect) and nothing more: the view fits the
         frame with overscan 1, so it draws no pixel outside it, and the screen around it is black. The frame is as
         large as fits the width and leaves room under it for the timeline and the header (--below-frame); centered,
         unless that room runs out, then it rises until it ends where the room starts. */
      :host {
        --below-frame: calc(var(--io_lineHeight) * 4 + var(--io_spacing2) * 2);
        --frame-height: min(100vw / var(--frame-aspect, 2.39), 100dvh - var(--below-frame));
        --frame-top: min((100dvh - var(--frame-height)) / 2, 100dvh - var(--below-frame) - var(--frame-height));
        --frame-bottom: calc(var(--frame-top) + var(--frame-height));
      }
      :host[fullscreen] > .fullscreen {
        display: block;
        position: fixed;
        inset: 0;
        z-index: 1000;
        background-color: black;
      }
      :host > .fullscreen > drawn-viewport {
        position: absolute;
        top: var(--frame-top);
        left: calc((100vw - var(--frame-height) * var(--frame-aspect, 2.39)) / 2);
        width: calc(var(--frame-height) * var(--frame-aspect, 2.39));
        height: var(--frame-height);
      }
      :host[fullscreen] > three-timeline,
      :host > .fullscreen > document-header {
        position: fixed;
        top: var(--frame-bottom);
        left: 0;
        width: 100%;
      }
      :host[fullscreen] > three-timeline {
        align-items: flex-start;
        z-index: 1001;
      }
      :host > .fullscreen > document-header {
        z-index: 1;
        transform: translateY(calc(var(--io_lineHeight) * 2));
        text-align: center;
        color: white;
      }
      /* Until the document asked for is on screen, a cover hides the editor and the timeline: before then play would
         play the document still shown (at first, an empty one), or wait on its shaders. The viewports keep drawing
         under it (their visibility observer ignores it), which is what lifts it. */
      :host > .loading {
        position: fixed;
        inset: 0;
        z-index: 2000;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: black;
        color: white;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.25s ease-out;
      }
      :host[loading] > .loading {
        opacity: 1;
        pointer-events: auto;
        transition: none;
      }
      /* A capture shows the frames alone; its canvas keeps the capture's pixels and is fitted to the frame. */
      :host[capturing] > three-timeline,
      :host[capturing] > .fullscreen > document-header {
        display: none;
      }
      :host[capturing] > .fullscreen > drawn-viewport > canvas {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain;
      }
    `
  }

  @Property({type: Editor, init: null})
  declare editor: Editor

  @Field({
    top: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    bottom: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    left: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    right: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    front: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    back: new View({pipeline: 'traa', overlays: VIEW_OVERLAYS}),
    perspective: new View({overlays: VIEW_OVERLAYS}),
    uv: new View({kind: 'uv', profile: 'select' }),
    camera: new View({profile: 'select', overscan: 1, overlays: { cameraFrame: true }}),
    fullscreen: new View({profile: 'select', overscan: 1}),
  })
  declare views: Record<'top' | 'bottom' | 'left' | 'right' | 'front' | 'back' | 'perspective' | 'uv' | 'camera' | 'fullscreen', View>

  /** Selection of the editor's current document; each document has its own. */
  @Property({type: SelectionModel})
  declare selection: SelectionModel

  /**
   * The inspected object. The layout keeps the inspector it first rendered, so it binds to this rather than to the
   * selection of one document.
   */
  @Property({type: Object3D, value: undefined})
  declare activeObject: Object3D | undefined

  /** The view of the viewport focused or selected last, shown in the View tab. */
  @Property({type: View, value: undefined})
  declare activeView: View | undefined

  /** The document last asked for; it becomes the editor's document once loaded. */
  @Property({type: String, value: ''})
  declare documentName: string

  @Property({type: Boolean, value: true, reflect: true})
  declare fullscreen: boolean

  /** Whether the document asked for is not on screen yet (`document-drawn`): the loading cover is up meanwhile. */
  @Property({type: Boolean, value: true, reflect: true})
  declare loading: boolean

  /** Whether frames are being captured (`capture`). */
  @Property({type: Boolean, value: false, reflect: true})
  declare capturing: boolean

  /** Documents a viewport has drawn: switching back to one shows it at once. */
  @Field(WeakSet)
  declare private _drawnDocuments: WeakSet<Document>

  /** The document asked for last, once loaded and made the editor's document (null while it loads). */
  private _openedDocument: Document | null = null

  /** Loaded documents by name. A Field: `ready()` runs inside the base constructor. */
  @Field(Map)
  declare private _documents: Map<string, Promise<Document>>

  /** The capture under way. */
  private _capture: FrameCapture | null = null

  /** The document time the inspector tabs last showed. */
  private _shownTime = NaN

  /** The document the editor plays now (told `playbackChanged(false)` when that stops). */
  private _playing: Document | null = null

  /** Refreshes the inspector tabs each frame document time has moved (`refreshInspectors`). */
  private readonly _inspectorTicker: ScheduledTicker = {
    host: this,
    get document() {
      return this.host.editor.document
    },
    tick() {
      this.host.refreshInspectors()
    },
  } as ScheduledTicker & {host: IoCodevember}

  static override get Listeners() {
    return {
      'focusin': 'onFocusIn',
      'go-fullscreen': 'goFullscreen',
      'document-drawn': 'onDocumentDrawn',
    }
  }

  /**
   * Animation moves plain objects that dispatch no mutations: a mixer's time, camera matrices, morph weights. When
   * document time has moved, the Document and Inspector tabs re-read what they show: their property editors re-read
   * their fields, and every plain object they show gets an `io-mutation`, which the editors showing it handle.
   * Reactive objects are left alone: they report their own changes, and a mutation of one would change the document.
   */
  refreshInspectors() {
    const time = this.editor.document.timeline.currentTime
    if (time === this._shownTime) return
    this._shownTime = time
    const shown = new Set<object>()
    for (const id of ['Document', 'Inspector']) {
      const tab = this.querySelector(`#${id}`)
      if (!tab) continue
      for (const element of [tab, ...tab.querySelectorAll('*')]) {
        if (element instanceof IoPropertyEditor) element.changedThrottled()
        const value = (element as {value?: unknown}).value
        if (value && typeof value === 'object' && !isReactiveNode(value)) shown.add(value)
      }
    }
    for (const object of shown) this.dispatchMutation(object)
  }

  /**
   * A viewport takes focus on pointer down, and so does a viewport's tab when it is pressed or selected: show that
   * viewport's view. A tab takes focus before its panel shows the viewport, so its view is found by the tab's id.
   */
  onFocusIn(event: FocusEvent) {
    const path = event.composedPath()
    const viewport = path.find(target => target instanceof ThreeViewport) as ThreeViewport | undefined
    const tab = path.find(target => target instanceof IoTab) as IoTab | undefined
    const shown = tab && VIEWPORTS[tab.model.id as keyof typeof VIEWPORTS]
    const view = viewport?.view ?? (shown ? this.views[shown] : undefined)
    // the fullscreen view has no settings to show: the View tab keeps the editor's view
    if (view && view !== this.views.fullscreen) this.activeView = view
  }

  /**
   * Page-wide keys, whatever has focus (a window listener): Escape leaves fullscreen; Space plays or pauses, unless a
   * field or button has it (it presses that) or the timeline's scrub bar does (it toggles playback itself), or text is edited.
   */
  onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || this.loading) return
    if (this.capturing) {
      if (event.key === 'Escape') this.stopCapture()
      return
    }
    if (event.key === 'Escape' && this.fullscreen) {
      this.fullscreen = false
    } else if (event.code === 'Space' && !event.repeat && !handlesSpace(event)) {
      event.preventDefault()
      this.editor.isPlaying = !this.editor.isPlaying
    }
  }

  goFullscreen() {
    this.fullscreen = true
  }

  /**
   * Captures the editor's document frame by frame to a folder (`FrameCapture`; from the console, `capture(options)`):
   * fullscreen, at the capture's resolution, paused, without the timeline. Afterwards the time, playback and
   * fullscreen are as they were. Escape or `stopCapture()` stops it.
   */
  async capture(options: CaptureOptions = {}): Promise<CaptureResult> {
    if (this._capture) throw new Error('capture: already capturing (stopCapture() stops it)')
    if (this.loading) throw new Error('capture: the document is still loading')
    // the picker first, while the gesture that asked for the capture counts
    const directory = await (options.directory ?? pickCaptureDirectory())
    const document = this.editor.document
    const viewport = this.querySelector('#Fullscreen') as DrawnViewport
    const capture = new FrameCapture(viewport, document, directory, {...options, name: options.name ?? this.documentName.toLowerCase()})
    const was = {fullscreen: this.fullscreen, playing: this.editor.isPlaying, time: document.timeline.currentTime}
    this._capture = capture
    this.editor.isPlaying = false
    this.fullscreen = true
    this.capturing = true
    viewport.resolution = {width: capture.width, height: capture.height}
    try {
      return await capture.run()
    } finally {
      this._capture = null
      viewport.resolution = null
      this.capturing = false
      this.fullscreen = was.fullscreen
      document.timeline.currentTime = was.time
      this.editor.isPlaying = was.playing
    }
  }

  /** Stops the capture under way after the frame in hand. */
  stopCapture() {
    this._capture?.stop()
  }

  /** A viewport drew a document for the first time: once that is the document asked for, lift the loading cover. */
  onDocumentDrawn(event: CustomEvent<DocumentDrawn>) {
    event.stopPropagation()
    const document = event.detail.document
    this._drawnDocuments.add(document)
    if (document === this._openedDocument) this.loading = false
  }

  fullscreenChanged() {
    this.updateFrameAspect()
  }

  /** The fullscreen timeline and header sit under the frame of the camera the fullscreen view looks through. */
  updateFrameAspect() {
    const document = this.editor?.document
    const view = this.views?.fullscreen
    if (this.fullscreen && document && view) this.style.setProperty('--frame-aspect', String(view.getFrameAspect(1, 1, document)))
  }

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('keydown', this.onKeyDown)
    renderScheduler.addTicker(this._inspectorTicker)
    if (!EXAMPLE_MENU.selectedID) {
      EXAMPLE_MENU.selectedID = _SELECTED_EXAMPLE
    } else {
      void this.open(EXAMPLE_MENU.selectedID)
    }
    this.editor.isPlaying = _isPlaying
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    window.removeEventListener('keydown', this.onKeyDown)
    renderScheduler.removeTicker(this._inspectorTicker)
    _SELECTED_EXAMPLE = EXAMPLE_MENU.selectedID
    EXAMPLE_MENU.selectedID = ''
    _isPlaying = this.editor.isPlaying
    this.editor.isPlaying = false
  }

  onExampleSelected(event: CustomEvent<{value: string}>) {
    void this.open(event.detail.value)
  }

  /** Tells the documents that listen (`PlaybackListener`) when the editor starts or stops playing them. */
  onPlaybackChanged() {
    const playing = this.editor.isPlaying ? this.editor.document : null
    if (playing === this._playing) return
    const listener = (document: Document | null) => document as Partial<PlaybackListener> | null
    listener(this._playing)?.playbackChanged?.(false)
    this._playing = playing
    listener(playing)?.playbackChanged?.(true)
  }

  override ready() {
    this.views.top.setAxisView('top')
    this.views.bottom.setAxisView('bottom')
    this.views.left.setAxisView('left')
    this.views.right.setAxisView('right')
    this.views.front.setAxisView('front')
    this.views.back.setAxisView('back')
    this.views.perspective.setAxisView('free')
    this.views.camera.setCameraView()
    this.views.fullscreen.setCameraView()
    // The view the layout shows first in its panel, which presents the document.
    this.activeView = this.views.camera

    this.editor.setActiveTool('3d', 'object', 'transform.translate')
    this.selection = this.editor.selection

    EXAMPLE_MENU.addEventListener('selectedID-changed', this.onExampleSelected)
    this.editor.addEventListener('isPlaying-changed', this.onPlaybackChanged)
    this.editor.addEventListener('document-changed', this.onPlaybackChanged)

    const onNextExample = () => {
      const currentIndex = EXAMPLE_MENU.options.findIndex(option => option.id === EXAMPLE_MENU.selectedID)
      const nextIndex = (currentIndex + 1) % EXAMPLE_MENU.options.length
      EXAMPLE_MENU.selectedID = EXAMPLE_MENU.options[nextIndex].id
    }

    const onPreviousExample = () => {
      const currentIndex = EXAMPLE_MENU.options.findIndex(option => option.id === EXAMPLE_MENU.selectedID)
      const previousIndex = (currentIndex - 1 + EXAMPLE_MENU.options.length) % EXAMPLE_MENU.options.length
      EXAMPLE_MENU.selectedID = EXAMPLE_MENU.options[previousIndex].id
    }

    this.render([
      div({class: 'heading'}, [
        ioButton({ label: '', icon: 'io:chevron_left', action: onPreviousExample }),
        ioOptionSelect({ label: 'Load', model: EXAMPLE_MENU }),
        ioButton({ label: '', icon: 'io:chevron_right', action: onNextExample }),
        ioField({value: this.bind('documentName')}),
      ]),
      ioLayout({class: 'content',
        model: editorLayout,
        elements: [
          ...Object.entries(VIEWPORTS).map(([id, view]) => ({group: 'view', ...drawnViewport({id, editor: this.editor, view: this.views[view]})})),
          threeScenegraph({
            id: 'Scene',
            editor: this.editor,
            disclosure: $<Record<string, boolean>>({key: 'three-scenegraph-disclosure', storage: 'local', value: {}}),
          }),
          ioPropertyEditor({id: 'Inspector', value: this.bind('activeObject')}),
          threeViewSettings({id: 'View', editor: this.editor, view: this.bind('activeView')}),
          ioPropertyEditor({id: 'Document', value: this.editor.bind('document'), labelWidth: '4.5rem'}),
        ]
      }),
      div({class: 'fullscreen'}, [
        drawnViewport({id: 'Fullscreen', editor: this.editor, view: this.views.fullscreen}),
        documentHeader({editor: this.editor}),
      ]),
      threeTimeline({editor: this.editor}),
      threeEditorStatus({editor: this.editor}),
      div({class: 'loading'}, 'loading'),
    ])
  }

  editorMutated() {
    this.selection = this.editor.selection
  }

  selectionChanged() {
    this.activeObject = this.selection.activeObject
  }

  selectionMutated() {
    this.activeObject = this.selection.activeObject
  }

  async open(name: string) {
    this.documentName = name
    this._openedDocument = null
    this.loading = true
    let loading = this._documents.get(name)
    if (!loading) {
      loading = DOCUMENTS[name]()
      this._documents.set(name, loading)
    }
    const document = await loading
    // Another document may have been asked for while this one loaded.
    if (this.documentName !== name) return
    this.editor.document = document
    this.editor.isPlaying = document.timeline.autoplay
    this.updateFrameAspect()
    this._openedDocument = document
    this.loading = !this._drawnDocuments.has(document)
  }

  override dispose() {
    this.editor.dispose()
    this.views.front.dispose()
    this.views.back.dispose()
    this.views.top.dispose()
    this.views.bottom.dispose()
    this.views.left.dispose()
    this.views.right.dispose()
    this.views.perspective.dispose()
    this.views.uv.dispose()
    this.views.camera.dispose()
    this.views.fullscreen.dispose()
    EXAMPLE_MENU.removeEventListener('selectedID-changed', this.onExampleSelected)
    this.editor.removeEventListener('isPlaying-changed', this.onPlaybackChanged)
    this.editor.removeEventListener('document-changed', this.onPlaybackChanged)
    for (const loading of this._documents.values()) void loading.then(document => document.dispose())
    super.dispose()
  }
}

export const ioCodevember = (arg0: ReactiveElementProps) => IoCodevember.vConstructor(arg0)
