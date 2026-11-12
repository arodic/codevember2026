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

## 8. Tesseract

## 9. Membrane

## 10. Caustic

## 11. Rust

## 12. Feather

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
