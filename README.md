# KiCad Matrix Generator

A [Quasar](https://quasar.dev/) (Vue 3 + Vite) web application that generates complete, self-contained **KiCad 8** projects for keyboard-style boards built from a matrix of tactile switches and/or WS2812 addressable RGB LEDs.

The company logo (`assets/logo/logo.png`) is shown in the app header.

## Features

- **Board types** — switches only, WS2812B LEDs only, or hybrid (switches with a per-key LED).
- **Footprint selection** — choose from the bundled tactile switch and WS2812B footprints (PTS636, PTS647, PTS815, B3U-1000P, TL3342, 6×6 mm, WS2812B 5050 / narrow / 2020 / 1615 / 3535).
- **Configurable layout** — rows × columns, key pitch, LED pitch/offset, diode offset, board margin and board thickness.
- **Live preview** — a real-time SVG preview of the board layout.
- **One-click download** — generates a ZIP containing a complete, openable KiCad project.

### Generated project contents

| File | Description |
| --- | --- |
| `<name>.kicad_pro` | KiCad project file (open this) |
| `<name>.kicad_sch` | Schematic: switch matrix + per-key diode, WS2812B chain, controller block, power flags, title block |
| `<name>.kicad_pcb` | Board: footprints placed, nets assigned, board outline drawn |
| `<name>.kicad_sym` | Symbol library |
| `<name>.pretty/` | Footprint library (bundled footprints + generated SOD-123 diode) |
| `Libraries/` | 3D models referenced by the footprints |
| `README.md` | Notes for the generated project |

The switch matrix uses the standard row/column topology (series diode per key to prevent ghosting), and the WS2812B data line is chained in serpentine order (`DATA_IN` → `DATA_OUT`).

## Installation requirements

- [Node.js](https://nodejs.org/) 18 or newer (Node 20+ recommended)
- npm (bundled with Node.js)
- A modern web browser
- [KiCad](https://www.kicad.org/) 8 or newer to open the generated files

## Installation

```bash
git clone git@github.com:ifish86/kicad_matrix_generator.git
cd kicad_matrix_generator
npm install
```

## Running the app

Start the development server:

```bash
npm run dev
```

Then open the printed URL (default <http://localhost:5173/>).

Production build and preview:

```bash
npm run build
npm run preview
```

## How to use

1. Fill in **Board configuration** on the left: project name, board type, rows/columns, switch/LED footprint, pitches, margin and thickness.
2. Review the **Layout preview**.
3. Click **Generate & Download** to produce `<name>.zip`.
4. Extract the ZIP and open `<name>.kicad_pro` in KiCad 8.

> **Note:** the switch matrix nets (`ROW*` / `COL*`) are assigned but intentionally left unrouted in the board, ready for interactive or manual routing.

## Project structure

```
.
├── assets/                 # Company logo + bundled KiCad footprints & 3D models
│   ├── kicad_footprints/   # .kicad_mod footprint files
│   ├── kicad_models/       # STEP/STP 3D models
│   └── logo/               # Company logo
├── scripts/                # Node validation script for the generator
├── src/
│   ├── components/         # BoardPreview, FilesPreview
│   ├── kicad/              # KiCad generation core (sexpr, symbols, generator, zip)
│   └── pages/              # Main UI page
├── index.html
├── package.json
└── vite.config.js
```

## License

The bundled KiCad footprints and 3D models retain their original licensing.
