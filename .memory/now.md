# Current Focus

**2026-11-14 Day 7 Hollow — one sculpted surface (main checkout, uncommitted):**
- Cave + boulders + dripstones + draperies = one SDF (`HollowSculpt`): smooth unions = fillets, same weights blend `aZone` + `aSheet`; one mesh, rock + calcite groups. Octree DC (`HollowOctree`, finest 1.25 cm, corner-based split: crossed / range / sagitta), relaxation, bend-aware diagonals. 55 slabs on workers ~9.5 s (budget 30 s). ~910k verts. GI voxelizer gets a 6 cm clustered proxy (128 MB binding limit).
- Indirect light per vertex (`HollowVertexLight`).
- Next (open): light levels / exposure (user: later), mist extinction; cache default seed's mesh (user: later); hero boulder facets.

**2026-11-14 Day 7 Hollow — material prototype (main checkout, uncommitted):**
- New doc `HollowMaterials` (menu: HollowMaterials): 7 SDF specimens (`HollowSpecimens`, meshed on workers ~1.5 s) + 5 swatches + mud floor; lighting Headlamp / Lantern / Skylight / Show Cave / Raking / Studio; subject, Layers view, orbit, zoom; dials wetness / iron / sediment / crust / relief.
- Material `applyHollowSurface` (`HollowSurface.ts`): one PBR surface from world pos + normal + aZone/aOcclusion/aSheet; layers bedrock → stains → crust → calcite → rimstone → sediment → water (clearcoat). NOT in Hollow until user greenlights (user rule).
- Next: user review; then swap into Hollow (HollowLitMaterial + calciteTransmission), measure shader cost there.

**2026-11-14 Day 11 Rust — volumetric material (other session than Hollow):**
- Volume 512²×64 (1.25 µm, reduced for now); quasi-steady precipitation (no checkerboard/hot spots); compact growth; SEM draws a smooth density (botryoidal crust, rosettes); plan § 11 Update (2026-11-14).
- Next: volume ceiling by 10 d; drops/NaCl in image; drying cracks.

