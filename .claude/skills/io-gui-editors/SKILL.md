---
name: io-gui-editors
description: >-
  Configure and use IoInspector, IoPropertyEditor, and IoObject with editor definitions
  (registerEditor: widget rules, groups, header, label column) and class widgets
  (registerWidget). Use when working with @io-gui/editors, property widgets, or
  context property editing.
---

# @io-gui/editors

## Defaults

- Import from `@io-gui/editors`.
- Describe a class's editor with `registerEditor(Class, {widgets, groups, header, labelWidth, labeled})`. It applies wherever an instance is edited: as the inspected object, inside a collapsible, in its groups.
- **Widget rule shape:** `[Matcher, VDOMElement, RowOptions?]`: a matcher (property name, RegExp, value class, `null`, `undefined`), a prebuilt vDOM factory result (`ioNumber({step: 0.01})`), and optional row options `{label, labelWidth, title}` (`label: false` hides the label; `title` is the label's tooltip, the label by default).
- The widget for a whole value of a class (a vector, a color) is `registerWidget(Class, widget)`: used in rows holding one, and alone in an editor of one.
- Visibility convention: `_*` and `__*` Hidden.

## Gotchas

- Do not emit a `{ name, type, tag, props }` object shape — use rule tuples + vDOM factories.
- Never put `label`, `labelWidth` or `title` in a widget's props: they are row options, the rule's third slot.
- Rules cascade like CSS, not by registration order: a name beats a pattern beats the nearest value class beats `null` / `undefined`; then an editor's own `widgets` beat the nearest class's definition, then its bases'; then the later rule.
- Register definitions in the class's own module, right after the class, on the narrowest class that needs them. Never register on `Object` or another broad base: definitions apply along `instanceof`, so a broad one steps over every derived class. A separate config module is only for classes you can't edit (third-party).
- Show a nested object's property in a group by its path (`'effects.0.strength'`): it keeps its owner's widget and writes along the path. Never nest editors with hidden labels to surface one. A section inside a section is a sub-group, `'Main/Bloom'`.
- Group order: Main, then a class's new groups (before its bases'), then inherited groups in place, then Advanced. List an inherited group before a new one to put the new one right under it.
- Explicit names beat regexes in every group; among regexes, `Hidden`'s go first. A class can whitelist its inspector with `Main: [...names]` and `Advanced: [/^[\s\S]*$/]`; subclasses name their own properties to surface them.
- `IoPropertyEditor` listens for `io-mutation`. Editing plain objects in place requires `dispatchMutation()` on the owner/graph.
- Every write goes through `writeProperty(element, object, key, value)` (`@io-gui/core`), which dispatches a cancelable `io-property-write` first. A custom widget that changes components of the object it edits (`value.x = ...`) must write them with `writeProperty`, or apps that route edits through undo (io-three) never see them. To take writes, listen for `io-property-write` (at the window: editors promote `{object, path}` to their own value as it bubbles) and call `preventDefault()`.
- A custom element that shows objects of its value (a list) inside an editor row must call `promotePropertyWrite(event, this.value)` (`@io-gui/core`) in its own `io-property-write` listener, or the write stays one of the inner object. A panel in the overlay that edits for an element elsewhere calls `divertPropertyWrite(event, source)` there instead, as the color panel and `IoContextEditorSingleton` do.
- Widgets belong to editors: never bind a widget to an object (a vector, a color) outside an `IoPropertyEditor`. The editor's promotion is what tells an app whose property a write is; io-three addresses it to the nearest object with a uuid on its path.
- Functions render as buttons invoked with the object as `this`, never by default: only where a group names them or a regex of a group other than `Advanced` matches them (`groups: {Main: [/./]}` shows a record of actions).
- `IoObject` expand persistence keys off guid/uuid/id/name/label when present → localStorage.
- `IoContextEditorSingleton` owns the right-click popup — forward gestures; don't fork panel state.

## Read next

- Glossary: [CONTEXT.md](../../CONTEXT.md)
- API overview: [README.md](../../README.md)
