# CLAUDE.md

Codevember 2026: procedural WebGPU / TSL sketches as io-gui `Document`s on three.js r187. Commands and layout are in README.md, the design and per-day plans in Codevember.plan.md.

## Rules, skills and memory

@.cursor/rules/ai-persona.mdc
@.cursor/rules/memory.mdc

- **Memory:** project memory lives in `.memory/` (rules above): `now.md` is the current focus, `working.md` holds curated knowledge in caveman style, `archive.md` is the complete log. Read `now.md` first.
- **`.cursor/rules/caveman.mdc`:** the compressed style for `.memory/working.md`.
- **`.claude/skills/io-gui-*`:** io-gui's consumer skills for the packages `src/` imports. Read the relevant one before writing io-gui code.
- **`.claude/skills/grilling`:** the interview workflow for stress-testing a plan, such as a day's design in Codevember.plan.md.

## Rules

- **io-gui is linked locally** (`link:../Projects/io/packages/*` in package.json). alpha.5 is not on npm. Do not pack, commit, or push those packages; the only form that may be published is this app's minified `dist/`. Library changes belong in io: edit there and run `pnpm bundle` there. Never edit `node_modules`.
- **three is r187 from npm.** io's dev setup links `../three.js` dev (r188dev), so code that works in io can still fail here. r188-only API silently does nothing: Fold's `lightMapNode` needed `LightMappedMaterial`. Check `node_modules/three/src` before relying on new API.
- **Minification keeps class and function names.** io-gui names elements and registrations after classes (`constructor.name`), so don't remove `keep_classnames` / `keep_fnames` from `vite.config.ts`.
- **Code style is io's.** No semicolons, single quotes, 2 spaces, `@Register` / `@Property` (TypeScript experimental decorators), `registerEditor` for inspector groups (scene content and internal state go in Hidden).
- **Checks:** `pnpm typecheck`, `pnpm lint:check`, `pnpm test`, and `pnpm build` before calling something done.
- **Verify visuals in headless Chromium with WebGPU.** Use the flags `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --use-angle=metal --autoplay-policy=no-user-gesture-required`, against `pnpm preview` (built) or `pnpm dev`. Reach the document with `document.querySelector('io-codevember').editor.document`. Set the mode, time and seed explicitly, because state persists. Setting the time re-applies the camera, so aim after each change. The user often runs on battery in Low Power Mode: keep headless runs few, and don't trust fps numbers.
- **Commits:** commit only when asked. The user commits.
- **No backward compatibility:** convert callers and delete old forms.

## TSL lessons (from Fold)

- Plain JS helper functions inline their whole expression tree at every call site. Make heavy, repeated code a memoized layout `Fn`; the clouds ran at 1 fps before that.
- Uniforms captured inside a layout `Fn` that several shaders share fail to bind (WGSL "struct member nodeUniform0 not found"). Pass them as arguments instead.
- `toVar` / `assign` only work inside `Fn`.
- `Fn(cb, {param types})` emits one WGSL function. Prefer it for anything called more than once.
