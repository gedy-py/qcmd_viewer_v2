# QCM-D Viewer v2

Client-side QCM-D data analysis tool. Runs entirely in the browser — no server, no installation, data never leaves your machine.

## Features

- **File validation**: metadata display + quick-look chart with all harmonics
- **Time Series analysis**: interactive chart with harmonics selection, time window, smoothing, Δf/n normalization
- **Interactive markers**: click-to-place vertical markers, auto-named A/B/C, unlimited count
- **Step table**: automatic Δf/ΔD computation between markers, editable step names, custom cross-step deltas
- **ΔD vs Δf plot**: parametric plot colored by step, independent controls
- **Visual editor**: title, axis labels/limits, line width, font size, legend position
- **Export**: figures (PNG/SVG), step table (CSV/PNG)

## Deployment

### GitHub Pages
1. Push this folder to a GitHub repository
2. Go to Settings → Pages → Source: main branch
3. Your app is live at `https://username.github.io/repo-name/`

### Local use
Simply open `index.html` in any modern browser. Works offline (after initial CDN load).

## File format

Supports CSV (tab-separated, comma decimal) and XLSX files from QCM-D instruments. Expected columns: time column + frequency harmonics (`f3 [Hz]`, `f5 [Hz]`, ...) + dissipation harmonics (`D3 [ppm]`, `D5 [ppm]`, ...).
