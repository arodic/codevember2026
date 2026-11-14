# Archive

Complete log. Entries before 2026-11-12 11:00 were written in the io repo (packages/three/src/demos/codevember), before the move.

## 2026-11-11 [codevember][three][tsl] Fold day 1 built
- Executed Codevember.plan.md day 1. Arch: compute field rgba32f (H,U,sand,channel) + shading rgba16f (n.xz, cavity, skyVis) per terrain version per renderer in onBeforeDraw; surface 1 vertex/texel textureLoad; proxy grid shares material for probe bake.
- TSL gotchas: toVar()/assign outside Fn -> 'No stack defined for assign' -> use pure exprs in material setup; uniforms read-only in shader (toVar copy); textureSample inside Loop -> .level(float(0)); @types: receivedShadowNode typed () => Node but called with shadow -> cast helper shadowFilter; ivec2 needs int nodes (int(clamp(float...))); modelViewProjection typed Node -> vec4(x as Node<'vec4'>).toVar(); mulAssign chain return type breaks -> split.
- three Color.setHSL default = working (linear) space -> palette hex too light; pass SRGBColorSpace to setHSL + getHexString.
- Bug caught by test: moon phase law inverted (full treated as new). Fixed + celestial.test.ts.
- Exposure: pre-exposure (NOON_LUX/E)^0.8 on all lights+sky keeps fp16 at night; adaptation ^0.86; NightVision effect (Purkinje) needed else moonlit night = day look.
- Host Document tab labelWidth prop (4.5rem) beats registerEditor labelWidth -> short row labels via 3rd slot.
- Perf headless 1 view: 60 fps diurnal, 57 combined. Rolling probe bake (restart only after full pass) so moving sun still converges.
- Unresolved: intermittent WebGPU invalid command buffer (1/18 loads).


## 2026-11-11 [codevember][three][tsl][aa] Fold iteration 2 (review feedback)
- Sawtooth root causes (not resolution): recess used competence via floor() -> height step at contacts; perturbNormal + fwidth per triangle on steep heightfield walls -> dot lattice along laminae (screen derivatives differ per zigzag triangle); laminae following triangle zigzag -> use cubic B-spline height (4 bilinear taps) for color; march start from triangle pos -> start from smooth surface + normal*0.15; cavity/skyvis radii in texels -> world units.
- Tried and dropped: bilinear height for color (streaks on 1-texel cliffs); fix is wider cliffs (smoothing sigma 2.5 texels, radius 5) + B-spline.
- LightProbeGrid: getProbePosition overridable -> CanyonProbes subclass; lookups ported from LightProbeGridNode (atlas 7 subvolumes along z, padding 1) via getShIrradianceAt; inject via material.lightMapNode (IrradianceNode -> context.irradiance, same as grid). @types lacks lightMapNode, getShIrradianceAt returns Node -> casts. Grids visible=false; bake pass 0 only, feedback gives bounces.
- Perf: bake is CPU-bound (cube faces via ArrayCamera, ~1.3ms/probe); shading compute memory-bound at 2048 (108 scattered taps) -> occlusion at 512^2. Draft landscape 1x while animating, refine after 8 draws.
- Canyon sand: fill level mixed into the channel buried walls; gate fill by channel smoothstep(0, 0.2). Ripples only on flat (vertical stripes on walls otherwise).
- Slot canyon (floor 9, walls 6.5) read black; floor 14, walls 15, depth 0.75, +1 stop exposure in canyon.


## 2026-11-11 [codevember][three][lighting][exposure] Fold iteration 3 (review 2)
- Nightfall white-out root causes: (1) exposure from analytic twilight table, rendered Preetham sunset glow + twilight term ~7x brighter at sun 0..-4 deg -> integrate the dome model on CPU (skyIrradiance); 96 samples too coarse for Mie glow at sunrise -> 1024; (2) probes scaled only by pre-exposure ratio, not by sky dimming during multi-second bake lag -> record indirectLevel (E*pre) per column/chunk at bake, scale by now/bake.
- Canyon +1 stop boost overexposed twilight (no direct sun) -> scale by direct/ground. bounce multiplied captured sky too -> exposure counts sky*bounce.
- Probe bake cost CPU-bound per probe; priority by camera window (camera only sees nearby canyon) beat frustum culling. LightProbeGrid index order x,z,y -> put columns on y so a column is contiguous (one bake call); atlas wrapT Repeat gives wraparound lookup.
- Polar distance |rho - r|/sqrt(1+(r'/rho)^2) collapses near center with deep lobes (false carve) -> GPU distance field from polyline when shape changes (cheap, exact, gives signed offset + angle).
- uniformArray: node.array mutated in place, uploaded per render (updateType RENDER). element() typed loosely -> cast.
- Perf after: 60fps diurnal/combined/tectonic (1 view, 2048 field).


## 2026-11-11 [codevember][three][gi] Fold iteration 4 (review 3)
- Probes popped on rebake + stale far away -> replaced by height-field GI: radiance compute (albedo/pi * (key through coarse march + clouds + own irradiance)) + gather compute (cos rays over coarse height; hit -> radiance texel, miss -> CPU SkyRadianceMap equirect 48x24); temporal blend; ping-pong via copyTextureToTexture. No bakes/cubes.
- Detail: solid 3D noise in world space instead of triplanar (procedural: nothing to project/stretch, no seams). MeshPhysicalNodeMaterial specularIntensityNode + roughnessNode from detail.
- Moon Mie 0.3 g 0.92; 150k stars; 120 meteor slots longer.
- Perf measurements noisy: user's Chrome GPU process shared GPU (~40% CPU); A/B within one run is the only fair comparison.

## 2026-11-12 [codevember][three][gi][terrain] Fold iteration 5 (review 4)
- GI noise = blend floor 0.2 (EMA ~9 samples x 6 rays) -> running average 1/n with caps (24 changing, 6 after terrain recompute, 240 still then idle) + 5x5 Gaussian weighted by distance off tangent plane + golden-angle spiral rays w/ per-texel-per-update rotation (uint seed). Playing: 0.5% median change per 100ms midday.
- REGRESSION found + fixed: long running average across dusk/jump keeps daylight share; pre-exposure rescale makes it 1e5x too bright at night (white-out). Fix: store irradiance / light level L=(skyE+direct)*pre; radiance & material multiply by L; drift cap floor(0.4/|dlnL|) shortens history when L moves fast.
- Teal/olive shade: Preetham linear sky (3.5,7.5,14) x orange sand -> olive in RGB. Lighting map keeps 55% chroma (luminance same); dome unchanged.
- Radial stripes on canyon floor = lamina crevice AO evaluated on sand (sand surface cuts virtual strata -> contour lines along walls). Debug path: no-march test was misleading (lit floor hides indirect artifacts); AO-off test isolated it. Lesson: when removing a term also changes overall light, artifacts in other terms get masked.
- Sand fray added fray*0.09 to sand depth everywhere -> sand blobs on bare walls. Gate by smoothstep(0,0.04,sandDepth).
- White vertical flecks on walls = glossy varnish (rough 0.55, spec 1.6) sheen at grazing -> curtains sparse/dark, rough 0.7 spec 1.1. Talus limited to slopes <~0.45 steep.
- Coarse height (occlusion.z) was point sample of 2048 field -> 5x5 tent box avg; occlusion texture rgba32f.
- Overhangs: displacement pass (2048^2): shift up-slope (gradient of coarse height over +-2 units) by recess(weak bed 0.6, alcove fbm (0.06,0.4,0.06), notch at floor+3.4) * steep ramp sat((s-0.4)/1.4) * crest fade smoothstep(0.5,2.5,max coarse uphill 1/2/3.5 - h) * not sand * border * overhang. First tries invisible: walls avg only 50-60 deg; need dr/dh > 1/slope. Flap risk at rims solved by crest fade (rim protrudes = caprock lip). Normal from central diff of shifted positions (shading.xyz, cavity .w). Lip angle per texel (rises 0.5..3.8) -> material lip shadow + shelter AO (march can't see overhangs).
- Moon: disc pre-exposed radiance capped 300 (bloom spread it into 6 deg ball), Mie 0.15 g 0.96.
- tsc -b emits tracked dist/ (19 files + untracked codevember dist) -> restored with git checkout + rm; use tsc -p --noEmit.
- Perf: 60 diurnal (gi on/off same), 43 combined, 47 tectonic (1600x1000, no competing Chrome).

## 2026-11-12 [codevember][three][tsl][clouds] Fold iteration 6 (review 5)
- Clouds: old deck = 4-octave noise thresholded, even lighting -> smudges. New 2.5D cumulus: warped lumps carved by coverage + billow erosion, per-octave LOD by pixel footprint (horizon glitter), slab slant optical depth, exit-sample union (horizon bank), light march toward key (near billow sample + 4 coarse), Beer + multiple, dual HG. Preetham lightE drops sun to 13% at 10 deg -> clouds not golden; drive from CPU transmittance (deck dip 0.03 rad, boundary-layer haze per air mass) via sky.sunIrradiance/moonIrradiance. Ambient = SkyRadianceMap irradiance/pi (sky.ambient), less on bases.
- PERF BUG: cloud fbm as plain JS fn inlined every octave/use into each shader (terrain per pixel, 600k star verts) -> ~1 fps. Fix: TSL Fn with layout per config (memo map) + toVar per octave.
- BUG: TSL Fn with layout that captures uniforms (sky.cloudCoverage, sky.time) shared across materials + compute -> WGSL 'struct member nodeUniform0 not found'. Fix: pass uniforms as Fn args.
- Stars/meteors cloud occlusion must use the dome's exact path (incl. exit union), else stars show inside cloud silhouettes.
- Meteors: per-slot cycles (8/loop) re-randomized by hash(slot*cycles+cycle); rate * (0.25+0.75*sat(1.5*sin radiant alt)); mag 3.5-6.5u^2.
- Overhang: alcove noise freq halved (0.03,0.2,0.03), slider max 4, LIP_RISES to 7.5, fin guard (coarse height behind < h -> shift <= half distance).
- Perf measurements: user on battery Low Power Mode + Chrome GPU 84% -> 8..60 fps swings; free GPU: 60 diurnal, 44 tectonic, ~35 combined.

## 2026-11-12 [codevember][three][clouds][effects] Fold iteration 7 (review 6)
- Two cloud planes = exit-sample union (offset copy by slab cot) -> removed; coverage += (1-c)*min(c,0.3)*smoothstep(0.45,0.05,sine) for horizon bank.
- CLOUD_SPEED 0.00005 -> 0.0002 (drift + billow evolve). Weather: CPU applyWeather in onAnimate/timeOfDayChanged/applySkySettings: swell = looping sines (2x, 5x per loop) * (0.55+0.45*afternoon); coverage = c*(0.2+1.6w), density = d*(0.7+0.6w); exposure cloudShade uses effective values.
- TimelineFade post effect: reads ctx.document.timeline in update (called per draw). Gotcha: changing only an effect prop while paused may not redraw before a screenshot (stale frame) -> A/B tests must change time too.
- Headless page may load in user's last mode (Combined): always set animationMode + tectonicAge in scripts.

## 2026-11-12 [codevember][three][clouds][meteors] Fold iteration 8 (review 7)
- Cloud speed slider: position = time*speed jumps when the speed changes -> clouds' own clock uniform (sky.cloudTime) += delta*speed in onAnimate (wrap at loop handled), used by cloudPlaneUV/cloudShadowUV/drift.
- Meteors over clouds: occlusion was per vertex at the head -> streak drawn over clouds when the head was clear. Now per fragment: direction = normalize(mix(vTail, vHead, s)) -> cloudOpacityToward (dome's path) + horizon.
- Meteor fade: was a whole-streak flare. Now train exp(-(head-d)/(0.45 trail)) and burn-out front mix(tail, head+soft, smoothstep(0.55,1,age)) per fragment.
- Test script gotcha: setting timeline time re-applies the document camera (Overview pose) -> aim the camera after each time change.

## 2026-11-12 [codevember][three][audio] Fold iteration 9 (review 8)
- Soundtrack: Document has no play/pause signal (Editor.isPlaying only). Added demo-host protocol PlaybackListener in IoCodevember (listens editor 'isPlaying-changed' + 'document-changed', calls doc.playbackChanged(bool)); library untouched.
- Fold: new Audio(new URL('./fold/CanyonHum.mp3', import.meta.url)) (Vite asset), timeline.duration from loadedmetadata (163.896 s), DURATION const 163.92 to avoid a jump. Sync in onAnimate: paused -> seek; playing -> rate 1 -/+ 3% * drift/0.25, |drift|>0.25 or paused (ended) -> playSoundtrack (seek+play). NotAllowedError -> resume on first pointerdown/keydown (capture).
- three Timer.getDelta has no clamp -> timeline keeps real time at low fps.
- User edits seen meanwhile: camera aspect 2.39, cloudSpeed label 'cloudSpeed' (kept).
- Review 9: user heard impulse crackle while playing -> per-frame playbackRate easing (resampler discontinuities). Removed: sync only at play start, |drift| > 1 s (scrub/wrap), audio.ended near the end waits for the wrap. Lesson: never modulate HTMLMediaElement.playbackRate continuously for sync.

## 2026-11-12 [codevember][three][host][terrain] Fold iteration 10 (reviews 9-10)
- Host fullscreen (user's CSS: Active viewport fixed over the page): covered viewports kept rendering (ThreeViewport visibility = IntersectionObserver, geometry not occlusion). Trick: :host[fullscreen] three-viewport:not(#Active) {display:none} -> IO reports not intersecting -> isRenderable false; back on exit IO tags redraw. Verified flags.
- Fullscreen timeline under the camera frame: top = min(50vh + min(100vw/aspect, 100vh)/2, 100vh - 100px), --frame-aspect from views.camera.getFrameAspect on fullscreenChanged; three-timeline is flex align-items center -> flex-start in fullscreen.
- Overhang strips: metric = adjacent vertices with |shift diff| > 0.4 and |dh| < 0.25 ("flaps"); "folds" (edge reversal) on walls are legit lips, bad metric. Causes: sand mask over ~1 texel, thinly-sanded foot texels shifted (coarse foot level misses banked sand), fin guard discrete. Fixes as in now.md. Lesson: measure geometry artifacts by reading back the fields, map them top-down (foldmap.mjs), then wireframe close-up (material.wireframe works in WebGPU).
- User additions seen: fullscreen default true + credit line, camera 2.39.


## 2026-11-12 [ship][build][io][three] Moved to ~/codevember, minified bundle
- User: move codevember into own project ~/codevember, deps io + three, vite-like tooling, minified bundle to deploy, all assets local.
- Layout: src/IoCodevember.ts, src/ThreeEditorStatus.ts (copied: io doesn't export it), src/days/* (was codevember/*), src/main.ts, index.html (codevember meta, no import map), public/images (io favicon/logos). Plan + tests moved; vitest browser (playwright 1.64.0 pinned = io's, cached browsers).
- Deps: io alpha.5 unpublished -> vendored pnpm-pack tarballs (scripts/vendor-io.mjs); three 0.187.0 npm.
- Bug 1 (io packaging): built page lacked letterbox + credit header, 276 "No widget rule" warnings. Cause: sideEffects patterns vs single-file bundle (see working). Fixed io package.json x11, rebuilt io bundles (`node bundle.js`: only editors + three dist/index.js changed), re-vendored.
- Bug 2 (three version): terrain shade black on r187. Unminified build same (not terser); r188dev build matched io. Bisect via git archive src trees: first good = 8ccab6c7c8 (#35318 adds NodeMaterial.lightMapNode). Fix: LightMappedMaterial (setupLightMap override). Verified pixel diff vs r188dev ~0.
- io cleanup: removed codevember sources/html/plan (backup scratchpad io-codevember-backup.tgz) + 84 compiled codevember files in io packages/three/dist/demos (tracked, from user's "New bundle" commit).
- Found, not fixed: io vite.bundle.config.ts strip plugin default include `**/*.js` -> `debug:` labels in .ts never stripped (debug warnings ship in io bundles).

## 2026-11-12 [memory][skills][tooling] Memories transplanted, skills + rules copied
- User: "Are there any skills that should be copied?" + "transplant any codevember memories from io to codevember. Io does not need them".
- Memory: io .memory archive codevember entries (81 lines, Fold day 1 .. iteration 10) verified present here, then deleted from io; io working.md Codevember Fold section -> here (already), io keeps only Packaging notes (sideEffects, linked-three API trap); io now.md keeps only io-side changes (sideEffects fix, removed files). Claude auto-memory dir had nothing.
- Skills: .claude/skills/io-gui-{core,three,editors,layout,inputs,menus,sliders,colors} (io consumer skills, = vendored copies; icons/navigation transitive only, markdown not a dep) + grilling (io .cursor/rules/grilling.md, generic). Not copied: io-gui.mdc (developing io itself), io-icons.mdc, domain-modeling + grill-with-docs (CONTEXT.md/ADR formats for io packages).
- Rules: .cursor/rules/{ai-persona,memory,caveman}.mdc; ai-persona test line -> `pnpm test`. CLAUDE.md imports ai-persona + memory like io's.
- vendor-io.mjs: copies skills; pnpm pack non-deterministic (workspace:* dep order) -> keep tarball when files equal -> 2 re-runs byte-identical.

## 2026-11-12 [fullscreen][mobile][loading][layout] Landscape fullscreen, loading cover, frame-fit timeline
- User: on mobile, rotating to landscape while playing showed editor UI, not fullscreen Active view. Cause (verified headless 844x390): io IoSplit.calculateCollapsedDrawers budgets 240px per `auto` child -> Top/Active vertical split needs 480px height -> collapses last child (Active panel) into trailing io-drawer; collapsed drawer content has `transform: translateY` -> containing block for `position: fixed` -> old `:host[fullscreen] three-viewport#Active {position: fixed}` sized to drawer, translated off-screen, clipped. Portrait: only Scene/Document side panels collapse -> worked.
- Fix: own `fullscreen` View (camera, overscan 1, cameraFrame) + `#Fullscreen` viewport + DocumentHeader (src/DocumentHeader.ts, resolveDefinition(document).header) in `.fullscreen` div outside ioLayout; fullscreen hides heading/layout/status (display none). Not sharing the camera View: each viewport calls view.switchDocument on doc change -> 2nd call parks new doc's state under old uuid. Fold header id 'document-header' dropped (rendered twice now).
- User: UI/timeline shown before demo ready -> play does nothing. Measured: timeline at ~150ms with empty default Document; Fold set ~940ms (lazy chunk + ctor, 743ms long frame); first draw compiles. Fix: src/DrawnViewport.ts (ThreeViewport subclass, renderView -> first draw per document -> await device.queue.onSubmittedWorkDone -> bubbling `document-drawn`); IoCodevember `loading` (reflect) cover z 2000 until `_openedDocument` drawn; `_drawnDocuments` WeakSet -> switching back no cover. Cover is opaque overlay, not display:none: hidden viewports don't draw -> would never lift. Not gated on soundtrack: iOS ignores preload -> would hang. Cover lifts ~220ms after Fold set (desktop headless).
- User: window wider than 2.39 -> timeline over frame (old top = min(frame bottom, 100vh - 100px)). Fix: CSS vars on :host: --below-frame (4 lineHeight + 2 spacing2 = 72px), --frame-fit = 100vw/aspect, --viewport-height = min(100dvh, max(100dvh - below, 2(100dvh - below) - fit)), --frame-bottom = vh/2 + min(fit, vh)/2; viewport cut short so frame ends at room for timeline+header. Verified 390x844, 844x390, 1300x400, 1000x500: frameBottom == timelineTop, header on screen.
- Escape exit only works when focus inside host (listener on host); headless Escape on body did nothing (pre-existing).

## 2026-11-12 [fold][sand] Twinkle is glint, not triplanar
- User asked which material property makes sand twinkle; guessed triplanar projected on the surface. Answer: not triplanar (plan rejected it; detail is solid 3D noise). `glint` = sparse noise at `point * 41`, written into `specularIntensityNode` (`1 + glint * 3`) and `roughnessNode` (0.96 → 0.5) on the surface `LightMappedMaterial` in FoldTerrain.ts.

## 2026-11-12 [fold][clouds][stars][artifacts] Grazing cloud-shadow fade, star tent kernel
- User: every sunrise/sunset a fast, hard-to-read sweep of cloud shadows over terrain and in the clouds; stars twinkle/flash (in and out of pixels), asked if min-size-1px + dim-by-true-size trick makes sense.
- Clouds: terrain shadow offset = H·cot(elevation) (CLOUD_HEIGHT 70) -> sweep speed ∝ 1/sin²; Combined sun ~5°/s near horizon; sun y 0.3 -> 0.06 in ~3 s (t 57.5..60). Fix: FoldSky `cloudShadow(sky, position, key)` (shadow strength 0.85 × smoothstep(CLOUD_SHADOW_FADE 0.06, 0.3, key.y)), used by terrain material + GI radiance compute; cloudOpacity now module-private. Deck self-shading: march `toward` mixed to density/3 by the same fade -> ×0.6 = density×0.2 = below-deck branch -> horizon crossing seamless. Also fixed sun->moon key switch pop at sun.y -0.1: handover smoothstep(-0.1, -0.2, sun.y) on the march weight + slant sine eased sun.abs -> moon.
- Stars: trick already there (milkyway ParticleRender: min footprint + area-ratio dimming) but defaults broke it: minStarSize 0.5 px half-width + exp(-4r²) kernel (σ ≈ 0.18 px). Offline sum-at-pixel-centers over subpixel offsets: energy 0.00..5.14× (vanish/flash). Gauss at 1.5 px: 0.94..1.02. Tent (1-|x|)(1-|y|) at 1 px half-width: exactly 1.000 (bilinear splat = partition of unity); brightest pixel 0.25..1. Fix: tent kernel, KERNEL_AREA 1, stars footprint minSize.max(1). Meteors share minSize uniform, untouched (still 0.5, same across-width aliasing) -> offered.
- Verified: checks clean, headless evening frames (sun y 0.38/0.16/0.07/0.03) + night render fine. Motion not judged headless.

## 2026-11-12 [keys][fullscreen][playback] Escape + Space page-wide
- User: Escape should exit fullscreen without focus; Space should toggle playback even if timeline not focused.
- Was: host `keydown` listener (needs focus inside host); io ThreeTimeline Space only on `three-timeline-range` ('@keydown' on the range, not the timeline).
- Fix: IoCodevember.onKeyDown on window (connected/disconnected; on* auto-binds). Ignored while loading or defaultPrevented. Escape -> fullscreen false (only when fullscreen). Space (no repeat) -> toggle editor.isPlaying + preventDefault, unless composedPath has IoField (buttons, numbers, strings), three-timeline-range (toggles itself; first try excluded whole three-timeline -> Space on timeline container did nothing), contentEditable, input, textarea. No io keymap binds Space.
- Verified headless: no focus Space x2 toggles, Escape exits; focused button: no toggle; scrub bar: one toggle; timeline container: one toggle.

## 2026-11-12 [fold][sky][nan][bloom] One-frame bright spot = NaN at the south galactic pole
- User: at t 79.9 one super bright spot for one frame, no star there; meteor? Window 1327x694 (ran headless at DPR 2).
- Not reproducible at 1280x640 DPR1 (framing). Meteors ruled out: CPU replica of TSL hash (PCG, Math.imul) -> all firing meteors live 0.5-1.1 s, none on screen; rate 0 keeps spot. Stars ruled out (brightness 0 keeps spot; brightest star HDR ~1.7e3 << 65504). Bloom off -> spot gone; sky dome hidden -> gone; terrain hidden -> stays.
- Detector that worked: pixel >= 450 in frame k with nothing within 4 px > (v - 250) in frames k-1/k+1 (moving stars excluded); 1127 px at 79.900.
- Cause: spot direction = south galactic pole (0.08°). milkyWayGlow `galactic.z.asin()`: galacticFrame*direction rounds |z| past 1 -> NaN; dome output `min(color*pre, 30000)`: GPU min(NaN, x) = x -> 30000 pixel -> bloom blob, one frame. Same class: acos(max(0, direction.y)) at zenith, asin(max(-sun.y,0)).
- Fix: clamp before asin/acos (galactic.z ±1, direction.y [0,1], -sun.y [0,1]). Rescan: spike gone. Metal pow follows C semantics (negative base + integral exponent fine).
- Lesson: NaN + min()/max() cap = huge finite value, not black.

## 2026-11-12 [fullscreen][perf][mobile][gi] Exact-frame fullscreen canvas, GI off on touch devices
- User: fullscreen canvas = exact camera proportions, rest black (no full-window canvas with dimmed overscan). Done: CSS --frame-height = min(100vw/aspect, 100dvh - below-frame), --frame-top = min((100dvh-h)/2, 100dvh - below - h), viewport left/width from height×aspect; fullscreen View drops cameraFrame overlay. Same placement as before. 1327x694 DPR2: canvas 2654x1110 (was 2654x1378, -20% px); aspect 2.390 at 1327x694, 390x844, 1300x400, 844x390.
- User: GI off on mobile by default. Fold `MOBILE = matchMedia('(hover: none) and (pointer: coarse)')` (typeof guard for vitest), gi default !MOBILE. Verified headless: desktop gi true, emulated phone gi false.
- GI-off look: brighter, pinker, washed sky (preExposure 85 -> 258, envIntensity 0.2 -> 1). User: "that was noticeable before" -> known, pre-existing, not asked to fix.

## 2026-11-12 [mobile][color][webgpu] Mobile color investigation (stopped: user says local build looks good on iPhone)
- User: colors noticeably off on mobile, suspected color management; then "checking local build on actual iphone rn and looks good" -> stopped. No code changed.
- Ruled out (desktop headless): canvas alpha (io renderer alpha:true -> alphaMode premultiplied; magenta backdrop: frame opaque); three canvas configure = preferred format, toneMapping 'standard', srgb.
- Found (not fixed): devices without `float32-filterable` -> three samples FloatType textures unfiltered (textureLoad) but binding layout for some still expects Float -> GPUValidationError "None of the supported sample types (UnfilterableFloat) of [Texture X]" for Fold Field, Fold Smoothing, Fold Occlusion, Canyon Field (FloatType StorageTextures sampled with texture()); invalid mipmapEncoder + render bundles. Emulate: addInitScript override GPUAdapter.prototype.features getter filtering it out. Visual diff vs full features ~0.3 levels, <=0.3% px -> not the color issue. Likely hits Android (Mali/Adreno); iPhone apparently fine. Fix options: HalfFloat where precision allows, or NearestFilter on those FloatType textures, or three fix upstream.
- Root cause found (follow-up): the float32-filterable errors are three's mipmap generation, not material bindings. StorageTexture inherits generateMipmaps=true (minFilter LinearFilter); Textures.needsMipmaps() checks only generateMipmaps -> full mip chain alloc + regen on every update (wasted GPU work on desktop too). WebGPUTexturePassUtils.generateMipmaps samples texture_2d_array<f32> with linear sampler (textureSample, auto layout, render bundle, 'mipmapEncoder') -> invalid for rgba32float without float32-filterable. Traced via createBindGroup/createView hooks: bad views dim '2d-array' with auto layout.
- Fold's fragment samples field/shading/occlusion/frame/displacement/irradiance without .level() -> on desktop they DO use mips (distance AA); on no-float32-filterable devices FloatType ones are textureLoad level 0 anyway. Intermediates (Canyon Field, Fold Smoothing, GI radiance/estimate/irradianceNext) never need mips.
- User asked: upstream bug? -> yes, two issues (needsMipmaps ignores minFilter for storage textures; mip generator ignores float32-filterable). Offered: draft issue (not posted) + local workaround (generateMipmaps=false on intermediates; on FloatType when renderer lacks the feature).
- 2026-11-12: wrote the issue into /Users/aki/Projects/io/.cursor/plans/three_upstream_fixes.plan.md (todo `storage-texture-mipmaps`, pending, not filed; section before Triage). Verified on three.js dev 8a22289958: same code. Extra finding: Bindings.js:555 regenerates 2D StorageTexture mips after every compute write (#34630 mipmapsAutoUpdate; 3D/array opt out). WebGL textureNeedsGenerateMipmaps = generateMipmaps only (corrected my first claim), but GL_LINEAR never reads mips; WebGPU LinearFilter -> mipmapFilter nearest, no lodMaxClamp -> implicit-LOD samples DO read mips (backend difference). User: GI off on mobile is fine for now; fix later.

## 2026-11-12 [git] Remote added and main pushed
- No remotes before. Added origin https://github.com/arodic/codevember2026.git, pushed main (2208ade) with upstream tracking. Repo is PUBLIC.

## 2026-11-12 [deps][git] Drop vendored io-gui tarballs, link local checkout
- User: tarballs are unreleased io-gui, don't share except minified; link locally; amend + force push.
- package.json `link:../Projects/io/packages/*`. Deleted vendor/*.tgz + scripts/vendor-io.mjs. Vite aliases three, three/webgpu, three/tsl, three/addons to this repo's node_modules/three (absolute). preserveSymlinks would duplicate @io-gui via two symlink paths; the nested node_modules/three inside the link still points at Projects/three.js.
- Amended local main only. Did not force-push main. Public history still has the tarballs until the user force-pushes. Left uncommitted sketch edits (Capture.ts, DrawnViewport, IoCodevember, main.ts) out of the amend.

## 2026-11-12 [capture] Frame capture to EXR / PNG sequence (console)
- User: integrate ccapture.js, console-triggered, play + capture every frame to end, ideally HDR sequence, let each frame resolve GI a couple of seconds; then: fullscreen, canvas only, 4096x1716 or configurable.
- Did NOT use CCapture: no HDR (canvas 8-bit only), keeps all frames in memory (tar), its rAF/Date hijack is redundant with the editor timeline (set currentTime directly). Native instead.
- src/Capture.ts `FrameCapture`: per frame timeline.currentTime = i/fps, viewport.tag('content'), wait rAFs until >=1 draw AND settle s; read `viewport.compositor.pipeline.output.color` (half-float linear, effects, no overlays) via QuadMesh pass into own RT: exr = rgb*exposure (view ?? doc toneMappingExposure), sampled y-flipped (EXRExporter writes rows h-y-1, WebGL convention); png = workingToColorSpace(toneMapping(view ?? doc mapping, exposure, vec4(rgb,1)), sRGB) into RGBA8. readRenderTargetPixelsAsync -> 3 workers (src/CaptureWorker.ts: EXRExporter.parse(DataTexture HalfFloat, ZIP) / OffscreenCanvas png, write via FileSystemDirectoryHandle passed in message). EXR encode 3.1 s/frame on main thread before workers; now overlaps -> 2.0 s/frame at settle 1.5 (4096x1716, exr+png). Write error -> stops, throws.
- DrawnViewport: `resolution` setter (fixed device px: width/height = res, renderTarget pixelRatio 1, onResized override keeps it; null restores) + `draws` counter.
- IoCodevember.capture(options)/stopCapture(): picker before any await (DevTools console counts as gesture), pause, fullscreen, `capturing` attr (hides timeline + header, canvas 100% !important object-fit contain), restores time/playing/fullscreen. Escape while capturing = stop. main.ts: window.capture / window.stopCapture. README "Capturing frames".
- Defaults 4096x1716, fps = timeline.frameRate (30), settle 2, exr. Frame index = round from time 0 -> `from` resumes.
- Verified headless (dev server, OPFS dir): files 4096x1716, upright (sips EXR->png), PNG matches screen. tsc/eslint/vitest 17/17/build clean.
- BLOCKER found (not mine): after the other session's switch to `link:../Projects/io/packages/*`, the BUILT bundle has 72 copies of ReactiveElement -> page dies "Cannot redefine property: ReactiveElement" (pnpm preview). Dev server fine. Not fixed.
- User: pink clouds in capture = normal (they picked the pinkiest moment). Not a bug.
- Motion blur + AA added: capture({motionBlurFrames N (1), shutter (0.5 = 180°, centered on frame time), jitter (true)}). Subframe k time = (frame + ((k+.5)/N - .5)·shutter)/fps; jitter = Halton(2,3)(k+1) - .5 px via activeCamera.setViewOffset(W, W/aspect, dx, dy, W, W/aspect) (keeps aspect; io View copyProjection copies .view). Restored in finally (clearViewOffset + aspect). Accumulate output·exposure·(1/N) into HalfFloat RT (first NoBlending, rest CustomBlending One/One, alpha sums 1); exr/png passes read the sum with exposure 1. BUG hit: renderer.autoClear cleared the sum before each additive quad -> only last subframe/8 (dark). render() now autoClear=false.
- CaptureListener.captureChanged('settle'|'subframes'|'off') (Capture.ts). Fold: captureStage; capturing -> no terrain drafts (terrainDraft = animating && off); 'subframes' -> updateLighting held (no history cap from change/playing/drift, no RESHAPED cap, updates every draw) so GI keeps refining across subframes.
- Verified headless dev: N=8 frame brightness = N=1; ridge stair-steps gone; 2.4 s vs 1.8 s per frame at settle 1.5. Camera view disabled + aspect 2.39 after.
- Why not CCapture motionBlurFrames: averages 8-bit tone-mapped canvas -> clipped highlights blur to grey; clock hijack conflicts with settle.

## 2026-11-12 [feather][plan][physics][bsdf][dof] Day 12 (Feather) architectural plan
- User: plan Feather sketch in Codevember.plan.md — microscopic feather detail + 2-layer strand dynamics (stems w/ variable barbule-envelope collisions + smaller hairs w/ wavelike air response, gestures & collisions), weightless connected-object feel, photorealistic match to reference macro image, static camera, exact soft gradient, real-time DoF + multi-sampled real DoF in capture.
- Measured reference image (`1024x582`, aspect `1.759`): plumulaceous white feather barbs/barbules fanning upward-left; sRGB backdrop `#46658f` (bot-left), `#4b6993` (top-left), `#4c6c93` (top-center), elliptical upper-right backlight glow `#85a0c2`; bright multi-scattered plume core `#bfcde3`..white, cool inner shadow `#839cbc`.
- Rejected stock `DepthOfFieldNode.js`: unweighted `blur64` leaks sharp bright focal hairs into far blur; `blur16` uses `max()` blocky dilation; near blend ignores `bokehScale` (TODO in three). Custom `MacroDepthOfField` `Effect` uses exact thin-lens CoC from `(fov, focusDistance, aperture)`, matching capture 1:1.
- Multi-sampled physical capture DoF math verified against `PerspectiveCamera.updateProjectionMatrix` (`left += offsetX*w/fullW`, `top -= offsetY*h/fullH`) and `View._fromSceneCamera`: camera shifts in lens plane `P0 + dx*R + dy*U` with off-axis shear `offsetX = jitterX - (dx/W_f)*width`, `offsetY = jitterY + (dy/H_f)*fullHeight` -> entire flat focal plane `z = d_f` stays exact, deterministic 5D Halton/Shirley-Chiu disk avoids temporal Monte Carlo boil; `MacroDepthOfField` bypassed during `captureChanged`.
- 2-layer GPU physics: (L0/L1) Cosserat/XPBD rachis+barbs, 2-way barb->rachis torque for connected common-fate motion, exact exponential Stokes drag (`v = u_air + (v - u_air)*exp(-gamma*dt)`, unconditional stability at microgram mass), nonlinear spongy `R_env(s)` steric collisions outputting contact vector `c_{i,j}`; (L2) 128-thread per-vane workgroups, 2-mode cantilever barbules driven by stem whip + curl-noise air waves + `c_i(s_k)` splay + shared-memory `q1[lid+-1]` neighbor steric ordering; gestures via `DrawnViewport.inputRouter` below `NavigationBehavior` (`NavigationBehavior` auto-disables on scene-camera views `#Fullscreen`/`#Active`).
- Fiber optics: Marschner/Chiang dielectric beta-keratin (`eta=1.55`, `R/TT/TRT` + medullary pith core), `Storage3DTexture` (`96x64x64`, `HalfFloatType`, `generateMipmaps=false` — confirmed in three 0.187.0) dual-scattering optical-depth volume, `1.35 px` energy-conserving ribbon clamping, 1-workgroup GPU bitonic barb sort.

## 2026-11-12 [feather][webgpu][tsl][dof][capture] Day 12 (Feather) implemented & calibrated
- Choices: `2.39:1` scope aspect; whisper hover + stronger press/drag pointer gestures.
- Root cause of earlier localhost crash: `DrawnViewport.ready()` ran inside `super()` before `ThreeViewport`'s class field `readonly inputRouter = new InputRouter(this)` initialized -> moved `_installGestureBehavior()` to `DrawnViewport.constructor` after `super(args)`.
- Four WebGPU/TSL shader bugs caught & fixed in first headless pass:
  1. `WorkgroupInfoNode.element(0)`: unlike `storageElement`, `WorkgroupInfoElementNode` does not wrap raw JS numbers -> `this.indexNode.getNodeType is not a function`; fixed in `sharedArray` (`typeof idx === 'number' ? int(idx) : idx`).
  2. `maxStorageBuffersPerShaderStage = 8`: `stemsStepCompute` bound 13 separate storage buffers -> packed into `rachisDynamicBuffer`, `barbMetaBuffer`, `stemAuxBuffer`, `capsulesAndTorqueBuffer` (`<= 7` per stage).
  3. `cameraPosition` inside shared layout `Fn` `evalKeratinFiberBSDF` -> WGSL `unresolved value 'render'`; passed `viewDir` from caller.
  4. JS unary `-d.x` on a TSL `Node` -> `NaN.0` in WGSL -> `.negate()`.
- Visual/optical calibration against reference macro photo:
  1. Exact inverse `NeutralToneMapping` (`inverseNeutralToneMappingColor`) hit measured reference corner stops within `0.002` sRGB (`#4b6993` top-left `[0.294, 0.412, 0.573]`, `#46658f` bot-left `[0.282, 0.400, 0.565]`, `#85a0c2` top-right `[0.522, 0.627, 0.761]`).
  2. Real-time `MacroDepthOfField` dotted-hair fix: `depthOnly` pass (`colorWrite: false, depthWrite: true`) uses continuous ribbon corridor (`|v| <= 0.76`) instead of coverage-dependent discard, plus half-res 9-tap tent prefilter + 1-px focal-corridor protection + 9-tap tent postfilter.
  3. Multi-sampled `Capture.ts` (`dofSamples: 32, shutter: 0`): Shirley–Chiu concentric 9-blade iris + `thinLensViewOffset` off-axis frustum shear holds focal plane pixel-exact while integrating true partial-occlusion optical bokeh; `Feather.captureChanged` auto-bypasses `MacroDepthOfField`.
- Checks: `pnpm typecheck`, `pnpm lint:check`, `pnpm test` (21/21), `pnpm build` clean (`dist/assets/Feather-*.js` 17.7 KB gzip).

## 2026-11-12 [feather][physics][jitter] Feather core jitter fixed, contact params exposed
- User: core barbs collide at high density -> jittery movement, wrong for the emotion; fix via damping / softer collisions, ideally exposed as simulation params.
- Measured rest pose (CPU, seed 12): 1532/2048 collision nodes overlap other envelopes, 7575 contacts, median 3 / p90 9 / max 19 neighbors, mean overlap 0.34, max 0.98.
- Bugs in stemsKernel: pass 1A integrated position but never stored velocity; pass 1B did vel = old vel + collision push/dt (and, by TSL re-read order, likely read curNode after overwrite). Out of contact velocity never decayed -> perpetual bounce between elastic target and contacts. Root nodes 1,2 had an ad-hoc spring velocity.
- Fix (FeatherPhysics.ts): PBD velocity; start-of-substep vel parked in stemAux frame slot (overwritten by Bishop transport later) for accel; accel low-passed (1 - exp(-40 dt)); contact radius min(sumEnv, mix(sumEnv, restDist, restOverlap)) via second shared array wgRestStations (2 x 8 KB = 16 KB limit exactly); push (R-d)*u*contactStiffness, sum capped at max single push (<= 0.045); only contactBounce of push kept as velocity; velcro exp(-contactDamping*compPeak*dt) and structural exp(-stemDamping*dt) relative to socket rootVel; barbule modes' damping x barbuleDamping.
- New Feather props: stemDamping 3, barbuleDamping 1 (Physics); envelopeScale moved + contactStiffness 0.12, contactDamping 60, contactBounce 0.15, restOverlap 1 (new Contacts group).
- Measured (headless dev, 60 fps steps, 120 frames): air 0.85 stems p99 1.67e-3 -> 3.24e-4 cm, max 3.61e-3 -> 7.50e-4; barbules p99 1.89e-3 -> 3.59e-4. Air 0 after 10 s settle: 2nd diff ~3e-7 cm, drift 0.03 mm/2 s (baseline crept ~1 mm/2 s).
- User: "it's already looking so much better I would say it's perfect." Checks: typecheck, lint:check, test 21/21, build clean. Uncommitted.

## 2026-11-12 [feather][audio][fade][camera] Feather soundtrack, white fades, camera rig
- User: add the song in feather/ (BreathOfTheStillness.mp3), adjust timeline, fade in/out like Fold but to white and 5 s, add camera rig: camera ~where it is, parented to a node at the world/feather center, rig turns ~2 revolutions per timeline.
- Track 224.0 s (browser metadata; afinfo said 224.04) -> DURATION 224.04, replaced on loadedmetadata. Extracted Fold's audio code to `src/Soundtrack.ts` (constructor(url, document); volume setter; playbackChanged; sync(time); dispose); Fold converted (no behavior change; verified t=0 black, duration 163.896).
- TimelineFade moved fold/ -> src/, `color` prop (default black). Neutral: display-space crossfade + exact inverse neutral (`inverseNeutralToneMapping` Fn, cap 0.998, select passthrough when level = 1). Others: linear mix. Verified: t=1.25/2.5/3.75 backdrop sRGB 238/193/126 = computed display mix; end frame 255.
- Rig: pivot at pose target (crown, 4.6 mm from origin) so the crown stays centered + focused. Decision: studio (backdrop + light dirs + volume key dir) rides the rig -> calibrated corners identical at 26/90/180° (#46658f, #4b6993, #85a0c2). Lens shift in Capture is in local space -> works with parented camera. orbitTurns (2) + volume (0.8) in Main.
- Air phase: round(duration/32) cycles per loop (was 1 cycle per 32 s timeline) -> same pace, seamless.
- Checks: typecheck, lint:check, test 21/21, build (mp3 hashed in dist/assets). Uncommitted.

## 2026-11-12 [feather][camera] Feather rig crane (up-and-down)
- User doubled turns (orbitTurns 4, edited in code) and asked: rig starts slightly above (tips ~mid-frame), goes down to show the stem with its root never visible, comes back up; sine, 2 cycles per timeline. Then: "1 to -3.5 is a good range in y".
- moveRig (was turnRig): Macro only, rig y = lerp(craneBottom, craneTop, 0.5 + 0.5 cos(2π craneCycles t/T)), rig xz = macro target; Full Feather holds its pose target. Props craneCycles 2, craneTop 1, craneBottom -3.5 + orbitTurns moved to new Rig group.
- Measured tips: max 1.43-1.65, p95 ~1.1-1.17, p90 0.85-1.05 (seeds 12/7/123/512/999); rachis root (1.95, -5.45, -0.46), top (0.61, -1.27, -0.35). At y=-3.5 root >= 0.8 cm below frame (max depth 7.25 -> half-height 1.15).
- Verified headless: y 0.874 at t=6, -1.25 at 28, -3.5 at 56; tips mid-frame at top, root never in frame. Offered (not done): pivot following the rachis on the way down (shaft ~0.9 cm off-axis at the bottom).

## 2026-11-12 [feather][webgpu][mrt][traa] Fix non-fullscreen orthographic TRAA MRT attachment mismatch
- User: playing Feather in non-fullscreen mode spams `Attachment state of [RenderPipeline "renderPipeline_FeatherBarbsDepth_50"] is not compatible with [RenderPassEncoder]`: pass expects 2× `RGBA16Float` (`output` + `velocity` from `traa` on orthographic axis views `Top`/`Bottom`/`Left`/`Right`/`Front`/`Back`), pipeline has 1× `RGBA16Float`. Disappears when orthographic views removed.
- Root cause in Three r187 (`NodeMaterial.js:525-598` + `WebGPUBackend.js:2479`): `material.fragmentNode !== null` skips `NodeMaterial`'s `renderer.getMRT()` block, emitting an identical 1-output fragment shader (`stageFragment.id`) in both 1-attachment and 2-attachment passes, and `getRenderCacheKey` only inspects `getCurrentColorFormat` (`textures[0]`), not `textures.length` -> cached 1-target `GPURenderPipeline` reused inside 2-target `traa` pass.
- Fix (`FeatherMaterial.ts`): switched `RachisMesh`, `BarbMesh`, and `BarbuleMesh` (both beauty and `depthOnly`) from `vertexNode` + `fragmentNode` to `positionNode` (with `positionPrevious.assign(worldVertex)` for clean `VelocityNode` motion vectors) + `colorNode` (`fog = false`), plus orthographic view-ray handling (`cameraProjectionMatrix * (0,0,0,1)` `.w > 0.5` -> `cameraWorldMatrix` `+Z`) and collinearity fallback on `cross(toCam, T)` for `Top`/`Bottom` views.
- Verified headless in non-fullscreen multi-viewport mode (`Front`, `Top`, `Perspective`, `Active` playing + all `displayBuffer` channels): zero console/WebGPU errors.

## 2026-11-12 [host][fullscreen][playback][input] Click fullscreen viewport while paused to play
- User: when Codevember demos are in fullscreen and paused, clicking on the viewport should play it just like clicking the play button.
- Fix (`IoCodevember.ts`): added a `Behavior` on `#Fullscreen.inputRouter` (`priority: BehaviorPriority.modal`) whose `click` sets `this.editor.isPlaying = true` when `event.button === 0 && this.fullscreen && !this.loading && !this.capturing && !this.editor.isPlaying`. Runs via `InputRouter._offerClick` inside `pointerup` (mouse click + touch tap, ignores drags > 4 px so paused Feather drag gestures don't trigger play, and unlocks WebAudio autoplay just like the play button). Also switched `views.fullscreen` from `profile: 'select'` to `profile: 'none'` so fullscreen clicks don't CPU-raycast scene geometry (e.g. Fold's 8M triangles).
- Verified headless + `pnpm typecheck`, `pnpm lint:check`, `pnpm test` (24/24), `pnpm build` clean.

## 2026-11-12 [feather][capture][dof] Capture strategy: forward-only simulation, lens DoF, fiber fill
- User: capture strategy for Feather. No motion blur (slow motion; scrubbing would fight the physics); the capture should play the simulation through in small steps; realistic DoF with bokeh by offsetting the camera, rendering many times, integrating into HDR.
- Found: thin-lens capture existed (dofSamples, Halton concentric iris), but: shear off by 0.13% for 4096×1716 vs camera 2.39 (io fits frame inside; vertical in-focus smear ±0.24 px); half-float sum (biased at 64+ samples); physics stepped 1/30 per frame (3 substeps of 1/90 vs 1/180–1/240 live); capture started from whatever state; settle 2 s/frame wasted (~3.7 h).
- Built (`Capture.ts`): `samples` replaces motionBlurFrames/dofSamples; `preroll`; `fill`; per-day `getCaptureDefaults`; `checkCaptureOptions`; float32 ping-pong sum; Vogel `irisSample` + `goldenStride`; `setThinLensViewOffset` (exact under the view's fit, camera aspect kept); stage 'preroll'; info `{samples, lens, fill}`. Tests moved to `src/Capture.test.ts` (focal plane to 1e-3 px in a 4096×1716 picture, thin-lens displacement, jitter, iris spread, stride).
- Built (Feather): defaults `{samples: 64, shutter: 0, settle: 0, preroll: 10}`; capture start resets physics + touch; fixed 1/120 steps (2 substeps) with remainder and per-step air phase; real-time DoF bypassed during lens capture; fiber fill in FeatherMaterial (`lensSpread`, `lensFocus`, `fiberMinWidthPx`, min width through `vRibbon.z`).
- Measured headless 4K, frame 900: 64 samples unfilled = hatching; real-time-DoF residual fill (fill 0.5/1.25 in r/√N) = smooth but soft near focus and dimmer; fiber fill at 2r/N = no effect (too small); fiber fill at 2r/√N = smooth, crisp, same brightness, matches/beats 256 unfilled; 32 OK. Same capture twice = same PNG bytes, across sessions too. Real-time view after shader change: 812 px ±1, 1 px 15 (float rounding). Timing: 17 ms/subframe (rAF 60 Hz bound), 64 samples 1.1 s/frame, 256 4.4 s.
- Checks: typecheck, lint:check, test 24/24, build. Uncommitted.

## 2026-11-13 [hollow][plan] Day 7 (Hollow) two-phase architectural plan
- Reference cave photo measured (`468×655`): skylight bright `#96cfdc`, skylight mist `#3998d1`, rear cyan steps `#6c919f`, left firelit travertine `#b07536`, warm stalactites `#845737`, right draperies `#433943`, deep lake `#1b88b0`, skylight reflection `#6bbbd6`, rimstone interior `#a56b32`, rimstone lip `#784c2a`, fg wet rock `#51474c`.
- Verified Three r187 WebGPU support in `node_modules/three`: `LightProbeGrid` + `lightProbeGridIrradiance` (`examples/jsm/lighting/LightProbeGrid.js`), `ReflectorNode` (`reflector`), `RectAreaLightNode` + `RectAreaLightTexturesLib`, `triplanarTextures`, `PMREMGenerator` + `getParallaxCorrectNormal`. Note: `RayTracedRadiosity` is r188dev + external `three-mesh-bvh` CDN, so avoided; `PostprocessingGodraysExample` runs after `ReflectorNode` and misses water reflections, so skylight shafts must be an in-scene volumetric mesh (`colorNode`, `fragmentNode === null` for TRAA MRT compatibility) + `scene.fogNode`.
- Key architectural decisions in `Codevember.plan.md` (`## 7. Hollow`):
  1. **Phase 1 (Blockout):** Seeded 3D karst SDF + CPU Surface Nets shell + `128×64×160` `RGBA16F` GPU SDF/normal volume + Voronoi boulders + rib-guided stalactites/stalagmites/fluted draperies with tangent collar skirts, clay/water preview for aesthetic sign-off.
  2. **Phase 2 (Lighting, Water, Materials):** Linearity split of two static 3-bounce `LightProbeGrid`s (`skyProbeGrid` + `fireProbeGrid` × live flickering off-screen fire uniform), `RectAreaLight`s, parallax PMREM wet specular probes, `ReflectorNode` + Beer–Lambert refraction + `512²` capillary-gravity dispersive wave PDE bouncing off SDF shorelines from stalactite-tip droplets, GPU `1024²` procedural rock/travertine atlases, world-space derivative triplanar + 3D-SDF normal/AO mesh surface blending, dual-normal wet clearcoat.



## [plan] Hollow aesthetic brief locked to ref
- User restated Hollow vision from cave ref (cyan skylight, off-screen warm fire, mirror lake + droplets, clearcoat/triplanar/SDF blend, LightProbeGrid bake, planar reflector, volumetrics, 2-phase).
- Ref saved: docs/refs/hollow-cave.jpg; plan cites it.
- Phase 1 code already present; awaiting open Q answers.

## [impl] Hollow composition + behind-camera fire
- Locked: dolly, shallow meniscus, silent.
- Fire alcove always z > cinemaPose.startZ (behind look plane); bounds +Z to 16.5.
- Seed reshuffles spine amps/bias/mirror, skylight, rimstone, galleries, cascade, vault, heroSide, cinema pose, featureDensity.
- Hollow applies seed fov/height once per seed; rocks/speleothems follow heroSide + dens.
- Tests: behind-camera fire + landmark spread across seeds.

## [impl] Hollow Phase 2 first cut
- HollowLighting: dual LightProbeGrid progressive bake, RectAreaLights, fire flicker behind camera, PMREM probes.
- HollowMaterial: LightMappedMaterial dual GI + triplanar atlases + SDF blend/AO + wet clearcoat.
- HollowWater: reflector + Beer-Lambert + droplets + CPU capillary ripples (shore mask).
- HollowVolumetrics: fogNode + additive shaft mesh (in-scene for reflector).
- Bake progress exposed; CaptureDefaults preroll 6s.

## [hollow] decisions + seed variance
- Locked: dolly, shallow meniscus, silent, fire behind cam plane.
- Seed: 5 archetypes + wider spine/sky/rim/cam/track/wall/cascade ranges; fire via look-vector; rimstone either shore; forced shallow basin floor.
- Hollow applies cinemaTracks on seed change. Tests pass.

## 2026-11-13 [rust][plan][research] Day 11 Rust: SEM rust-formation plan
- Ask: plan close-up animation of rust forming, seen by SEM; 4 user refs (~/Downloads rust1-4, watermarked stock, kept out of repo) + Maxon CRS page; deep research; most accurate CG techniques.
- Maxon page = penetrant marketing; EAG BEC 20 kV x30/x150 cross-sections: 172-296 µm laminated rust, wavy bands, cracks parallel to surface, voids, tongues ~100 µm into steel -> FIB section epilogue (band per wet/dry cycle).
- Key facts gathered: Frontiers Chem 2021 microdroplets (pure Fe, 3.5% NaCl, 85% RH): immediate, 44-328 µm from edge (5-45 min), cathodic/alkaline, Na+ via thin film, 0.36 V, 764/152 µA/cm2; Li&Hihara critical drop 40-100 µm (low-C steel); Li&Hihara 2012 pits in minutes, GR by pit, lepido outside; MnS trench (Muto/Chiba); Stratmann wet/dry; Stumm-Lee k 8e13 (t1/2 4 min pH7); NaCl DRH 75.3 / ERH ~45; akaganeite RH>=80% + Cl>=60 mg/m2/d; ISO 9223 C5 80-200 µm/yr; goethite cotton balls + pointed flowers 5-10 µm (Antunes&Costa IPEN PDF, scanned, read via Read pages); lepido globular+laminar (de la Fuente/Morcillo 2016); SEM secant law (Cazaux), light-optical analogy (Goldstein), Reuter eta, Kanaya-Okayama.
- Computed: molar-volume ratios magnetite 2.10, goethite 2.94, lepido 3.06, akag/ferrihydrite ~3.5; eta steel .28 FeOOH .22 NaCl .17 water .08; range 15 kV Fe 1.0 µm FeOOH 1.6; i_lim 10 µm film 1.9 mA/cm2; Wagner length ~2 mm (h 10 µm) vs ~0.2 mm (0.1 µm film) -> potential solve matters only in spreading film.
- Plan: bake-then-evaluate GPU sim (512² 1.25 µm grid; multigrid potential + backward-Euler transport; Tafel kinetics; phase rules; snapshots StorageArrayTexture ~84 MB; nucleation event append buffer) -> height-field steel/crust + instanced habits (rosettes, cotton balls, spindles, octahedra, GR hexagons, NaCl hoppers/dendrites) + SEM signal in-material (secant SE, edge/thin, BSE, detector march + shadow map, cavity GTAO) + SemImage effect (shot noise per scan frame seeded by timeline frame, slow-scan reveal, data bar) + stage camera at virtual WD 10 mm; capture lens = beam cone (blades 0), needs new CapturePrepare hook.
- Rejected: 90-day log clock (RH cycles strobe at ~4 Hz at end) -> 30 days ~5 s/day. Jacobi-only transport (needs ~1e4+ iters per solve) -> multigrid. Per-droplet lumped potential with atomics -> unnecessary with Newton-linearized screened Poisson (patches balance by construction).
- Research access: MDPI 403, digital.csic.es Anubis block, revistademetalurgia TLS fail, some PMC IDs captcha; PMC6895721/6829510 + Frontiers OK. WebSearch blocked twice by false-positive classifier on "micro-droplets ... spreading" phrasing -> rephrase by author/journal.
- Verified r187: IndirectStorageBufferAttribute + BufferGeometry.setIndirect, StorageArrayTexture, Storage3DTexture, atomicAdd, shadow(light) TSL, GTAONode/TRAANode/FilmNode exist.

## [hollow] Phase 2 wired into Hollow.ts
- Replaced Phase 1 blockout lights/materials with HollowLighting/Water/Volumetrics/Material.
- Renamed private field hollowLighting (Document.lighting is RenderLighting).
- Bake on renderer init + rebuild; fire flicker + droplets in onAnimate.
- typecheck/lint/hollow tests pass. Needs visual bake polish.

## 2026-11-13 [rust][decisions] Day 11 Rust open Qs answered
- User: 1 false color; 2 one large crystal but NOT isolated, view can expand to surrounding surface; 3 "30 days in 5 s sounds good but adjustable" (read as 30 d at ~5 s/day; both params exposed); 4 data bar optional; 5 no cross-section shot, Maxon xsections = reference/guidance only; 6 loop fade + new seed yes; 7 silent.
- Plan changes: salt scatter (log-normal 1-40 µm, ~20 µg/cm2, neighbours 15-25 µm rust + rings merge, coalescence, daily deposition `chlorideDeposition` ~100 mg/m2/d); nested one-way grids (surround 512² @5 µm = 2.56 mm, core 512² @1.25 µm); stage `Surface` mode, mag x50-x5000 (FOV to ~14°, slight perspective like real low-mag SEM); `dataBar` off by default; FIB trench removed -> inner bands on crack walls/flake edges/broken tubercle caps + debug `fieldView: 'Section'`; session shot 5 = wide pull-out, 6 = back in + fade + new seed; todo id rust-phase4-section-capture -> rust-phase4-session-capture; Open Questions -> Locked Decisions.
- Pace change = remap only (bake in exposure time); more days extends bake.

## [hollow] fix WebGPU reflector validation
- Console spam: TextureBinding|RenderAttachment — rimstone sampled same reflector RT while lake mirror pass wrote it.
- Fix: rimstone uses sky-glint fresnel only; reflector parented to lakeMesh; only lake samples reflector.
- Also switched GI to single visible LightProbeGrid + hemisphere fill (dual lightMapNode path left ceilings black).

## 2026-11-13 [hollow][lighting] static tweak/rebake mode
- Bloom + TimelineFade removed from Hollow effects while tuning.
- HollowLightLevels + inspector Lights sliders; rebake applies levels then bakes.
- Bake: skylight + sky area + fire area (+ fill); fire point off.
- Runtime: static fire point (no flicker); fire area stays for LTC.
- updateFire removed from onAnimate.

## 2026-11-13 [hollow][lighting] per-light bake isolation
- Bug: rebake inherited prior SH/env → successive zero-light bakes got darker gradually; bluish residual from rock rim emissive + sky portal + teal bg + ungated shafts/rimstone glint.
- Fix: clear stage disposes+recreates LightProbeGrid + clears PMREM env before direct; zero-intensity lights hidden; skyEmitter gates portal/shafts/rimstone; emissive rim off; bg #000.
- Solo-light workflow: zero all → rebake (black) → enable one → rebake.

## 2026-11-13 [hollow][review] Review + fix pass of Grok/Gemini Hollow (worktree `hollow`)
- User decisions: occluded rig (drop RectAreaLights, portal sky GI, shadowed fire in bake+realtime); restore bloom/fog/fade/flicker; GPU 512² ripple PDE; delete dead SDF-volume/dual-grid code.
- Bugs found/fixed: sun shadow frustum ±10 m (sun lit whole cave thru rock); sky RectArea pointed up (+π/2); lake reflection in albedo (black under fire); CPU ripple step not a wave eq, no uv bend, drops die after loop wrap; PMREM env added diffuse (double GI); env parallax box hardcoded; atlas sin lattice + non-periodic Voronoi seams, float32 textures; lake mesh/wave grid/rimstone pool hardcoded vs seed; Surface Nets skipped border edges -> holes (bg leaked into bake); dripstones wound inward (user spotted); gallery flare always left ignoring heroSide; zones hardcoded cascade z; rocks hardcoded camera x 0.55; speleothem "left" boost; rocks/spel used cavernWidth not widthBias; lookDy missing waterLevel; shaft raymarch outside Fn, marched backward from surface; vacuous rimSigns test; 13/40 seeds view blocked (pre-existing) -> viewClearance + retry PRNG.
- Kept seed sequence: retired lake z clip draws kept as rand() calls; 1056 composition kept (rocks shift a bit via widthScale).
- Verified headless: 1056/7/908, solo-light renders, red-bg hole test, play ripples. Checks: typecheck, lint, test, build pass.
- Tooling: node 25 runs TS via --experimental-strip-types + resolve hook (.js->.ts) for CPU field probes (scratchpad/probe).

## 2026-11-13 [hollow][lighting] Physically based light (user: PBR, VXGI light maps, no self-lit glow/fog)
- Removed: LightProbeGrid, HemisphereLight fill, GI multiplier, constant-color scene fog, unshadowed shaft mesh (HollowVolumetrics.ts deleted), unlit droplets, rimstone sky glint, envMapIntensity 0.55 (was no-op anyway).
- Added: VXGI volume + LightMapper per source (sun/fire/sky at unit intensity, live levels), unwrapUVs atlas 2048, HollowAtmosphere (participating-medium mist in fogNode: shadow-map visibility volume + HG + VXGI ambient, air mask), HollowWaterMaterial (refraction via per-RT viewportTexture, Beer–Lambert, in-water scatter, single fog application), HollowLitMaterial (lightMapNode + specular probes).
- Self-lit glow at zero lights = PMREM probes never recaptured (debounce needs a later frame; paused editor) + probes re-reflecting old probes. Fixed: recapture next frame, environmentIntensity 0 during capture, refill PMREM targets in place.
- Destroyed-texture error = viewportSharedTexture resized between cube/main passes -> viewportTexture().
- Defaults: sun 8, sky 8 (Rayleigh tint), fire 36 (decay 2), mist 0.03, exposure 0.8. Verified headless 1056/908/cutaway/zero. Checks pass.

## 2026-11-14 [hollow][polish] Soft fire shadow, smooth rimstone lip, contact AO/blend, translucent calcite
- Fire: custom `shadow.filterNode` (24 Vogel taps, 0.1 rad, receiver-plane depth so wide kernel doesn't self-shadow), map 512.
- Rimstone lip: shell refined locally (u<1.45, y wl-0.35..+0.5): per-edge splits 3 passes to ~5 cm + Newton projection onto phi=0; watertight (same open edges = chimney). +16k verts, +0.6 s.
- HollowOcclusion.ts: occluder proxies (rock ellipsoids, dripstone root capsules, 1 m grid), `bakeContact` -> `aOcclusion` (aoNode, indirect only) + `aHost` (cave normal, distance) for boulders/speleothems; material bends normal into cave's within 22 cm, zones blended on CPU. Depth-based blending rejected (MSAA depth can't be copied).
- Calcite: 3 materials now (shell, boulders, calcite). Draperies thinned to 2–7 cm (`DRAPERY_SHEET 0.3`); transmission = far-side irradiance (sun/fire via shadow maps, indirect π·ambient) × 0.5 exp(−σa s t), σa (9,22,48); bands follow smoothed edge. Dripstone path 2.5× diameter.
- Bugs found: transmission node built in ctor froze to zero (lazy Fn); comparison sampler vs textureSample (use compare in fragment, load in compute); zero lights not black: probe capture ran before ambient recombine.

## 2026-11-13 [rust] Phase 1 bake + periodic tile + volumetric material
- Chemistry: fast-reaction precipitation conservative (clamp + per-patch rescale), acid kept (no acid-dissolves-iron), CO₂-buffered pH, GR Cl-limited, label kind propagation, brine crystallizes when effloresced, exchange currents ×1/18 (~0.25 A/m²), Stratmann reduction scaled (runaway cathode fixed). Fe/Cl conserved < 0.01%, deterministic.
- Periodic 640 µm tile (multigrid + stencils + salt + drops wrap); surround grid removed; debug map tiled 3×3.
- RustVolume: time-encoded voxels (kind|birth|death), steel etch, shared 3D growth (habits, normal-framed crystals, islands, drift, repose, soft ceiling); RustSEM globule raymarch; playback waits for bake; Close stage.
- Steel grains warped + softened (no visible Voronoi). Checks: typecheck, lint, 55 tests, build, determinism (voxels/counts/crystals/snapshots identical).
- Open: Evans ring weak (coffee-ring transport next), cracks, drops/salt in image, render cost.

## 2026-11-14 [rust] smaller volume, quasi-steady precipitation, density SEM
- Volume 512²×64 at 1.25 µm (user: reduce for now), constants in µm (one setting). 64 MB + 64 MB density.
- Root cause of pillar forests: precipitation `P = (B+L)·m` ill-conditioned (D dt/dx² ~4e5) → cell checkerboard + single-cell hot spots (crust 100+ µm). Now quasi-steady: in-place (ψ>0: local OH; ψ<0: local Fe) + face flux D·k·|Δψ| across ψ=0 within FRONT_REACH 10 µm of a drop edge; patch total exact (mix), estimates scaled, misses by mix. Film-only fronts were solver error × conductance (microdroplet hot spots).
- Also: species residual shift on drop cells only (per-label shift blew up: tiny film ΣB); drop label beats microdroplet (atomicMax + LABELS); microdroplets reached by drop edge coalesce. Membrane idea (drop↔film diffusion ×1e-3) killed the ring, removed.
- Evans: drops R 60–90 µm not O₂-limited, mostly alkaline → uniform crust (~14 µm, 2.6 µm loss at 3 d), thin rim, clean film. Strong ring needs mm drops. 10 d: drop 1 film floods with Fe → dusting (open).
- Growth: inner phases onto bare metal (BARE_DRAW outer only), pockets^1.6/1.4, noise ±30% → compact crust.
- RustSEM: density pass (27-tap (1−d²/4)³, rgba8 3D, quarter-tick redraw, empty-brick skip 3.6 ms) + isosurface (SURFACE 1.4) + mx_noise grain + crystal habit SDFs + blended phase colors → botryoidal crust, rosettes, nodules; ~60 fps headless Close.
- Checks: typecheck, lint, 55 tests, build, determinism. Open: ceiling by 10 d (more layers), drops/NaCl in image, cracks.

## 2026-11-14 [hollow][contact] Seamless boulder/dripstone contacts, opaque dripstones (main checkout)
- Moved worktree `hollow` changes into the main checkout (patch; memory files merged by hand with Rust notes).
- User: contact blending did not work; asked about depth pre-pass / MSAA. Shader `aHost` bend removed (light maps ignore it).
- Tried cave-side fillet (shell field min(phi, max(smin(phi,d,k), -d)), refined): spikes from hidden rim, 81k->146k shell verts, +2.7 s. Dropped.
- Built: HollowContact.ts (bodies: rock radial SDF, dripstone frustum chain; flareIntoCave; HollowBodySet AO; bakeContact blends skirt normals/zones). Boulder templates ~7 cm (14-44 subdiv), fillet 0.35 min radius (6-30 cm); dripstone collars draped + flared, seeded stalagmites 16 sides.
- Dripstones opaque (aSheet.z = translucent flag, draperies only). One rock material for shell + boulders.
- Checks: typecheck, lint, 58 tests, build. Verified headless 1056 (slabs, stalagmites, overview).

## 2026-11-14 [hollow][sculpt] One SDF surface for cave + bodies, octree DC on workers, per-vertex GI
- User: stalagmites on slopes still disconnected, material abrupt at skirts; proposed cave + rocks + dripstones as one SDF with blended type signals, remesh, bake signals, UVs for light baking (deviation from layout OK). Later: "700k vertices is fine but 35s is way too much".
- Built: HollowSculpt (rock = ellipsoid ∩ 14 planes smax + relief 3.5% + notches; dripstone = round-cone chain, flutes where resolvable, tip >= 0.7 cell; smin with cave + each other; zones blended 2× fillet), HollowOctree (adaptive DC, crack-free, slabs + stitch), HollowSculptPool/Worker (28 slabs, hardwareConcurrency-1 workers), HollowVertexLight (per-vertex VXGI bake replaces unwrapUVs + LightMapper). HollowContact deleted, HollowShell -> HollowLake (lake + pool only), rocks/speleothems place bodies only; draperies separate mesh (aSheet vec2, aOcclusion 1).
- Perf: 35 s -> 12 s serial (profiling: hypot, memo, bound culls, hash), ~3 s in browser. unwrapUVs would have been 11.5 s + 8 texels/m.
- Fixed: open edges at volume sides (box inset), early WebGPU 3D-texture errors (air mask upload at ctor), calcite aSheet vec3->vec2.
- Checks: typecheck, lint, 58 tests (new HollowOctree.test.ts), build; headless 1056 dev + preview.

## 2026-11-14 [hollow][mesh] Draperies in the SDF, mesher follows creases and thin features
- User: draperies into the same pipeline; stalactite tips had a sharp triangle sticking out sideways; the small pool's edge had one big triangle-shaped hole; rounded steps' edges showed triangle jaggedness; improve the mesher or post-process. Budget: up to 30 s meshing; cache the default seed's mesh later.
- Probe (seed 1056): holes/spikes = leaves of 0.4–1.6 m holding surface (center-only "probably empty" test; field bends) -> folded big triangles. Fixed with corner samples (crossed / range test).
- Built: drapery bodies (sheet off folded curve, ribs, fringe, rounded rim, root in rock; min 3.8 cm), aSheet + rock/calcite groups on the cave mesh (draperyMesh gone), depth 12 (1.25 cm), sagitta refinement (feature cells), cell grading by body distance, relaxation (3 steps) + reprojection, bend-aware quad diagonals, tip radius 1.5 cm, slabs 0.8 m, clusterSurface GI proxy (VXGI 145 MB > 128 MB binding).
- Result: ~910k verts, 37 s serial, ~9.5 s in headless Chromium; significant folds ~250 / 1.8M tris (lattice-plane slivers, strata lips). Pool rim notch gone (old vs new cinema), tips clean, steps smooth, draperies fused into the ceiling.
- Checks: typecheck, lint, tests, build; headless 1056 dev (cinema, tips, pool, terrace, drapery).

## 2026-11-14 [hollow][material] Material prototype scene (HollowMaterials)
- User: material polish pass; new scene days/HollowMaterials.ts with meshes like the key geometries and selectable lighting; one cave material blending surface types from the SDF fields, world normals + world noises, PBR with albedo/reflectivity/roughness variety, clearcoat for wet patches and dripstone vertical strips; not in Hollow before greenlight. Refs: cave rock colors, cave detail color, dripstone, cave color (Desktop/ref).
- Built: HollowSurface.ts (applyHollowSurface + controls uniforms + optional transmission hook), HollowSpecimens.ts (7 SDF specimens, Union zone blending like HollowSculpt, sculptSpecimen/meshSpecimensOnWorkers, swatches, floor) + HollowSpecimenWorker.ts, HollowMaterials.ts (6 lighting conditions, rig scaled per subject, headlamp on camera scaled by distance, simple drapery transmission from the main light, Layers debug), registered in IoCodevember DOCUMENTS. roundCone exported from HollowSculpt.
- Fixed on the way: drapery/rimstone height-field normalization (holes), ellipsoid interior bound, `lighting` prop clash, empty-geometry warnings (hidden until meshed).
- Iterated 4 headless batches: less iron, grey provinces, crust on overhangs with fractal edges, bands out of bump, fbm sediment, rimstone dry crests.
- Checks: typecheck, lint, 60 tests (new HollowSpecimens.test.ts), build.

## 2026-11-14 [hollow][q] Mesh resolution location
- User asked where mesh resolution is controlled for sculptPool SDF→mesh.
- Answer: HollowSculpt.ts constants + cellFor/visit; HollowOctree contourOctree; pool only slabs/workers.

## 2026-11-14 [hollow] Material in the cave + specimen sculpting + perf
- User greenlit prototype; asked: material on cave, specimen-style dripstones for variety, flowstones where appropriate, rimstone sharp like specimen but a bit softer.
- Done: material swap (atlases gone; Surface dials; display Shaded/Layers); stalactite/stalagmite/flowstone body kinds; rimstone dam + cascade terraces with lips; tests updated (forms, flowstone, terrace crests, pool rim at waterline).
- User: "~6M vertices, 2 fps". Measured 1.13M verts; shader + fire cube shadow per frame were the cost. -> ~23 fps headless. User idea: fire as spot (1 shadow face) -> plan 5g.
- Misdiagnosis kept out: ceiling "speckle" was crust, not shadow normal-bias (reverted that change).
- Checks: typecheck, lint, 60 tests, build.

## 2026-11-14 [hollow] Carrot stalactites, longer shot
- User: some stalactites super long and thin -> carrots. Dropped `stem` (carrot + straw tail), straws ≤ 30 cm, carrot = cone (1−t)^0.8 with root flare, thicker base. Test: past 35 cm still > 2.5 cm radius halfway.
- User: camera start good; end at 5× dolly, 3× truck, 5× pan. Offsets now track·(REACH·u − 0.5). Seed 1056 path checked at 4/25/45/65/86 s: clear.
- Checks: typecheck, lint, 60 tests, build.
