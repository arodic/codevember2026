---
name: io-gui-core
description: >-
  Author ReactiveObject/ReactiveElement subclasses with Io-Gui core primitives —
  @Register, @Property, @Field, bindings, change vs mutation, VDOM, Theme, Storage.
  Use when building on @io-gui/core, defining custom elements or models, or wiring
  two-way bindings and persistence.
---

# @io-gui/core

## Defaults

- Import from `@io-gui/core`, never deep relative paths into the package.
- Every subclass: `@Register` (or `Register(Class)`) before instantiate.
- Reactive state → `@Property` / `static Properties`. Init-only non-reactive → `@Field` / `static Fields`.
- Elements: `static Style` selectors must start with `:host`.
- Handlers named `on*` / `_on*` / `*Changed` / `*Mutated` / `*Debounced` / `*Throttled` auto-bind — no `.bind(this)`.

## Gotchas

- **change ≠ mutation.** Change = property reassigned (`===`). Mutation = in-place edit of a held object/array/node. Plain objects need `dispatchMutation(obj)` after in-place edits.
- A widget writing into the object it edits (a vector's `x`, a color's `r`) writes with `writeProperty(this, object, key, value)`, not `object[key] = value`: the `io-property-write` it dispatches first lets apps take edits into undo. It does not dispatch the mutation; do that after. A container showing objects of its value (a list) promotes writes from inside it with `promotePropertyWrite(event, this.value)` in its `io-property-write` listener; a panel in the overlay sends them on from the element it edits for with `divertPropertyWrite(event, source)`.
- Nested plain-object mutations fire `[prop]Mutated()` locally and do **not** auto-bubble further — re-dispatching upward is usually wrong.
- `NodeArray` properties need `init: 'this'`. Only the owning node disposes the array.
- `Binding` from `bind(node, 'prop')` or `this.bind('prop')` — assign onto another property to sync. Forward sync is a graph write inside a binding wave, not a plain assignment.
- Elements have three relations: reactive graph (`_parents`/`_children`), DOM tree, VDOM children from `render()`. Cross-domain reactivity lives where graph ≠ DOM.
- **A vnode owns the props it sets.** A reused element's prop that a later vnode omits returns to its value before a vnode took it (its declared default, for an element the vnode constructed); a `Binding` a vnode set is detached, without writing through, when replaced or omitted. Don't repeat props to "clear" them; leave them out. Props the element bound itself stay its own.
- **A render applies only the props whose value changed** since the previous vnode: a value given on every render is an initial value (`ioObject({expanded: true})` stays closed once the user closes it). Give another value, or a binding, to set it again. Declare a native default (`tabIndex`, `role`) as a Field: an omitted prop returns to it.
- **Key list items:** `ioTab({key: tab, model: tab})`. A key (compared by `===`, so a model object works) keeps each item's element and its state with the item through inserts, removals and reorders; unkeyed children match by position. Keys are unique among siblings. Don't change a vnode's props object after rendering it (debug warns when a changed one renders again).
- `element.dispose()` disposes the elements inside it first (deepest first): an override of `dispose()` releases its own resources and calls `super.dispose()`, and never disposes its rendered children itself. Dispose models after the views showing them; a render disposes the elements it removes on the next frame, so tests dispose models a frame after the views.
- `ThemeSingleton` properties become `--io_*` CSS variables; theme colors use core **`Color`**, not colors-package ColorValue.
- `Storage({key, value, storage: 'local' | 'hash' | 'none'})` returns a **Binding** to a singleton `StorageNode` — assign it onto properties for hash/local persistence.
- Arrow-function methods are not auto-bound as listeners.
- **Construction runs reactions inside `super()`:** `init()` → properties, `@Field`s → args → `ready()` → `*Changed()`, `mutated()`, `io-mutation`, all before the subclass's class fields and constructor body. State that `ready()` or handlers touch must be a `@Field` or a `declare`d field created lazily; a plain field is missing then, and without `declare` it is re-initialized after `super()`. Pass `on*` methods (not arrow fields) as callbacks rendered from `ready()`.
- A node held in a property reports mutations to `[prop]Mutated()` only; the holder's `mutated()` does not run. Use a child node to keep a per-frame value out of the parent's change handling.
- `IoGl`: properties map to uniforms. For extra uniforms, declare them in `Frag` and `setShaderProgram()` + `setUniform()` before `super.onRender()`; draw text on `this.ctx` after it. Uniforms are float32: pass pixel positions, not large values.

## Read next

- Glossary: [CONTEXT.md](../../CONTEXT.md)
- API tables / examples: [README.md](../../README.md)
