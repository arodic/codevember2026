# Current Focus

**2026-11-13 Day 7 Hollow — per-light bake isolation:**
- Rebake clears probe atlas (dispose+recreate) + env maps before direct pass.
- Zero-intensity lights hidden (bake + runtime). Fire point still off during bake.
- Residual cyan killed: rock rim emissive off, bg black, sky portal/shafts/rimstone glint gated by `skyEmitter`.
- Workflow: zero all → rebake → black; solo one light → rebake → see that light’s contribution.
