# Codevember 2026

Procedural WebGPU / TSL sketches for Codevember 2026, following thespite's prompt list, built with [Io-Gui](https://iogui.dev) and [three.js](https://threejs.org). Each day is an io-gui `Document` hosted by `IoCodevember`: a fullscreen 2.39:1 view with the timeline under it, or the editor layout (`Escape`).

Day 1, **Fold**: a real-time procedural diorama of an arid fold-and-thrust belt under a 24-hour sky with the Milky Way, scored by `CanyonHum.mp3`.

## Commands

```sh
pnpm install
pnpm dev          # dev server on :3000 (also on the LAN)
pnpm build        # typecheck + minified bundle in dist/
pnpm preview      # serve dist/ locally
pnpm test         # unit tests in headless Chromium
pnpm lint         # eslint --fix (lint:check to only check)
```

## Deploying

Upload `dist/` as static files. Its URLs are relative, so it works from any path. The page needs WebGPU, which browsers only offer on HTTPS or localhost. It loads nothing from other servers: the bundle, the lazily loaded day chunks and the soundtrack are all in `dist/`.

`#codevember=Fold` in the URL selects the day.

## Layout

```
index.html            page shell, icons in public/images/
src/main.ts           mounts IoCodevember
src/IoCodevember.ts   host: day menu, layouts, fullscreen, playback
src/days/<Day>.ts     one Document per day, loaded on demand
src/days/fold/        Fold's terrain, sky, stars, meteors, effects, soundtrack
Codevember.plan.md    design notes and per-day plans
```

## Dependencies

- **three** `0.187.0` from npm.
- **io-gui** `2.0.0-alpha.5`, linked from a local checkout at `../Projects/io/packages/*`. That version is not on npm (the latest there is alpha.4). The links are local only: do not pack these packages into the repo or push them. After changing io, rebuild it there (`pnpm bundle`); dev and build follow that `dist/`. The minified app in `dist/` is the only io-gui this project ships. Once alpha.5 is published, depend on `^2.0.0-alpha.5` from the registry.
