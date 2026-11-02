# Stats

A small home-screen web app that reads a private GitHub repo with a read-only token and shows daily stats as cards. The app holds no data: everything is fetched on the device at runtime, and the token never leaves the device.

The data repo needs a `stats.json` at its root (file paths, goals, time zone). Install: open the GitHub Pages URL in Chrome → ⋮ → Add to Home screen.

## Credits
Body outline polygons (muscle icons + muscle heatmap, `body.js`) come from [react-body-highlighter](https://github.com/GV79/react-body-highlighter) by GV79, MIT License, Copyright (c) 2020 GV79. Coordinates rounded; the full license notice is at the top of `body.js`.
