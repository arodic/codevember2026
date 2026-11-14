# Current Focus

**2026-11-14 Day 7 Hollow — one sculpted surface (main checkout, uncommitted):**
- Cave + boulders + dripstones + draperies = one SDF (`HollowSculpt`): smooth unions = fillets, same weights blend `aZone` + `aSheet`; one mesh, rock + calcite groups. Octree DC (`HollowOctree`, finest 1.25 cm, corner-based split: crossed / range / sagitta), relaxation, bend-aware diagonals. 55 slabs on workers ~9.5 s (budget 30 s). ~910k verts. GI voxelizer gets a 6 cm clustered proxy (128 MB binding limit).
- Indirect light per vertex (`HollowVertexLight`).
- Next (open): light levels / exposure (user: later), mist extinction; cache default seed's mesh (user: later); hero boulder facets.

**2026-11-14 Day 7 Hollow — material in the cave, specimen sculpting (main checkout, uncommitted):**
- User greenlit `applyHollowSurface`: now Hollow's rock + calcite; Surface dials; `display` Shaded / Layers. User raised `HOLLOW_SURFACE_MEAN_ALBEDO` to 0.6/0.48/0.34 (GI bounce; keep).
- Bodies: `stalactite` (4 forms, clusters), `stalagmite` (plates, 4 forms), `flowstone` (traced lobes), drapery, rock. Rimstone dam: metric crest, proud lip, microgours, front into the lake; cascade terraces lipped + dished. ~1.13M verts, ~8 s.
- Perf: ~23 fps headless seed 1056 (was 1.3): fewer noises, low freqs per vertex, gated noise, static fire shadow.
- Stalactites: carrot (cone, flared root), short straws (≤ 30 cm), icicles; no `stem`. Shot: same start, end at 5× dolly / 3× truck / 5× pan (`*_REACH` in Hollow).
- Next: user review; fire → spot light (user idea, plan 5g); flowstone on ramps still reads a bit ribbon-like; crust patches on lit ceilings; `viewClearance` doesn't know the longer shot.

**2026-11-14 Day 11 Rust — volumetric material (other session than Hollow):**
- Volume 512²×64 (1.25 µm, reduced for now); quasi-steady precipitation (no checkerboard/hot spots); compact growth; SEM draws a smooth density (botryoidal crust, rosettes); plan § 11 Update (2026-11-14).
- Next: volume ceiling by 10 d; drops/NaCl in image; drying cracks.

