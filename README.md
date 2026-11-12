# Stats

A small home-screen web app that reads a private GitHub repo with a read-only token and shows daily stats as cards. The app holds no data: everything is fetched on the device at runtime, and the token never leaves the device.

The data repo needs a `stats.json` at its root (file paths, goals, time zone). Install: open the GitHub Pages URL in Chrome → ⋮ → Add to Home screen.

## Credits
Body outline polygons (muscle icons + muscle heatmap, `body.js`) come from [react-body-highlighter](https://github.com/GV79/react-body-highlighter) by GV79, MIT License, Copyright (c) 2020 GV79. Coordinates rounded; the full license notice is at the top of `body.js`.

The **Graph** tab draws the data repo's concept notes (`<graphRoot>/*/graph/**/*.md`) as one zoomable graph. Layout uses [d3-force](https://github.com/d3/d3-force) v3 with d3-dispatch, d3-quadtree and d3-timer (`vendor/d3-force.min.js`, ISC License, Copyright 2010-2021 Mike Bostock); the canvas renderer is this repo's own code.

Versions: the main address is the current app (v2 since 2026-11-12). `v1/` keeps the previous version as a fallback (same login); `v2/` only redirects to the main address.
