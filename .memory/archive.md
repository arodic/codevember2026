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
