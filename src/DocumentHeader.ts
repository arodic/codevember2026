import { Property, ReactiveElement, ReactiveElementProps, Register } from '@io-gui/core'
import { resolveDefinition } from '@io-gui/editors'
import { Editor } from '@io-gui/three'
import type { Document } from '@io-gui/three'

interface DocumentHeaderProps extends ReactiveElementProps {
  editor: Editor
}

/**
 * The header of the editor's document (`registerEditor`'s `header`, as the Document tab shows it), for the fullscreen
 * view, which shows no editor.
 */
@Register
export class DocumentHeader extends ReactiveElement {

  @Property({type: Editor})
  declare editor: Editor

  /** The document whose header is shown; follows `editor.document`. */
  declare private _document: Document | undefined

  constructor(props: DocumentHeaderProps) {
    super(props)
    this.editor = props.editor
  }

  override ready() {
    this.editorMutated()
  }

  editorMutated() {
    const document = this.editor.document
    if (document === this._document) return
    this._document = document
    const header = resolveDefinition(document).header
    this.render(header ? [header] : [])
  }
}

export const documentHeader = (arg0: DocumentHeaderProps) => DocumentHeader.vConstructor(arg0)
