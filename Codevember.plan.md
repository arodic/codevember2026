---
name: Codevember 2026
overview: Thirty procedural WebGPU / TSL Document sketches in src/days/ hosted by src/IoCodevember.ts (standalone project ~/codevember, moved out of io 2026-11-12), following thespite's 2026 Codevember prompt list.
todos:
  - id: fold-plan
    content: "Day 1 (Fold): write architectural design and breakdown in Codevember.plan.md"
    status: completed
  - id: fold-kinematics
    content: "Day 1 (Fold): seeded tectonic fold & thrust-fault field, deep-time timeline kinematics, and analytical/central-difference surface & stratigraphic normals"
    status: completed
  - id: fold-stratigraphy-palette
    content: "Day 1 (Fold): multi-layer sedimentary stratigraphy, differential bed resistance, talus aprons, and editable/randomizable 6-stop desert rock palette"
    status: completed
  - id: fold-lighting-occlusion
    content: "Day 1 (Fold): horizon & fold-hinge ambient occlusion, sun shadow frustum fitting, and progressive LightProbeGrid + PMREM sky irradiance baking"
    status: completed
  - id: fold-sky-autoexposure
    content: "Day 1 (Fold): continuous 24h procedural sky with drifting volumetric clouds, twilight glow, and physically-motivated auto-exposure across day and night"
    status: completed
  - id: fold-milkyway-stars
    content: "Day 1 (Fold): flicker-free sub-pixel starfield & Milky Way dome using the arodic/milkyway minimum-screen-radius energy-conserving screen-space technique plus Yale Bright Star catalog anchors"
    status: completed
  - id: fold-verify
    content: "Day 1 (Fold): verify inspector controls, seed/palette randomization, geological animation, day/night transitions, and zero console errors in browser"
    status: completed
  - id: fold-antialiasing
    content: "Day 1 (Fold) review: no sawtooth on high-contrast ledges — continuous competence, 4× supersampled field, separable smoothing, analytic relief and lamina fade, smooth color height, shadows marched over the height field"
    status: completed
  - id: fold-irregularity
    content: "Day 1 (Fold) review: `irregularity` from parallel fold trains to random ridges, domes and basins"
    status: completed
  - id: fold-canyon-loop
    content: "Day 1 (Fold) review: looping entrenched canyon (harmonic closed curve shared by CPU and TSL) and a camera flying it inside, below the rim"
    status: completed
  - id: fold-canyon-probes
    content: "Day 1 (Fold) review: light probes along the canyon (LightProbeGrid subclass) blended with the grid in the strata material (superseded by fold-height-field-gi)"
    status: completed
  - id: fold-moon-meteors
    content: "Day 1 (Fold) review: full moon by default and Perseid shooting stars"
    status: completed
  - id: fold-probe-priority
    content: "Day 1 (Fold) review 2: probes near the camera first, per-column brightness tracking, smaller grid (superseded by fold-height-field-gi)"
    status: completed
  - id: fold-exposure-consistency
    content: "Day 1 (Fold) review 2: exposure from the sky as drawn (no nightfall white-out)"
    status: completed
  - id: fold-horseshoe-loop
    content: "Day 1 (Fold) review 2: lobed loop (left and right turns), exact canyon distance field, even-speed flight, 50% slower"
    status: completed
  - id: fold-color-pop
    content: "Day 1 (Fold) review 2: stronger, saturated bounce and a warm/cool color grade"
    status: completed
  - id: fold-height-field-gi
    content: "Day 1 (Fold) review 3: height-field GI (radiance and gather computes over the coarse field, sky radiance map) replaces the probes"
    status: completed
  - id: fold-detail-night
    content: "Day 1 (Fold) review 3: solid-noise detail varying roughness and specular, frayed sand edge, dimmer moon halo, 150k stars, 120 longer meteors"
    status: completed
  - id: fold-gi-accumulation
    content: "Day 1 (Fold) review 4: GI as a running average relative to the light level, edge-aware filter, stratified rays"
    status: completed
  - id: fold-overhangs
    content: "Day 1 (Fold) review 4: steep faces sculpted sideways into alcoves, undercuts and a basal notch that overhang (`overhang`), with lip shadows"
    status: completed
  - id: fold-sculpted-detail
    content: "Day 1 (Fold) review 4: Liesegang bands instead of Voronoi joints; varnish curtains; sand AO and fray fixes"
    status: completed
  - id: fold-clouds
    content: "Day 1 (Fold) review 5: 2.5D cumulus deck (shape, billows, LOD, light march, phase, slab slant, bank at the horizon) lit by the CPU sun model"
    status: completed
  - id: fold-meteor-shower
    content: "Day 1 (Fold) review 5: Perseid shower: 256 slots x 8 cycles per loop, rate following the radiant's altitude, faint-skewed magnitudes"
    status: completed
  - id: fold-weather-fades
    content: "Day 1 (Fold) review 6: one cloud layer (no exit sample), 4x faster time-lapse drift, cover swelling and clearing over the timeline (afternoon cumulus), 1 s fades from and to black"
    status: completed
  - id: fold-cloud-speed-meteor-fade
    content: "Day 1 (Fold) review 7: cloudSpeed slider on the clouds' own clock (2x faster default), meteors hidden by clouds per pixel, burning out from the tail to the head"
    status: completed
  - id: fold-soundtrack
    content: "Day 1 (Fold) review 8: CanyonHum.mp3 soundtrack synced with the timeline (host PlaybackListener; seek on scrub, rate easing, wrap), timeline as long as the track"
    status: completed
  - id: ship-standalone
    content: "Ship: standalone Vite project ~/codevember (moved from io packages/three/src/demos), minified bundle, all assets local, io-gui linked from the local checkout (not committed), three r187 from npm"
    status: completed
  - id: fold-camera-cinematic
    content: "Day 1 (Fold) next: cinematic camera animation in the canyon (beyond the loop flight)"
    status: pending
  - id: hollow-plan
    content: "Day 7 (Hollow): 2-phase architectural plan in Codevember.plan.md (Phase 1 procedural karst/lake/speleothem blockout + SDF mesh blending; Phase 2 dual-rig LightProbeGrid GI + off-screen fire, dispersive droplet reflector lake, volumetric skylight, triplanar clearcoat stone)"
    status: completed
  - id: hollow-phase1-karst-shell
    content: "Day 7 (Hollow) Phase 1A: 3D karst SDF spine (S-bend lake, vaulted ribs, rear skylight shaft, terraced gours, foreground rimstone dam, hidden left fire alcove), CPU Surface Nets shell + 128x64x160 HalfFloat 3D SDF/normal volume"
    status: pending
  - id: hollow-phase1-rocks-speleothems
    content: "Day 7 (Hollow) Phase 1B: Voronoi-cleaved hero boulders, rib-guided ceiling stalactites (with drip emitter sockets), pagoda stalagmites, fluted wall draperies, tangent collar skirts, 2.39:1 Cinema + Cutaway clay/water blockout review"
    status: pending
  - id: hollow-phase2-lighting-volumetrics
    content: "Day 7 (Hollow) Phase 2A: dual static LightProbeGrid GI (3-bounce cyan skylight + unit fire scaled live by flickering off-screen fire rig), RectAreaLights, localized parallax PMREM specular probes, in-scene volumetric skylight shafts & cave mist"
    status: pending
  - id: hollow-phase2-lake-droplets
    content: "Day 7 (Hollow) Phase 2B: meandering lake planar ReflectorNode + shallow Beer-Lambert refraction, falling stalactite droplets + 512x512 dispersive capillary-gravity wave compute reflecting off SDF shorelines"
    status: pending
  - id: hollow-phase2-materials-blending-verify
    content: "Day 7 (Hollow) Phase 2C: GPU-synthesized 1024^2 PBR rock/travertine atlases, world-space derivative triplanar mapping, 3D-SDF normal/AO/calcite mesh surface blending, dual-layer wet clearcoat, unit tests & WebGPU visual verification"
    status: pending
  - id: feather-plan
    content: "Day 12 (Feather): architectural plan in Codevember.plan.md (connected morphology, 2-layer envelope/wave GPU physics, keratin BSDF + 3D dual-scattering volume, real-time + multi-sampled capture DoF)"
    status: completed
  - id: feather-morphology-backdrop
    content: "Day 12 (Feather): connected rachis + ~120 C2 B-spline barbs + ~65k 3D plumulaceous barbules, static Macro/Full camera, and calibrated #46658f->#85a0c2 studio gradient backdrop"
    status: completed
  - id: feather-physics-stems
    content: "Day 12 (Feather): Layer 0/1 GPU compute (rachis + barb Cosserat/XPBD rods, 2-way rachis root torque, exponential Stokes air drag, 3-scale curl-noise air, variable barbule-envelope stem collisions)"
    status: completed
  - id: feather-physics-barbules-gestures
    content: "Day 12 (Feather): Layer 2 GPU compute (2-mode cantilever barbules, traveling air waves, stem envelope compression deflection, shared-memory neighbor steric collisions) + InputRouter gesture air-wake/brush"
    status: completed
  - id: feather-keratin-bsdf-volume
    content: "Day 12 (Feather): Marschner/Chiang dielectric beta-keratin fiber BSDF (R/TT/TRT + medullary pith), 64x48x40 HalfFloat 3D dual-scattering optical-depth volume, sub-pixel ribbon clamping, GPU parallel barb sort"
    status: completed
  - id: feather-dof-capture
    content: "Day 12 (Feather): custom physical MacroDepthOfField real-time Effect + multi-sampled off-axis thin-lens aperture DoF in Capture.ts (CaptureLens protocol, automatic post-DoF bypass)"
    status: completed
  - id: feather-verify
    content: "Day 12 (Feather): unit tests, headless WebGPU visual verification against reference macro photo (real-time + multi-sampled capture), inspector polish, typecheck/lint/build"
    status: completed
isProject: false
---

# Codevember

## Project (2026-11-12)

Standalone Vite project, moved out of io (`packages/three/src/demos/IoCodevember.ts`, `demos/codevember/`, `codevember.html`). `index.html` → `src/main.ts` → `src/IoCodevember.ts` (host; `ThreeEditorStatus.ts` copied from io, not exported there) → `src/days/<Day>.ts` (lazy chunks), Fold's modules in `src/days/fold/`.

- **Build**: `pnpm build` (tsc + `vite build`) → `dist/` with relative URLs (`base: './'`), so it deploys to any path. Terser keeps class and function names: io-gui names elements and registrations after classes. Everything is bundled (three, io-gui, the soundtrack as a hashed asset); the page fetches nothing from other origins.
- **io-gui**: `2.0.0-alpha.5` is not on npm (latest alpha.4), so package.json `link:`s `../Projects/io/packages/*`. Do not commit or push those packages; ship only the minified app bundle. Once alpha.5 is published, depend on the registry versions.
- **three**: npm `0.187.0`. Fold was built against io's linked r188dev, whose `NodeMaterial.lightMapNode` (#35318) r187 lacks; `LightMappedMaterial` (FoldTerrain.ts) overrides `setupLightMap` instead (r187 build vs r188dev: mean pixel difference 0.01 at night, identical later). Drop it once on r188.
- **io packaging fix found here**: io's `sideEffects` patterns missed `render/builtins.*` (pipelines, overlays) and `EditorDefaults.*` (pattern said `.js`, source is `.ts`), so io's own bundles dropped them, and no pattern covered the shipped `dist/index.js`, so consumers' bundlers dropped the rest of the registrations (seen: no camera frame overlay, no editor header, a warning per function row; the forward/TRAA pipeline registrations were absent from the bundle). Fixed in io's package.json files (`./dist/index.js` + both modules).

## 1. Fold

### Vision & Geological Concept

**Fold** is a real-time procedural geological diorama of an arid fold-and-thrust belt—inspired by the Zagros Simply Folded Belt, the San Rafael Swell monoclines, Painted Hills, and Sheep Mountain Anticline in Wyoming—set under a continuous 24-hour physical desert sky and a flicker-free sub-pixel Milky Way night sky. Use The Wave Rock Formation at North Coyote Buttes in Utah as visual reference.

An initially flat basin of colorful sedimentary strata (reddish-brown Navajo/Wingate sandstones, buff limestone caprock, ochre siltstones, slate-purple bentonite clays, pale gypsum beds, and dark ironstone seams) undergoes horizontal tectonic shortening ($\epsilon(t)$) over deep geological time, while differential wind and water erosion simultaneously bevels the uplifted anticline crests into hogback ridges, flatirons, breached valleys, and wind-rippled sandy aprons.

### Architecture & Technical Breakdown

1. **Seeded Tectonic Kinematics & Differential Erosion (GPU TSL + CPU Proxy)**
   - **Seeded PRNG (`seed` + `randomizeSeed` action):** Deterministic hash driving fold train wavelengths, axial trace curvature (en-échelon plunging folds), chevron vs. concentric box-fold profile (`foldSharpness`), vergence/asymmetry (`vergence`), thrust detachment ramp angle, and canyon drainage incision.
   - **Lagrangian-to-Eulerian Stratigraphic Mapping:**
     - Given world position $(x, z)$ and tectonic shortening progress $\tau \in [0, 1]$ (driven by `timeline.currentTime` during tectonic playback or adjustable via `tectonicAge`), we reconstruct the pre-deformation depositional coordinate $(x_0, y_0, z_0)$ and structural uplift $U(x, z, \tau)$.
     - Multiple harmonic fold modes along an S-curved axial trace produce a primary breached anticline flanked by synclinal basins and parasitic drag folds near a listric thrust fault ramp.
     - **Differential Stratum Competence:** Each bed thickness and lithology in stratigraphic column $s = y_0$ has a competence factor $R(s) \in [0, 1]$. Competent sandstone/limestone beds resist erosion and form overhanging cliffs, hogback cuestas, and stair-stepped ledges; recessive shale/mudstone beds erode back into talus slopes.
     - **Deep-Time Animation (`animationMode`: `'Tectonic Evolution'` | `'Diurnal Cycle'` | `'Combined'`):** Watching the timeline plays out millones of years of crustal compression: flat horizontal beds buckle upward, asymmetric limbs steepen, a blind thrust fault propagates, and erosion breaches the anticline core to expose the oldest deep strata in the central valley while wind-blown sand fills the synclinal troughs.

2. **Modifiable & Seed-Randomized Stratigraphic Color Palette**
   - **Six Editable Reactive `Color` Properties** in the `Palette` inspector group:
     - `layerColor1` (Deep Core Ironstone / Vermilion Redbed)
     - `layerColor2` (Canyon Terracotta Sandstone)
     - `layerColor3` (Ochre / Golden Siltstone)
     - `layerColor4` (Desert Sage / Bentonite Shale)
     - `layerColor5` (Pale Buff / Travertine Caprock)
     - `sandColor` (Aeolian Dune / Alluvial Apron Sand)
   - **`randomizePalette()` Action & Preset Curated Geological Palettes:** Generates geologically plausible desert palettes (iron-oxide reds, manganese purples, kaolinite whites, goethite ochres, celadonite greens) modulated by high-frequency bed-parallel lamina noise so dozens of micro-strata emerge naturally from the 6 key colors.

3. **Baked Indirect Lighting, Multi-Scale Occlusion & Desert Micro-Surfaces**
   - **Progressive Baked Global Illumination (`LightProbeGrid` + `PMREMGenerator`):**
     - An irradiance probe volume (`LightProbeGrid`) spans the canyon and fold ridges, progressively baking direct sunlight + sky dome irradiance (Pass 0) and warm terracotta canyon bounce light (Pass 1) in `onBeforeDraw` whenever geometry, palette, or sun angle changes.
     - A sky-only `PMREMGenerator` environment map (captured without the solar disc to prevent specular fireflies) provides physically accurate specular and diffuse sky fill.
   - **Three-Tier Ambient & Horizon Occlusion:**
     - **Structural Cavity & Overhang AO:** Analytical fold-trough and cliff-ledge occlusion computed from the Laplacian of structural relief and bed-step recesses.
     - **Directional Horizon Self-Shadowing:** Multi-step heightfield raymarch towards the solar azimuth and zenith hemisphere in TSL, giving crisp low-angle grazing self-shadows across fine rock ledges and deep canyon crevices even beyond shadow-map texel limits.
     - **Micro-Crevice AO:** High-frequency fracture and bedding-plane crack occlusion.
   - **Shrink-Wrapped 2048²PCF Directional Shadow Frustum:** Tightly bounds the terrain box along the sun/moon vector with normal-bias acne suppression.

4. **Procedural 24-Hour Atmosphere, Volumetric Clouds & Auto-Exposure**
   - **Preetham Physical Sky + Beer-Powder Volumetric Cloud Deck:**
     - Custom atmospheric dome extending `SkyMesh` across the full 24-hour cycle (`timeOfDay` 0–24h): warm golden-hour scattering, deep cobalt civil/nautical twilight, belt-of-Venus horizon glow at dusk/dawn, and dark nocturnal airglow at night.
     - Billowing 4-octave FBM cloud layer with Beer-Powder self-shadowing, Henyey-Greenstein silver lining, and nocturnal star/moon occlusion where clouds are dense.
   - **Physically Motivated Auto-Exposure (`autoExposure` toggle + `exposureCompensation`):**
     - Scene illuminance spans ~5 orders of magnitude from high desert noon to starlight night.
     - Smoothly adapts `toneMappingExposure` (Purkinje/scotopic-to-photopic curve) based on solar elevation, cloud cover, and ambient sky luminance so sunlit sandstone strata never clip at noon, sunset rims glow richly, and at night the exposure opens up to reveal faint moonlit/starlit rock strata and the Milky Way arch overhead.

5. **Ultra-Realistic Sub-Pixel Flicker-Free Night Sky (`arodic/milkyway` Technique + Real Star Catalog)**
   - **The `arodic/milkyway` Sub-Pixel Anti-Aliasing Technique:**
     - Traditional point or small quad particles alias and sparkle violently when their projected screen size drops below ~1.5 pixels as the camera or sky rotates.
     - Porting the exact technique from `arodic/milkyway/Assets/Shaders/ParticleRender.shader`:
       1. Each star has a physical angular/world size `size` and a minimum screen-space footprint `minSize` scaled by `1.0 / screenSize.xy` (so the quad never shrinks below a ~1.5 px anti-aliased kernel on screen).
       2. In the vertex shader, we compute the true projected screen radius `dist` and the clamped minimum screen radius `minRadius`.
       3. **Energy Conservation:** Whenever `dist < minRadius`, the star's alpha/radiance is attenuated proportionally by `(dist / minRadius)²` (or linear radial falloff `lerp(color, 0, (minRadius - dist) / minRadius)` with a Gaussian/Airy radial falloff in the fragment shader).
       4. Vertices are projected onto the far clip plane (`z = w`, or `0` in reversed-Z) with additive/screen blending (`depthWrite: false`), producing thousands of razor-sharp, sub-pixel, completely flicker-free stars across any viewport resolution.
   - **Real Bright Star Catalog + Procedural Galactic Disk & Dust Lanes:**
     - **Embedded Real Navigation & Bright Stars (~350 brightest Yale Bright Star Catalog / Hipparcos stars):** Real Right Ascension ($\alpha$), Declination ($\delta$), visual magnitude ($V$), and $B-V$ color index (Sirius, Canopus, Arcturus, Vega, Capella, Rigel, Betelgeuse, Aldebaran, Antares, Spica, Pleiades, Orion's Belt, Cassiopeia, Ursa Major, Southern Cross, Scorpius) converted to J2000 celestial sphere Cartesian vectors and blackbody Planckian RGB colors ($2800\,\text{K}$ M-giants to $25000\,\text{K}$ O/B stars).
     - **60,000 Galactic Disk & Halo Stars:** Seeded along the inclined galactic plane ($62.87^\circ$ to celestial equator) with a double-exponential thin/thick disk + central Sagittarius bulge distribution, modulated by 3D fractal dark molecular dust lanes (Great Rift / Coalsack) so the Milky Way forms a rich, dusty, luminous band arching over the folded desert canyon as the Earth rotates with `timeOfDay`.

### Implementation (2026-11-11)

Files: `src/days/Fold.ts` (Document: properties, inspector groups, timeline modes, sun/moon, exposure, key light, GI schedule) and `src/days/fold/`: `FoldTerrain.ts` (geology TSL, computes, sculpting, height-field GI, strata materials), `FoldSky.ts` (dome, shared sky uniforms, cloud deck, Milky Way glow; the CPU sky model and `SkyRadianceMap`, + test), `StarField.ts`, `Meteors.ts`, `CanyonPath.ts` (loop and its distance field; + test), `NightVision.ts` and `ColorGrade.ts` (effects), `celestial.ts` (+ test), `palettes.ts`, `brightStars.ts` (generated data).

- **Field computes** (per terrain version, per renderer, in `onBeforeDraw`), `FIELD_RESOLUTION` 2048: `field` rgba32f = height, fold uplift `U`, sand depth, canyon channel, 4× rook-supersampled (1× drafts while the timeline folds the belt, every 2nd draw, refined 8 draws after it stops), then a separable Gaussian (`smoothing` σ texels, ±5 taps); `frame` rgba16f = fold coordinates `u, um, v`; `occlusion` rgba32f 512² = cavity at 4 units + sky visibility (8 directions to 30 units; radii in world units, not texels) + coarse height (the field box-averaged over the texel; point-sampled it aliased ledges into a jagged crest); `displacement` rgba16f = the sculpting (sideways shift x, z; lowest lip's angle); `shading` rgba16f = normal of the sculpted surface (xyz) + small cavity (0.6, 1.6 units). Surface = one vertex per texel (`textureLoad`), shifted by the sculpting.
- **Sculpting** (`overhang`, 0.8 units, slider to 4): a height field cannot overhang, so steep faces are pushed sideways, each texel up its slope (taken over ±2 units of the coarse height, so floors and benches stay put) by a recess: 0.6·(1 − competence) (weak beds under resistant ones) + alcoves (fbm at 0.03 along the wall, 0.2 vertically) + the river's notch 3.4 above the canyon floor, never deeper than half the rock behind (its far side found between fixed samples, a smooth minimum: so a wall cannot come out through a fin); × a steepness ramp, × a fade toward the top of each wall (what rises within 3.5 units uphill: the rim stands out over the recess and the ledge behind it does not fold), × a fade toward its foot (how high it stands over the ground in front, fine field close by, coarse farther) and over the first 1.5 units above the sand just below, × not under sand, × away from the block's edge, × growth. Where the recess shrinks upward faster than the wall leans back, the rock above overhangs (subtle: up to ~1.8 units at 0.8). The shift is then smoothed (separable Gaussian, 4 texels) so no texel steps away from its neighbors, and the normal is the central difference of the shifted positions. Marches still run over the unsculpted field from the unshifted point, so the pass also stores the angle of the lowest lip (rises 0.5–3.8 units: protrusion vs rise), above which the material cuts the key light (`lip`) and that share of the sky (`shelter`).
- **Kinematics**: fold frame `(u, v, um)` with S-curved trace, `um = u / (1 − ε·age)`; profile sine ↔ chevron (`asin`) ↔ box (`pow`), vergence as phase skew, en-échelon plunge envelope, central anticline boost, parasitic folds on limbs; listric thrust throw `T(u, y)` on the hanging wall, late in the shortening. `irregularity` warps the map by fbm a wavelength across (axes wander and break), adds phase noise (bifurcating hinges), swells and dies out folds, and crosses them with a second set (domes and basins). Fragments read the coordinates from `frame`, so compute and fragments agree.
- **Erosion**: depth into column = bevel (`erosion · max(uplift, 0)`) + fbm roughness, breach below the caprock, the looping canyon cut down to its floor (`CanyonPath`), then `terrace()` twice (ledge/cliff by bed competence, recess of weak beds, competence eased across contacts so the surface never steps); sand smooth-max fills troughs with dunes, only a wash in the canyon.
- **Canyon** (`CanyonPath`): closed curve `r(φ) = R(1 + Σ a_k cos(kφ + p_k))`, k = 2…5; `canyonLobes` picks the dominant harmonic with amplitude `min(0.36, 1.5/k²)`, deep enough that the loop bends back between lobes (2 lobes: a figure eight that never crosses), the others small; seeded center (±4) and phases; `canyonRadius` (24–44) / `canyonWidth` (floor) / walls 15 wide; floor `-(6 + 16·canyonDepth)·(0.15 + 0.85·growth)`, analytic, so the camera and probes need no readback and never end up in rock. A distance field (512² rgba32f: distance, signed outward offset, cos/sin of the nearest point's angle) is computed from 256 centerline points when the shape changes; the landscape, the in-canyon mask and the canyon probe lookup sample it.
- **Strata color** per fragment from `d = U + T(u, y) − y`, `y` the field's cubic B-spline height (surface) or the face height (section): warped bed coordinate, bed → palette index (caprock top → redbed core, jittered), competence and tone by hash; 5 cross-bedded laminae per bed in material coordinates, faded by their frequency × pixel footprint (from distance, the projection and the viewing angle, not `fwidth`), bed partings. Solid detail (3D noise at the sculpted point, `MeshPhysicalNodeMaterial`): mottling and iron staining a unit or so across, Liesegang bands (contours of a slow fbm, in patches: smooth curves), grain and pits, which also vary roughness and specular reflectance; desert varnish in sparse dark curtains on steep competent faces, talus in hollows on slopes it can rest on; sand with an edge frayed only where there is sand, ripples with heavy minerals in their troughs, glinting quartz. Relief normal analytic in world space (lamina gradient from the bed coordinate and `∇U`; ripple gradient; grain), no screen derivatives. Same material on the block's cut faces (section).
- **Shadows/AO**: one key `DirectionalLight` (sun, or the moon when brighter); nothing casts into its (64²) shadow map. `receivedShadowNode` multiplies a 26-step height-field march toward the key light from the smooth, unsculpted surface lifted along its normal (0.3 → ~120 units, free past the rim; light fades in over a clearance of distance/16, a 3.6° sun), the lips of overhangs and the cloud deck's shadow; `aoNode` = cavity · sky visibility · lamina crevices and pits in rock (not in sand, where the laminae drew its contours) · shelter under lips.
- **GI** (height field, `FoldTerrain.updateLighting`; every 2nd draw while playing, every draw when paused until converged): a 384² grid over the block. Radiance pass: albedo/π × (the key light through the coarse march and the cloud shadow + the texel's own irradiance), so every update adds a bounce, with the rock's color. Gather pass: 6 cosine-distributed rays per texel (a golden-angle spiral, turned per texel and update) marched in 16 growing steps over the coarse height; a hit takes the radiance where it lands, an escape the sky radiance map (`SkyRadianceMap`, 48×24, the dome's CPU model with its chroma × 0.55; the ground below the horizon). Filter pass: 5×5 Gaussian, neighbors weighted by their distance off the texel's tangent plane (no bleeding over crests or up walls), then folded into a running average kept relative to the light level (sky + key light on level ground, pre-exposed), so a dusk or a jump to night rescales the light it remembers. The average spans 24 updates while the light changes (~1 s of playback), fewer while the level drifts fast (ln 0.4 over the span), at most 6 after the landscape changes, and grows to 240 once still, then idles. Strata read it as `lightMapNode` (÷ sky visibility, which `aoNode` puts back), × `bounce` (1) and saturated × `bounceSaturation` (1.2). A sky-only PMREM (second `FoldSky`, discs off, recaptured past 1.5° or 10% pre-exposure) at 0.2 for reflections.
- **Exposure**: ground illuminance `E` = `SkyRadianceMap.irradiance` (the dome's own model on the CPU: Preetham for sun and moon, twilight, night glow, integrated over the 48×24 map; ×`bounce` with GI) + direct sun and moon on level ground (through the cloud shade) → adaptation `(NOON_LUX/E)^0.86`; most of it applied as **pre-exposure** `(NOON_LUX/E)^0.8` on every light and the sky (fp16 range at night), the rest via `toneMappingExposure`; in the canyon +1 stop × the direct sun's share of `E` (walls hide the sunlit ground; nothing to hide once the sun is down). `autoExposure` off = physical fixed exposure (night is black).
- **Clouds** (2.5D cumulus deck, `FoldSky`): shape = warped 4-octave lumps carved by `cloudCoverage` (moved about by a slow weather field), billows (3-octave absolute noise) eating thin edges; octaves fade as they near a pixel's footprint (no glitter toward the horizon); optical depth ∝ density × (taller cores) × slab slant; toward the horizon the coverage rises (the ray passes the sides of many clouds: a bank), one layer (a second sample where the ray leaves the slab read as a second plane of clouds). The deck drifts and billows at time-lapse speed on its own clock (`cloudTime`, advanced in `onAnimate` by playback time × `cloudSpeed`, so the slider never makes it jump); `applyWeather` swells and clears the cover over the timeline (looping harmonics × an afternoon build-up), scaled by `cloudCoverage`/`cloudDensity`. Lit by a light march toward the sun (the moon after sunset): a near sample with billows (lobes lit on their sunward sides) + 4 coarse ones through the slab (through other clouds when low), Beer + deeper multiple scattering, dual-lobe Henyey-Greenstein (silver linings); the sun/moon light is the CPU model's (reddened, a deck that sees the sun 1.7° longer, boundary-layer haze at grazing angles), ambient from the sky map's irradiance (less on thick bases), the desert's light on the bases, the twilight underglow. Shader functions take the uniforms as arguments (shared between materials and computes). Stars and meteors use the dome's own occlusion; terrain shadows the coarse shape along the light's slant.
- **Sky**: Preetham (from `SkyMesh`, without its night-floor hacks) for the sun and for the moon (×moon/sun illuminance; the moon's aureole tighter and fainter, Mie × 0.15 at g 0.96, its disc held under 300 pre-exposed so the bloom does not spread it over the sky), twilight model (0.4 decades/°, ozone blue, sunward glow, Earth shadow + Belt of Venus), airglow with van Rhijn brightening, Milky Way disk/bulge glow with dust (Great Rift), phased moon disc with maria, cloud deck (SkyMesh noise, timeline drift) lit by sun, moon and twilight underglow; dim desert floor below the horizon.
- **Celestial**: North Coyote Buttes 36.99° N, mid-August (sun λ 143°); LST from solar time; equatorial→local `Matrix3` turns stars and Milky Way; moon at `λ_sun + phase·360°`, ecliptic latitude 3° (a full moon, the default, is not eclipsed).
- **Stars**: 518 BSC5 stars (V ≤ 4, J2000, from brettonw/YaleBrightStarCatalog JSON) + 150,000 seeded thin/thick disk, bulge, halo stars; instanced quads, arodic/milkyway footprint: physical size 0.0005 rad, min half-width `minStarSize` px, light × (projected/min)² (area ratio), Gaussian kernel normalized over the quad, far plane, additive; air-mass extinction, cloud opacity per vertex, dust for field stars.
- **Meteors** (a shower): 256 Perseid slots (radiant RA 48°, Dec +58°), each firing 8 times per loop at its own moment in each cycle, drawn anew each time (heading, distance from the radiant, magnitude 3.5 − 6.5u², mostly faint, now and then a fireball) if under `shootingStars` (0.7) × 0.25–1 by the radiant's altitude (the shower builds through the night); streak along the great circle away from the radiant, 0.5–1.1 s of playback, 15–45° trails, brightest at the head and dimmer down the trail, burning out from the tail (a front sweeps from the tail past the head over the last 45% of its life), hidden by clouds and the horizon per pixel as the dome draws them, head as bright as a star at the minimum footprint, trail growing behind; screen-aligned band at the far plane, clouds and horizon dim it.
- **Timeline**: as long as the soundtrack (163.9 s; the track's metadata sets it once loaded), autoplay. Opens on seed 998; each loop back while playing (behind the fade to black) draws a new seed, as a draft refined a few draws later. `Diurnal Cycle` (default): day from 16 h; `Tectonic Evolution`: age 0 → 1 by 100 s; `Combined`: both, 3 days. Driven properties are written in `onAnimate`.
- **Soundtrack** (`fold/CanyonHum.mp3`, an `HTMLAudioElement` the document owns, `volume`): the Codevember host tells a document with `playbackChanged` (`PlaybackListener`) when the editor starts and stops playing it (pause, another document, leaving the page). It starts at the playhead when playing starts and plays on its own clock (a little drift is fine: easing its rate every frame crackled); it is moved to the playhead again only when the two part by more than 1 s (a scrub while playing, the loop's wrap), and having ended a moment early it waits for the wrap. Held by the browser's autoplay policy, it starts on the first pointer press or key.
- **Fades** (`TimelineFade` effect, last): 1 s from black at the start of the timeline and to black at its end (eased).
- **Grade** (`ColorGrade` effect, post, before `NightVision`): vibrance (muted colors saturate most) and split toning (cool shades, warm lights, by exposed luminance), stronger at golden and blue hour (`goldenHour` from the sun's altitude, −12°…18°).
- **Camera** (`cameraMode`): `Canyon` (default) flies the loop once per playback at an even speed (angle by arc length, `CanyonPath.angleAt`), 3.4 over the floor ± 1.0, swaying 0.7 across, looking 18 units ahead along the canyon and up to 5 units higher, FOV 58; `Overview` frames the block from the north rim.

Deviations from the design above:
- 518 catalog stars (V ≤ 4) instead of ~350: constellations read better, 12 KB.
- `NightVision` (Purkinje) document effect added: at full adaptation a moonlit night looked like day; rods desaturate/blue-shift by `log10 E` (10 → 0.03 lux).
- Pre-exposure added (fp16 precision at night); not in the design.
- Energy conservation uses the area ratio `(dist/minRadius)²`, not the shader's linear ratio.
- The PMREM env and probes are re-captured only past a threshold of key-light motion / pre-exposure, not on every sun change.
- Default camera looks south from the north rim: evening sun from the right, galactic core over the block.
- Below-horizon sky is a dim desert floor (the block is a floating diorama with cut faces).

Verification (headless Chromium WebGPU, `codevember.html#codevember=Fold`): day, golden hour, twilight, moonlit and moonless nights; tectonic stages 0–1; seed, palette presets, `randomizePalette`, `randomizeSeed`; all animation modes; gi on/off; Perspective view; bake goes idle when paused; stress (25 rapid edits while playing) clean. Iteration 2 at 2048²: canyon flight around the loop at every hour, close-ups of steep walls (no dot lattice, ribbing or dashes), irregularity 0 / 0.5 / 1 top-down, tectonic stages with the canyon, Perseids aimed at, full-moon nights; ~49 fps (one view) in Diurnal, ~35 in Combined, ~46 in Tectonic; 3 fresh loads + stress clean. `celestial.test.ts` 9/9, `CanyonPath.test.ts` 4/4, three suite 306/306.

Iteration 2 (2026-11-11, review): the sawtooth on high-contrast geology had several causes, fixed at the root rather than by resolution: (1) the recess term read competence through `floor()`, so the height jumped at bed contacts, a true discontinuity that aliases at any resolution; (2) the lamina bump and fade used screen derivatives, which differ from one triangle of a steep height-field wall to the next (a dot lattice along the laminae); (3) laminae followed the triangles' zigzag around the field (now the B-spline height); (4) the shadow map of that geometry, and the march starting from the triangles (now from the smooth surface); (5) cavity / sky-visibility radii were in texels, so at 2048 the horizon search reached 7 units. The canyon became a loop entrenched through the belt, the camera flies inside it, probes stand along it, the moon is full by default, Perseids fall.

Deviations (iteration 2):
- Terrain shadows come only from the height-field march; the key light keeps a shadow map nothing casts into (so `receivedShadowNode` still applies).
- `LightProbeGrid`s are not scene lights here: the strata look both sets up themselves (`lightMapNode`); bounces come from baking against the previous bake instead of pass 1.
- `NightVision` capped at 0.6 (was 0.8), for moonlit-photography color.
- Canyon defaults: floor width 14, walls 15, depth 0.75 (a slot canyon read as black walls).

Iteration 3 (2026-11-11, review 2): the probe lag and the white-out at nightfall had one root each. The exposure adapted to a twilight table that the drawn sky outshone several times at sunset, and stale probes kept their capture brightness while the sky fell by decades over their bake lag. Now the exposure integrates the dome's own model, and every probe column carries the light it was baked in, so only its color lags; the columns the camera sees are rebaked first (a frustum test was not needed: the camera is in the canyon and sees only the part around it). Measured during nightfall: columns around the camera within 0.82–1.0 of their bake level; 60 fps (one view) in all three modes. The loop got lobes (left and right turns) and an exact distance field (the polar distance had collapsed toward the center with deep lobes and carved a bow-tie there), the flight an even speed, the timeline half the speed.

Deviations (iteration 3):
- `bounce` scales all the probe light (sky as well as rock) and the exposure counts the sky at that strength, so it trades fill against sun without brightening the frame.
- Timeline 120 s for "50% slower" (half the speed).

Iteration 4 (2026-11-11, review 3): probes popped when rebaked and went stale in the distance; replaced by the height-field GI (nothing baked or rendered into cubes: every texel updates and blends, color bleeding from the albedo). Detail at a unit and finer in solid noise, roughness and specular following it; the sand's edge frayed; the moon's halo reduced; 150,000 stars; 120 longer meteors.

Iteration 5 (2026-11-12, review 4): the GI accumulates (a running average instead of a fixed 0.2 blend, an edge-aware filter of each estimate, stratified rays): while playing, the irradiance changes 0.5% (median; p99 1.5%) per 100 ms at midday, 1.6% at dusk. Kept relative to the light level, since a running average across a dusk otherwise remembered daylight and blew the night out. The Voronoi joints (straight, angular) gave way to Liesegang bands. Steep faces are sculpted into alcoves, undercuts and a basal notch that can overhang (`overhang`). Fixed on the way: the lamina-crevice AO drew contour stripes on the sand (radial in the canyon flight, where they run along the walls); the sand fray scattered sand blobs over bare rock; glossy varnish streaks read as white flecks; the coarse height was point-sampled; the moon's disc bloomed into a 6° ball; the sky's deep blue turned the shaded sand olive. 60 fps (one view, 1600×1000) in Diurnal with or without GI, 43 in Combined, 47 in Tectonic. 17 tests in the three codevember files; three suite 310/310.

Iteration 6 (2026-11-12, review 5): clouds rebuilt (the deck was one 4-octave noise lit evenly: soft smudges); a meteor shower (2048 chances a loop instead of 120); alcoves at half the frequency, `overhang` slider to 4. Fixed on the way: clouds as plain JS noise inlined their octaves into every shader (about 1 fps), and a shared shader function that read uniforms failed to bind them in the compute and strata shaders. Frame rates measured on battery in Low Power Mode and with the browser open varied 8–60 fps for the same view; with the GPU free: 60 in Diurnal (clouds on or off), 60 paused at night, 44 Tectonic, ~35 Combined.

Iteration 7 (2026-11-12, review 6): the clouds' second sample (where a ray leaves the slab) showed as a second parallel plane; replaced by a coverage rise toward the horizon. Clouds 4× faster; weather over the timeline; timeline fades.

Iteration 8 (2026-11-12, review 7): `cloudSpeed` slider (clouds 2× faster at 1); meteors behind clouds point by point (the occlusion was taken at the head for the whole streak); meteors burn out from the tail to the head (they faded as a whole).

Iteration 9 (2026-11-12, review 8): the soundtrack, the timeline its length. Review 9: the per-frame rate easing crackled; now synced only at the start, past 1 s apart (scrub) and at the wrap (about 0.1 s drift after 4 s, headless).

Iteration 10 (2026-11-12, review 10): jagged triangles and strips torn at the sand line and just below it at high `overhang`: the sand mask switched the shift off within a texel, thinly sanded texels at a wall's foot were shifted, and the fin guard limited the shift in steps. Now foot and sand-line fades, a continuous fin guard and a smoothing pass. Measured (neighboring vertices whose shifts differ by > 0.4 units over < 0.25 of height): 1,768 → 0 at 0.8, 22,681 → 0 at 2, 68,344 → 2,401 at 4; largest jump between neighbors 0.91 → 0.11 at 0.8, 3.5 → 0.5 at 4.

Deviations (iterations 4–5):
- Detail is solid (3D world-space) noise instead of triplanar mapping: procedural detail has nothing to project, so nothing stretches on steep faces and no blend seams show; triplanar would only matter for image textures.
- The sky's light keeps 55% of its chroma (lighting only; the dome keeps its color).
- Shadow penumbra as from a 3.6° sun (was ~11°).
- Overhangs are a sideways displacement of the height-field mesh; the marches and the GI do not see them (the lip term stands in for their shadow).

Open items:
- Once in ~18 headless loads: WebGPU warning `Invalid CommandBuffer from CommandEncoder "renderContext_N"` after which frames went stale; root validation message not captured, not reproduced since (13 loads, stress, module invalidation).
- Cinematic camera beyond the loop flight (shots, framing the night sky, pacing with the day) — next step.
- Overhang lips are as fine as the grid's rows on a cliff (0.08 units × slope): from `overhang` ~2 up their edges look serrated.
- Clouds are a 2.5D layer (no volumetric towers, no cirrus); the exposure's cloud shade is still a coverage factor.
- Moonlit sand shows faint streaks along the moon's azimuth (march penumbra over the coarse field); a thin dark stroke on the sand at one spot of the loop, present without sculpting too, not yet traced.
- Milky Way dust is fbm, not a map; bulge shape approximate.

### Todo Breakdown

- [x] **1. Plan & Design (`fold-plan`):** Document geological kinematics, `arodic/milkyway` sub-pixel star shader math, lighting/baking pipeline, and inspector UI in `Codevember.plan.md`.
- [x] **2. Seeded Tectonic Fold Field & Kinematics (`fold-kinematics`):** Build deterministic PRNG, S-curved axial trace, multi-harmonic chevron/box fold displacement, listric thrust ramp, canyon drainage incision, and CPU proxy mesh for framing and GI baking.
- [x] **3. Stratigraphy & Desert Rock Palette (`fold-stratigraphy-palette`):** Implement 3D deformed stratigraphic coordinate $s(x, y, z)$, differential cliff/ledge competence profiling, aeolian sand accumulation in troughs, 6 editable `Color` properties, and `randomizePalette` / `randomizeSeed` buttons.
- [x] **4. Baked GI, Horizon Occlusion & Shadows (`fold-lighting-occlusion`):** Wire `LightProbeGrid` progressive 2-pass bounce baking + sky `PMREMGenerator`, directional sun/moon shadow frustum fitting, and 3-scale AO (structural cavity AO, TSL solar horizon self-shadowing, micro-fracture AO).
- [x] **5. 24h Procedural Sky, Volumetric Clouds & Auto-Exposure (`fold-sky-autoexposure`):** Configure atmospheric scattering + billowing cloud deck linked to `timeline.timeNode` and `timeOfDay`, twilight horizon glow, and automatic exposure adaptation across day, sunset, and deep night.
- [x] **6. Sub-Pixel Flicker-Free Starfield & Milky Way (`fold-milkyway-stars`):** Implement the `arodic/milkyway` screen-space minimum-radius energy-conserving star shader with real Yale Bright Star catalog data + 60,000 galactic disk/bulge stars and dark dust-lane extinction, rotating with sidereal time.
- [x] **7. Verification & Polish (`fold-verify`):** Test in live browser (`codevember.html#codevember=Fold`), verify all inspector controls, seed/palette randomization, geological & diurnal animations, and ensure zero console/WebGPU errors.

## 2. Shatter

## 3. Melt

## 4. Tangle

## 5. Moss

## 6. Orrery

## 7. Hollow

### Vision & Speleological Concept

**Hollow** is a photorealistic procedural karst limestone cavern composed for `2.39:1` CinemaScope (`1 unit = 1 m`), translating the reference cave's complementary chiaroscuro and geology into widescreen ([`docs/refs/hollow-cave.jpg`](docs/refs/hollow-cave.jpg)):
- **Cool Cyan Skylight (`#3998d1`–`#96cfdc`):** Single upper-rear karst sinkhole opening pouring bluish daylight, crepuscular shafts, and misty haze (`#6c919f`) down onto terraced travertine steps (`gours`).
- **Warm Off-Screen Firelight (`#b07536`–`#ff9438`):** Hidden flame source in an alcove **behind the cinema camera plane** (never in frame)—bathing left stratified ledges, pagoda stalagmites, ceiling stalactite curtains (`#845737`), and foreground scalloped **rimstone dam (`gour`) pool** (`#a56b32` basin, `#784c2a` lip) in breathing amber-gold glow.
- **Meandering Mirror Lake & Droplets (`#1b88b0` / `#6bbbd6`):** Dead-still subterranean pool winding from lower-left foreground around the rimstone dam and a cleaved right-hand boulder toward rear cascade steps; sporadic water droplets detach from ceiling stalactites and trigger dispersive concentric ripple patterns that bend the mirror reflection and rebound off rocky shores.
- **Framing (`fov ≈ 40°`):** Foreground wet fractured dark limestone benches (`#51474c`) and right-hand fluted drapery buttress (`#433943`) frame the cavern depth (`repoussoir`).

---

### Two-Phase Execution Strategy

Split into two reviewable milestones so cavern architecture, proportions, water lines, and speleothem composition are locked in fast clay/preview shading before GI baking, volumetrics, water simulation, and multi-layer materials.

---

### Phase 1 — Procedural Karst Generation, Speleothems & Seamless Blockout

**Files:** `src/days/Hollow.ts`, `src/days/hollow/{HollowField,HollowShell,HollowRocks,HollowSpeleothems}.ts`, `HollowField.test.ts`.

1. **3D Karst Signed Distance Field (`HollowField.ts`, deterministic seeded PRNG)**
   - **Bounds:** `X ∈ [-14, 14] m`, `Y ∈ [-3, 11] m`, `Z ∈ [-28, 8] m`.
   - **Meandering Cavern Spine:** S-curved centerline $(x_c(z), y_{\text{floor}}(z))$ sweeping an asymmetric vaulted cross-section:
     - *Main Flooded Grotto (`z ∈ [-10, +6]`):* Lake basin below $y = 0$, vaulted ceiling $y \approx 5.5\text{–}7.2\,\text{m}$ scored by diagonal joint-guided **ceiling dissolution ribs** (matching reference upper-left-to-center stalactite arcs).
     - *Warm Travertine Gallery & Behind-Camera Fire Alcove:* Stepped rock shelf opposite the hero boulder; fire pocket sits at $z > z_{\text{camera}}$ (behind the cinema plane) so only amber spill reads in frame.
     - *Rear Cascade & Skylight Shaft (`z ∈ [-25, -10]`):* Floor climbs $y = 0 \to +2.4\,\text{m}$ via 8–12 scalloped horizontal travertine `gour` steps beneath an angled karst chimney opening to the sky at `(x ≈ +2.5, y ≈ +9.5, z ≈ -20)`.
     - *Foreground Rimstone Dam (`x ≈ -2.8, z ≈ +1.2`):* Kidney-shaped raised calcified rim (`smin` fused to left shore) enclosing a shallow flat mineral basin just above lake level.
   - **Lithological Sculpting in SDF:** Continuous bed-competence terracing (`terrace(y + dip)`) cuts horizontal limestone strata ledges into walls; phreatic dissolution noise carves ceiling cupolas. All structural unions use polynomial `smin(a, b, k)` (`k = 0.6–1.4 m` vaults, `k = 0.1–0.25 m` terraces) for $C^1$ topological fillets.

2. **Surface Nets Cavern Extraction & Shared GPU 3D SDF Volume (`HollowShell.ts`)**
   - **CPU Dual/Surface Nets (`~150 × 84 × 180`, ~18 cm cells):** Extracts clean manifold quad/triangle indexed `BufferGeometry` (`~90k–130k` tris, zero Marching Cubes sliver triangles, exact central-difference SDF normals).
   - **GPU 3D Distance & Gradient Volume (`Data3DTexture` `128 × 64 × 160` `RGBA16F`, ~10 MB):** Stores $\Phi(\mathbf{x}) = (\nabla\phi_{\text{total}}(\mathbf{x}), \phi_{\text{total}}(\mathbf{x}))$ uniting the cave shell + static boulder proxies. Sampled by all TSL shaders for seamless normal/material blending, 3D SDF ambient occlusion, probe-offset biasing, and lake shoreline wave reflection.

3. **Procedural Rocks, Boulders & Speleothems (`HollowRocks.ts`, `HollowSpeleothems.ts`)**
   - **Cleaved Boulders & Buttresses:** Subdivided polyhedra sculpted by Voronoi planar bevel cuts (`smax`) + bedding notches + flared basal skirts; includes hero angular boulder jutting into right pool (`x ≈ +2.3, z ≈ -4.2`) and foreground wet rock benches.
   - **Ceiling Stalactites & Curtain Ribs:** Spawned on ceiling convex ribs ($N_y < -0.45$, high rib curvature); tapered fluted calcite icicles with conical ceiling root bosses. `8–16` stalactite tips directly above deep water register as **active droplet emitters** $(x_i, y_{\text{tip},i}, z_i)$.
   - **Ledge Stalagmites:** Stacked drip-ring pagoda/conical profiles with broad flowstone pedestals (`smin` flared collar) on flat shelves ($N_y > 0.75$, left firelit gallery).
   - **Fluted Wall Draperies ("Cave Bacon" / Organ-Pipe Curtains):** Swept S-folded ribbon meshes hanging down upper-right and upper-left overhangs with downward-growing vertical flutes and serrated icicle fringes.

4. **Phase 1 Blockout Review Mode**
   - Clean warm/cool preview rig + matte clay / geological-zone debug shading + flat translucent water plane.
   - Inspector controls for `seed`, `cavernWidth`, `vaultHeight`, `meander`, `skylightSize`, `terraceSteps`, `rimstoneScale`, `stalactiteDensity`, `draperyScale`, `waterLevel`, plus `cameraMode: 'Cinema' | 'Cutaway Overview'` (hides/clips upper roof in editor overview for layout inspection).

---

### Phase 2 — Static GI Baking, Fire Atmosphere, Rippling Reflector Lake, Volumetrics & Clearcoat Lithology

**Files:** `src/days/hollow/{HollowLighting,HollowWater,HollowVolumetrics,HollowMaterial}.ts`.

1. **Dual-Rig Static GI Baking + Live Off-Screen Fire + Area Lights (`HollowLighting.ts`)**
   - **Linearity Trick for Static Bake + Live Flickering Fire (`0 ms/frame` runtime GI cost):**
     - Bake **two** GPU-resident `LightProbeGrid` L2 SH volumes (`three/addons/lighting/LightProbeGrid.js`, e.g. `16 × 10 × 22` probes, 3 bounces in `onBeforeDraw` on seed/layout change):
       1. `skyProbeGrid`: multi-bounce cyan indirect light from the skylight shaft + sky portal.
       2. `fireProbeGrid`: multi-bounce amber indirect light from the occluded left fire alcove at unit intensity.
     - Sample both in `LightMappedMaterial` via `lightProbeGridIrradiance(grid, safePos, normal)` (`safePos` pushed out of rock using $\Phi(\mathbf{x})$ gradient so wall-embedded probes never leak dark), combining live at 60 fps:
       $$\mathbf{E}_{\text{GI}}(\mathbf{x},\mathbf{N},t) = \mathbf{E}_{\text{sky}}(\mathbf{x},\mathbf{N}) + I_{\text{fire}}(t)\,\mathbf{T}_{\text{fire}}(t)\,\mathbf{E}_{\text{fire}}(\mathbf{x},\mathbf{N})$$
   - **Direct & Area Lights (`RectAreaLightNode` LTC + Shadow Lights):**
     - *Skylight:* Shadow-casting `DirectionalLight`/`SpotLight` (`2048²` PCF) through the top opening + tilted cyan `RectAreaLight` across the sinkhole aperture for broad wet-rock specular sheen + 8-step 3D-SDF soft penumbra cone toward the wide opening.
     - *Off-Screen Fire:* Occluded left alcove rig combining a warm `RectAreaLight` (broad orange-white wet specular wrap) + shadow-casting `PointLight` (`1024²`) whose position dances (`±10 cm` band-limited curl noise) and whose intensity/Planckian tint (`1850 K–2350 K`) flickers time-periodically over `timeline.duration`.
   - **Localized Wet Specular Probes:** `2` static `CubeCamera` → `PMREMGenerator` cubemaps (Main Lake Grotto + Rear Skylight Chamber) baked post-GI with box/ellipsoid parallax correction (`getParallaxCorrectNormal`), blended in `envNode` (fire lobe scaled by $I_{\text{fire}}(t)$) for crisp skylight/fire glints on wet clearcoat rock.

2. **Meandering Mirror Lake & Dispersive Droplet Ripples (`HollowWater.ts`)**
   - **Planar Mirror (`reflector({ resolutionScale: 0.75, bounces: false, generateMipmaps: true })`):** Dead-still reflection at $y = 0$ weighted by exact dielectric water Fresnel ($F_0 = 0.02$, $\eta = 1.333$).
   - **Shallow Mineral Water Absorption & Refraction:** Reads `viewportDepthTexture` / `viewportSharedTexture` (`BackdropWaterExample` pattern) with Beer–Lambert absorption ($\boldsymbol{\sigma}_a$ tuned so $< 0.35\,\text{m}$ shores glow warm ochre `#a56b32` and deeper pool shifts to `#1b88b0` cerulean).
   - **Falling Stalactite Droplets & `512 × 512` Dispersive Wave Compute:**
     - Seeded periodic schedule spawns glinting elongated droplets from the ceiling stalactite emitter tips; droplets accelerate under $g = 9.81\,\text{m/s}^2$ and inject impulses on lake impact (`preroll: 6 s` in `CaptureDefaults`).
     - `512 × 512` `RG16F`/`R32F` GPU ping-pong wave PDE augmented with **capillary surface-tension dispersion** ($-\beta\nabla^4\eta$, producing multi-ring concentric capillary-gravity wave trains instead of single dull humps) and **Neumann boundary reflection** against the SDF shoreline mask ($\phi_{\text{total}}(x, 0, z) \le 0$), so ripples physically bounce off the rimstone dam and right boulder and bend `reflector.uvNode`.

3. **In-Scene Volumetric Skylight Shafts & Cave Mist (`HollowVolumetrics.ts`)**
   - **Why In-Scene (not post-only `GodraysNode`):** Post-processing effects run after `ReflectorNode`, which would leave the lake reflection missing the cyan mist and shafts.
   - **Dual-Stage Atmosphere:**
     1. `scene.fogNode`: distance + height cave haze tinting rear chamber (`z < -10`) toward `#3998d1` while keeping foreground grotto clear.
     2. **Volumetric Skylight Shaft Mesh:** Bounding volume in rear chamber (`colorNode` + premultiplied alpha, `fragmentNode === null` so editor `traa` MRT views stay valid) raymarching `20` jittered steps through Skylight `2048²` shadow map + 3D humidity FBM with Henyey–Greenstein forward scattering ($g = 0.65$)—visible directly AND reflected in the mirror lake (`#6bbbd6`).

4. **Seamless Mesh Surface Blending & Hyper-Realistic Wet Clearcoat Stone (`HollowMaterial.ts`)**
   - **GPU-Baked `1024²` Seamless PBR Detail Atlases (once in `onRendererInitialized`, `< 15 ms`, mipmapped + anisotropic):**
     1. *Fractured Cleaved Limestone* (Voronoi facets, micro-cracks, spar veins, pits),
     2. *Fluted Travertine & Micro-Terraced `Gour` Sinter* (scalloped calcified micro-ridges + crystal sparkle),
     3. *Karst Dissolution & Seepage* (phreatic scallops, mineral curtains).
   - **3-Tier Seamless Rock-to-Rock & Rock-to-Cave Blending:**
     1. *Vertex Collar Flare:* Placed rock/dripstone skirts project onto $\phi_{\text{cave}} = 0$ at grazing tangent angles.
     2. *TSL 3D-SDF Normal & AO Fillet:* Within fracture-noise-modulated contact band $|\phi_{\text{cave}}| < w_{\text{blend}}$, mesh macro normal relaxes to $\nabla\phi_{\text{total}}(\mathbf{x})$, eliminating $C^0$ shading creases; 6-tap 3D-SDF cone AO adds natural calcite/crevice contact darkening.
     3. *Continuous World-Space Derivative Triplanar:* Tightened triplanar weights ($\|\mathbf{N}\|^5$) in `positionWorld` space using tangent-free surface-gradient / UDN normal blending—identical detail across mesh boundaries with zero UV seams.
   - **Hydrological Wetness & Dual-Normal Clearcoat (`MeshPhysicalNodeMaterial`):**
     - Wetness field $W(\mathbf{x})$ (lake capillary fringe $y < 0.65\,\text{m}$, rimstone lip, active drip streaks, stalactite tips) darkens porous base albedo ($\text{albedo}^{1.45} \times 0.52$), lowers base roughness, and drives `clearcoatNode` ($0 \to 1$, `clearcoatRoughness: 0.04–0.12`) over a **smoothed `clearcoatNormalNode`** so liquid water films bridge micro-grain pits while preserving sharp rock detail underneath.
     - Thin calcite speleothems & draperies add backlit **subsurface wrap transmission** so thin curtains glow warm amber / cool cyan at their edges.

---

### Todo Breakdown

- [x] **1. Plan & Design (`hollow-plan`):** Two-phase architectural plan in `Codevember.plan.md`.
- [ ] **2. Phase 1A — Karst SDF & Surface Nets Cavern (`hollow-phase1-karst-shell`):** Seeded S-bend cavern + skylight + terraced `gours` + rimstone dam + hidden fire alcove SDF, Surface Nets shell mesh, `128×64×160` GPU 3D SDF/normal volume, and unit tests.
- [ ] **3. Phase 1B — Rocks, Dripstones & Blockout Review (`hollow-phase1-rocks-speleothems`):** Voronoi-cleaved boulders, rib-guided stalactites (with drip emitters), pagoda stalagmites, fluted draperies, collar skirts, `Cinema` / `Cutaway` blockout materials, enable `Hollow` in `IoCodevember.ts` for layout review.
- [ ] **4. Phase 2A — Baked GI, Fire Rig, Area Lights & Volumetrics (`hollow-phase2-lighting-volumetrics`):** Dual `LightProbeGrid` bake (`sky` + live-scaled `fire`), `RectAreaLight`s, parallax PMREM specular probes, `scene.fogNode` + in-scene volumetric skylight shafts.
- [ ] **5. Phase 2B — Mirror Lake & Dispersive Droplet Ripples (`hollow-phase2-lake-droplets`):** `ReflectorNode` + shallow Beer–Lambert refraction, falling droplets from stalactite tips, `512²` capillary-gravity wave compute with SDF shoreline reflections.
- [ ] **6. Phase 2C — Clearcoat Lithology, Mesh Blending & Polish (`hollow-phase2-materials-blending-verify`):** GPU `1024²` procedural rock/travertine atlases, world-space derivative triplanar, SDF normal/AO mesh blending, wet clearcoat + calcite translucency, `CaptureDefaults`, headless WebGPU verification.

### Locked Decisions

1. **Camera motion:** Keep subtle looping dolly / lateral track (`trackForward` / `trackLateral` / `trackLookDrift`).
2. **Rimstone (`gour`) pool water:** Own elevated shallow amber meniscus (`RIMSTONE_POOL_STEP ≈ +8.5 cm` above main lake).
3. **Audio:** Silent for now (no `Soundtrack` until later).
4. **Warm light placement:** Fire alcove always behind the cinema camera plane so only spill/atmosphere reads in frame.
5. **Seed hunting:** Seed must reshuffle major composition landmarks (spine, skylight, lake/rimstone, galleries, fire, camera base pose, hero rock side) so many seeds yield distinct widescreen frames.

## 8. Tesseract

## 9. Membrane

## 10. Caustic

## 11. Rust

## 12. Feather

### Vision & Macro-Optical Concept

**Feather** is an ultra-photorealistic macro photography study and two-layer aerodynamic GPU simulation of a single connected snowy-white plumulaceous feather (`1 scene unit = 1 cm`). Framed initially through a static 85–100 mm macro lens against a soft cerulean-slate studio backdrop matching the reference photograph (`#46658f` lower-left, `#4b6993` upper-left, `#4c6c93` top-center, sweeping into a luminous `#85a0c2` upper-right backlight softbox glow), dozens of slender arched barbs (`rami`) and tens of thousands of microscopic hair-like barbules (`radii`) float in neutral buoyancy, responding with weightless Stokes-drag sensitivity to millimeter-scale air currents and gentle pointer gestures while moving unmistakably as one unified feather anchored to a single elastic central shaft (`rachis`).

### Architecture & Technical Breakdown

1. **Connected 3-Level Feather Morphology (`src/days/feather/FeatherMorphology.ts`)**
   - **Level 0 — Rachis (Central Shaft, `32` Cosserat/Bishop-frame nodes):** Gently curved tapered keratin shaft rising from the lower-right/center below the frame into the soft-focus lower plume core. Every barb's root position and Bishop basis $(\mathbf{T}_0, \mathbf{N}_0, \mathbf{B}_0)$ are rigidly transformed by its attachment socket on the deformed $C^2$ rachis spline (plus a downy basal afterfeather tuft filling the luminous lower bokeh cloud). Zero detached strands.
   - **Level 1 — Barbs / Stems (`112–128` rami, `20` physics nodes $\to$ `64` $C^2$ cubic B-spline render segments):** Bilateral/helical 3D crown fanning upward-left across ~`2.5 cm` of depth (foreground blurred barbs, razor-sharp focal-plane barbs, background creamy plume). Continuous shaft taper $r_{\text{core}}(s) = r_0(1 - s)^{0.75}$ (`35 µm → 4 µm`). Evaluating smooth cubic B-splines in `vertexNode` prevents polygonal kinks at macro zoom.
   - **Level 2 — Microscopic Barbules (`~65,536` desktop / `~24,576` mobile, `4` arc-length-preserving curved segments = `8` tris each):** Single instanced draw (`~524k` tris). Branch bilaterally along $s \in [0.03, 0.99]$ at acute forward angles ($\theta_b \in [22^\circ, 42^\circ]$) with 3D plumulaceous dihedral V-splay ($\beta \in \pm[12^\circ, 32^\circ]$), subtle rest droop, seeded length/angle jitter, tip micro-affinity clumping, and pointed lance-tip taper.
   - **Shared Barbule Envelope Profile $R_{\text{env}}(i, s)$:** Exact lateral reach $R_{\text{env}}(i, s) = \ell_b(i, s)\sin\bar{\theta}_b(s)\cos\bar{\beta}(s)$ (`0` at $s = 0$, swelling via $\text{smoothstep}(0, 0.15, s)(1 - s)^{0.65}$ to `~1.5–4.5 mm`, tapering to `0` at $s = 1$), shared directly with Layer 1 collision physics.

2. **Two-Layer Hierarchical GPU Compute Physics (`src/days/feather/FeatherPhysics.ts`)**
   - **Weightless Low-Reynolds Aerodynamics ($\text{Re} \ll 1$):** Microgram keratin mass vs porous barbule Stokes paddle. Gravity is ~95% balanced by intrinsic keratin rest curvature so the plume floats effortlessly rather than swinging like heavy pendulums. Relative velocity $(\mathbf{v} - \mathbf{u}_{\text{air}})$ splits into shaft-normal ($\gamma_\perp(s) \propto R_{\text{env}}(s) \in [8, 35]\,\text{s}^{-1}$) and tangential ($\gamma_\parallel \approx 0.15\,\gamma_\perp$) components integrated via **exact unconditional exponential decay** $\mathbf{v}_\perp^{+} = \mathbf{u}_{\text{air},\perp} + (\mathbf{v}_\perp - \mathbf{u}_{\text{air},\perp})e^{-\gamma_\perp\Delta t}$ (`2–3` substeps/frame, `dt = 1/180 s`).
   - **3-Scale Divergence-Free 4D Curl-Noise Air Field ($\nabla \times \boldsymbol{\Psi}(\mathbf{x}, t)$):** Time-periodic over `timeline.duration` for seamless looping: (1) slow room breath (`~12 cm` scale), (2) gently rising thermal eddies (`~2.5 cm`, `+3 mm/s`), (3) fine micro-shear (`~0.6 cm`) driving barbule ripples.
   - **Layer 0 + 1 (`stepStemsCompute`) — Rachis & Stems with Two-Way Coupling & Variable Envelope Collisions:**
     - **Two-Way Rachis–Barb Coupling:** Net aerodynamic and gesture forces across all barbs integrate back as bending + axial torsion moments onto the shared rachis rod. Any breeze or gesture on one side subtly rocks/twists the rachis (`~0.3°–1.8°`), moving all barb roots in locked common-fate phase before length-dependent whip waves propagate base-to-tip.
     - **XPBD Inextensible Rod + Graded Compliance:** Exact segment length preservation; bending compliance increases smoothly from stiff base to supple tip.
     - **Variable Envelope Stem–Stem Collisions:** Tiled across the ~`2,400` stem nodes in workgroup shared memory (`< 0.15 ms`). For stem separation $d < R_{\text{env},A} + R_{\text{env},B}$ (excluding shared-rachis root zone $s < 0.08$), penetration $u = 1 - d/(R_A + R_B)$ applies **nonlinear spongy steric XPBD compliance** $\tilde{\alpha}_{\text{env}}(u) = \alpha_0 / \max(u, 0.05)$ plus radial/tangential viscous-velcro damping (cushioned downy contact without rubbery bounce), backed by a stiff inner shaft-core constraint ($d < r_{\text{core},A} + r_{\text{core},B}$). Writes temporally smoothed **envelope contact compression $\mathbf{c}_{i,j}$** (`vec4`) per stem node.
     - **Calm contacts (fix for core jitter):** the core is crowded by design: in the rest pose 75% of collision nodes overlap other envelopes (median 3 neighbors, up to 19, up to 98% deep). Pushing that apart every substep while the elastic pull restored it, with each push kept as velocity, made the core jitter. Now:
       - **Rest-relative contact radius** $R = \min(R_A + R_B,\ \text{mix}(R_A + R_B,\ d_{\text{rest}},\ \texttt{restOverlap}))$, with $d_{\text{rest}}$ measured between rest-pose stations (a second shared-memory array; the two fill the `16 KB` workgroup limit exactly). At `restOverlap = 1` the rest pose is contact-free and envelopes resist only being pressed closer.
       - **Spongy push** $(R - d)\,u\,\texttt{contactStiffness}$: zero at first touch. The neighbors' pushes are summed, then capped at the largest single push.
       - **Position-based velocity:** $\mathbf{v} = (\mathbf{p}_{\text{end}} - \mathbf{p}_{\text{start}})/\Delta t$, except that only `contactBounce` of a collision push becomes velocity. Velcro damping $e^{-\texttt{contactDamping}\,u\,\Delta t}$ and structural damping $e^{-\texttt{stemDamping}\,\Delta t}$ act on velocity relative to the barb's rachis socket, so the feather's common motion is untouched. The acceleration the barbules whip from is low-passed (`~25 ms`).
       - Measured at `air 0.85`, stepping 60 fps: p99 stem jitter 5.1× lower, barbule jitter 5.3× lower. With no air the settled feather is still (second difference `3e-7 cm`) instead of creeping `~1 mm / 2 s`.
   - **Layer 2 (`stepBarbulesCompute`) — Wavelike Microscopic Hair Dynamics & Shared-Memory Collisions:**
     - `128` contiguous barbules along one barb vane per workgroup (`~512` workgroups, `< 0.2 ms`). Each barbule integrates **2 coupled Euler–Bernoulli cantilever modes** $(\mathbf{q}_1, \mathbf{q}_2 \in \mathbb{R}^2)$ in its moving stem Bishop frame, reconstructed in `vertexNode` via unit-tangent quadrature so barbule length $\ell_k$ never stretches.
     - Driven by: (1) d'Alembert inertial whip from parent stem acceleration, (2) fine curl-noise air velocity + spatial phase lag creating emergent **metachronal/cilia-like traveling waves** gliding up the vane, (3) direct pointer air-wake & ray brush deflection, (4) **Layer 1 envelope contact deflection $\mathbf{c}_i(s_k)$** (visibly flattening/parting barbules on the compressed side when two barb envelopes press together), and (5) **workgroup shared-memory neighbor steric ordering** (`q1[lid ± 1]`) preventing adjacent barbules from slicing through neighbors and propagating subtle hair-to-hair domino waves at zero global-VRAM cost.
   - **Interactive Viewport Gestures (`GestureListener` via `DrawnViewport.inputRouter`):**
     - Router `Behavior` (`priority: BehaviorPriority.navigation - 10`, below free-view orbit navigation, active in `#Fullscreen` / `#Active` and hover in 3D views) projects pointer position + velocity into a 3D focal-plane air-wake jet and soft steric brush capsule, requesting redraws while impulse decays even when timeline playback is paused.

3. **State-of-the-Art Photorealistic Fiber Rendering (`FeatherMaterial.ts` + `FeatherVolume.ts`)**
   - **Marschner / Chiang Dielectric $\beta$-Keratin Fiber BSDF (`Fn` layout):**
     - Refractive index $\eta = 1.55$, near-zero melanin absorption $\sigma_a = [0.004, 0.003, 0.002]\,\text{mm}^{-1}$. Reconstructs curved 3D cylindrical cross-section normals across ribbon $v \in [-1, 1]$ (analytically pre-integrating azimuth as pixel width approaches sub-pixel scale).
     - Evaluates longitudinal/azimuthal **$R$** (primary cuticle specular glint, scale tilt $\alpha_R = -2.5^\circ$), **$TT$** (strong forward backlit transmission lobe from the upper-right studio softbox—why backlit white barbules glow against the slate backdrop), and **$TRT$** lobes, plus **medullary pith scattering** (`medulla` high in aerated rachis/barb cores, near-zero in solid keratin barbules) and subtle *nodalia* micro-glints along barbules.
   - **3D Plumage Density & Dual-Scattering Volume (`Storage3DTexture`, `96 × 64 × 64` `HalfFloatType`, `generateMipmaps = false`):**
     - Per-frame compute deposits stem + analytical barbule-envelope extinction into the tight feather bounds and sweeps optical depth $\tau_{\text{key}}$ along the upper-right key light plus local ambient visibility $V_{\text{amb}}$.
     - Single hardware trilinear `texture3D` sample per vertex/fragment evaluates Beer–Lambert + dual-scattering forward glow $T_{\text{dual}}(\tau)$, yielding the exact pillowy `#bfcde3`–`#f4f7fc` multi-scattered snowy core and `#839cbc` cool cerulean-slate inner shadows with zero shadow-map acne or hair aliasing.
   - **Energy-Conserving Sub-Pixel Ribbon AA & GPU Bitonic Back-to-Front Sort:**
     - Clamps screen-space ribbon width to $w_{\min} = 1.35\,\text{px}$ and scales premultiplied coverage by $(w_{\text{proj}} / w_{\text{clamped}})$ with a cylindrical-to-tent kernel transition so `4 µm` (`< 0.2 px`) barbule tips never alias, dash, or shimmer.
     - 1-workgroup GPU **bitonic sort** (`128` barb centroids along view $-Z$, zero CPU readback) orders `BarbMesh` and `BarbuleMesh` back-to-front every draw (`OneFactor, OneMinusSrcAlphaFactor`).

4. **Studio Backdrop, Static Camera & Dual-Mode Depth of Field (`MacroDepthOfField.ts` + `Capture.ts`)**
   - **Calibrated Reference Backdrop:** Distant curved studio cyclorama using inverse-tonemapped linear radiance (`AgXToneMapping` + blue-noise dither) to hit the exact measured reference sRGB gradient (`#46658f` lower-left, `#4b6993` upper-left, `#4c6c93` top-center, elliptical `#85a0c2` upper-right key-light glow), staying parallax-consistent under aperture shifts.
   - **Camera (`cameraMode: 'Macro' | 'Full Feather'`, default `'Macro'`):** Macro framing (`fov ≈ 20°`, `focusDistance`, `aperture`); `'Full Feather'` reveals the entire connected plume from quill to tip.
   - **Camera rig (`CameraRig`):** the camera hangs from a pivot at the pose's target, the point it looks at (Macro: `(0.42, -0.18, 0)`, the crown, 4.6 mm from the world origin), so the framed feather stays centered and in focus. The rig turns about the vertical `orbitTurns` times per loop (default 4, one turn per ~56 s). It carries the studio: the backdrop sphere (child of the rig; its gradient is computed in its own space) and the key and fill light directions (the uniforms, plus the volume's key direction, turned each frame). So the calibrated reference look holds from every side, and the feather turns in the studio light as on a turntable, while the air and gravity stay in the world. In `Macro` the rig also cranes up and down on a cosine, `craneCycles` times per loop (default 2): from `craneTop = 1` (eye level with the crown's tips, which then reach mid-frame; a loop starts and ends here, under the white fades) down to `craneBottom = -3.5` (the shaft and lower barbs). At −3.5 the quill's end at y = −5.45 stays ≥ 0.8 cm below the frame at every orbit angle: the worst depth is 5.65 + 1.6 cm, which shows ±1.15 cm. Defaults are the user's (they doubled `orbitTurns` to 4). With 4 turns and 2 swings, the bottom always comes with the front view (0°). At the bottom the shaft sits ~0.9 cm off the turn axis (x ≈ 1.28 vs 0.42), so it swings across the frame and through focus as the rig turns.
   - **Soundtrack & timeline:** `BreathOfTheStillness.mp3` (224 s) plays with the timeline, which takes its length (`src/Soundtrack.ts`, shared with Fold). `TimelineFade` (`src/TimelineFade.ts`, shared) fades in from white and out to white over 5 s. Under neutral tone mapping it crossfades in display space: tone-map, mix toward the color, then exact inverse PBR Neutral, capped at 0.998 since 1 maps from infinity. That brightens evenly; a linear-light mix toward white would blow out within the first second. Fold keeps its linear-light fade to black. The air's phase runs a whole number of ~32 s cycles per loop (7 for the track), so the air keeps its tuned pace and the loop stays seamless.
   - **Real-Time Physical `MacroDepthOfField` `Effect`:** Custom TSL `post` effect (avoiding stock `DepthOfFieldNode`'s unweighted far-bleed and `max()` blocky dilation). Computes exact thin-lens pixel CoC $\text{CoC}_{\text{px}}(z) = \frac{r_a H_{\text{px}}}{2\tan(\text{fov}_y/2)}\frac{z - d_f}{z\cdot d_f}$ from the same `(focusDistance, aperture)` properties used in capture; pairs a focal-biased filament depth-anchor pre-pass with CoC-weighted Vogel-disc far gather and smooth dilated near-field veil, followed by subtle high-threshold optical `Bloom`.
   - **Capture (`Capture.ts`, `capture()` from the console; 2026-11-12):** the simulation can't be scrubbed, so the capture plays the timeline forward only, and the subframes go to the lens, not the shutter.
     - **Defaults** (`getCaptureDefaults`; the options given override them): `samples: 64, shutter: 0, settle: 0, preroll: 10`. No motion blur (the motion is slow), nothing to settle (no GI).
     - **Simulation:** a capture restarts the physics from rest (morphology rebuilt, warm-up) and clears touch. `preroll` plays the loop's last 10 s first, each frame drawn once and not saved, so frame 0 follows the last frame in motion. While capturing, the physics steps in fixed `1/120 s` steps (2 substeps, as at 120 Hz), each in the air of its own time, carrying the remainder. A frame's lens samples, drawn at one time, see one simulation. The same capture gives byte-identical PNGs, across sessions too.
     - **Lens:** each subframe moves the camera to its point of a 9-blade iris (roundness 0.65) on a Vogel spiral (`irisSample`: equal areas, nearest neighbors 0.6–1.4× a hexagonal packing's spacing), in golden-stride order so that time and lens radius never go together under an open shutter. `setThinLensViewOffset` holds the plane in focus to 1e-3 px in a picture of another aspect than the camera's (io's view fits the frame inside; three's `setViewOffset` would set the camera's aspect to the picture's). Halton (2, 3) jitter anti-aliases. The real-time DoF stands aside (bypassed: switching it off rebuilds the view's graph), its depth anchors hidden.
     - **Fill:** barbules are about as long as their defocus, so their 64 copies scatter in 2D and showed as fine hatching more than ~1 cm from focus. Each sample stands for an equal part of the aperture, of diameter $2r/\sqrt{N}$. The fiber shader draws each fiber at least as wide as that part of the lens blurs it, $w = \texttt{lensSpread}\,|z - d_f|/d_f$ at the fiber's own pixel scale, energy-conserving like the `1.35 px` clamp, and zero at focus. 64 samples with it match or beat 256 without, at the same brightness and as crisp in focus; 32 hold up. Tried first: the real-time DoF as a residual blur of $r/\sqrt{N}$ per sample. It softened barbs near focus (its half-res gather blurs ≥ ~3 px once the CoC passes 0.55 px) and dimmed the bright haze. Widening by the copies' 1D spacing $2r/N$ (right for long fibers) was 8× too little.
     - **HDR:** the subframes add up in 32-bit float (ping-pong targets read texel by texel; in half floats 1/N steps round away unevenly). Saved as half-float EXR (linear, before tone mapping) and/or PNG.
     - **Cost:** one subframe per animation frame (three advances the node frame, which its scene pass renders once per, only in its own rAF loop). Headless at 60 Hz: 17 ms a subframe, a 64-sample 4K frame 1.1 s, the 224 s loop (6,722 frames) ~2 h; 256 samples 4.4 s a frame. A 120 Hz display may halve that if the GPU keeps up.
     - The lens is softer than the real-time view, whose DoF keeps thin hairs crisp (closest-depth and min-CoC protection); a real lens doesn't.

### Todo Breakdown

- [x] **1. Plan & Design (`feather-plan`):** Document connected morphology, 2-layer envelope/wave GPU physics, keratin fiber BSDF + 3D dual-scattering volume, and real-time + multi-sampled capture DoF in `Codevember.plan.md`.
- [x] **2. Connected Morphology, Camera & Studio Backdrop (`feather-morphology-backdrop`):** Build rachis + `C^2` B-spline barbs + `~32k` instanced 3D plumulaceous barbules with shared $R_{\text{env}}(s)$, static `Macro` / `Full Feather` cameras, and calibrated `#46658f → #85a0c2` backdrop.
- [x] **3. Layer 0/1 Stem & Envelope GPU Physics (`feather-physics-stems`):** Implement `stemsStepCompute` (rachis + barb XPBD/Cosserat rods, 2-way rachis root torque, unconditional exponential Stokes drag, 3-scale curl-noise air, variable-envelope soft steric collisions + contact compression buffer).
- [x] **4. Layer 2 Barbule Wave Physics & Viewport Gestures (`feather-physics-barbules-gestures`):** Implement `barbulesStepCompute` (2-mode cantilever dynamics, traveling air-shear waves, stem envelope compression deflection, workgroup shared-memory neighbor steric collisions) + `InputRouter` gesture wake/brush.
- [x] **5. Keratin Fiber BSDF, 3D Dual-Scattering Volume & Sorting (`feather-keratin-bsdf-volume`):** Implement Marschner/Chiang $R/TT/TRT$ + medullary pith shader, `64×48×40` `HalfFloat` 3D optical-depth volume, energy-conserving `1.35 px` sub-pixel ribbon clamping, and 1-workgroup GPU parallel back-to-front barb sort.
- [x] **6. Real-Time `MacroDepthOfField` & Multi-Sampled Capture DoF (`feather-dof-capture`):** Build custom CoC-weighted `MacroDepthOfField` `Effect` and extend `Capture.ts` with off-axis thin-lens aperture sampling + automatic post-DoF bypass.
- [x] **7. Verification & Polish (`feather-verify`):** Add unit tests (lens shear math, envelope profile, inverse NeutralToneMapping), verify visuals in headless WebGPU Chromium (real-time + multi-sampled capture) against the reference image, and pass `typecheck`, `lint:check`, `test`, and `build`.

## 13. Labyrinth

## 14. Tension

## 15. Mirage

## 16. Spore

## 17. Kelp

## 18. Pendulum

## 19. Erosion

## 20. Cocoon

## 21. Bolt

## 22. Echo

## 23. Magma

## 24. Nest

## 25. Veil

## 26. Anamorph

## 27. Burrow

## 28. Hive

## 29. Portal

## 30. Dissolve
