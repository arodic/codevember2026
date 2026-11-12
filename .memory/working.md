# Working Memory

Curated, persistent. Caveman.

#### Project / build (2026-11-12)

- **Standalone since 2026-11-12** (was io packages/three/src/demos/codevember + IoCodevember.ts + codevember.html). Vite 8, terser keep_classnames + keep_fnames (io-gui tags/registry = constructor.name), base './', alias bare 'three' -> 'three/webgpu' (else WebGL build bundled too), oxc decorator legacy.
- **io-gui linked, not vendored (2026-11-12):** package.json `link:../Projects/io/packages/*`. alpha.5 not on npm. Never pack/commit/push io packages; public share = minified dist/ only. After io edits: `pnpm bundle` there, links follow dist/. Do NOT preserveSymlinks (two symlink paths = two copies of @io-gui singletons). DO absolute-alias three/three/webgpu/tsl/addons to this repo's node_modules/three: io `packages/three/node_modules/three` -> Projects/three.js dev. Skills in .claude/skills are a markdown copy, not a package.
- **sideEffects trap (io bug, fixed in io 2026-11-12):** io bundles = single dist/index.js; package sideEffects patterns matched only tsc per-file paths -> (1) io's own bundle step dropped side-effect-only modules not matching (`render/builtins.ts` pipelines+overlays, `EditorDefaults.ts` vs pattern `.js`) (2) consumer rolldown treated dist/index.js side-effect-free -> dropped top-level registerEditor/register calls. Symptoms: no camera frame letterbox, no editor header (credit line), "No widget rule for <fn>" warnings. Fix: sideEffects += "./dist/index.js", "**/utils/EditorDefaults.*", "**/render/builtins.*". Check after any io change: built page console clean + credit line + letterbox.
- **three r187 vs io's r188dev:** Fold used `NodeMaterial.lightMapNode` (#35318, r188dev 2026-11-06); r187 ignores unknown prop -> no GI -> black shade. LightMappedMaterial overrides setupLightMap -> IrradianceNode(lightMapNode). Built r187 vs r188dev: mean |diff| 0.01 (t 70), 0 (t 120). Drop on r188.
- **Find three regressions/fixes fast:** `git -C ../Projects/three.js archive <ref> src examples/jsm | tar -x` into scratch, vite alias three/three/webgpu -> src/Three.WebGPU.js, three/tsl -> src/Three.TSL.js, three/addons -> examples/jsm (own config, not mergeConfig: alias plugin skipSelf -> 2 threes), headless screenshot + region luminance -> bisect r187..HEAD (7 steps).

#### App shell (IoCodevember)

- **position: fixed inside io-layout = trap:** collapsed io-drawer content has transform -> fixed child confined + clipped. Anything fullscreen lives outside ioLayout (own View + viewport). io IoSplit collapses when size < sum(child budgets), `auto` = 240px; both-auto 2-child split collapses LAST child.
- **Readiness:** no io "drawn" signal -> DrawnViewport subclass (renderView + onSubmittedWorkDone -> `document-drawn`). Loading cover must be overlay: display:none viewports never draw. Don't gate on audio (iOS no preload).
- **Don't share a View between viewports:** switchDocument per viewport corrupts per-document navigation/effects.

#### Codevember Fold (procedural TSL terrain, src/days/fold)

- **Height-field GI pattern:** radiance compute (albedo/pi*(direct+own irr)) + gather compute (cos rays over coarse height; miss -> CPU sky radiance map) + edge-aware filter (tangent-plane distance) + running average 1/n (caps by change kind). Store irradiance / scene light level, else long averages keep daylight into night (pre-exposure rescale x1e5 -> white-out). Shorten history by drift of ln(level).
- **Overhangs on height field:** sideways vertex shift up coarse slope by recess(height); crest fade near wall top avoids flaps; normal = central diff of shifted positions; marches don't see it -> per-texel lip angle for lip shadow/AO.
- **Debug lesson:** removing a lighting term that also brightens the frame hides artifacts in other terms (indirect); isolate by disabling candidates one at a time with lighting held (AO-off found sand contour stripes).
- **Grazing light:** anything projected along the key light (cloud shadows, marches) moves ∝ 1/sin² -> fade by smoothstep(0.06, 0.3, key.y) (CLOUD_SHADOW_FADE); fade to a value equal to the other branch so horizon switch is seamless.
- **Sub-pixel splats:** star kernel must be well sampled: tent at 1 px half-width = exact constant energy; Gaussian exp(-4r²) needs ≥1.5 px half-width. Undersampled -> 0..5× flashes.
- **NaN -> flash:** GPU min(NaN, cap) returns cap -> a NaN pixel becomes the brightest value, bloom spreads it. Clamp asin/acos inputs of rotated/normalized vectors (poles, zenith round past ±1). Find one-frame spots: isolated-bright-pixel detector vs neighbor frames, then toggle bloom / objects.
- **RGB lighting:** saturated Preetham sky x orange albedo -> olive shade; temper sky light chroma (keep luminance) for lighting only.
