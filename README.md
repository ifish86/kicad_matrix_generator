# KiCad Matrix Generator

A [Quasar](https://quasar.dev/) (Vue 3 + Vite) web application that generates complete, self-contained **KiCad 8** projects for keyboard-style boards built from a matrix of tactile switches and/or WS2812 addressable RGB LEDs.

The company logo (`assets/logo/logo.png`) is shown in the app header.

## Features

- **Board types** — switches only, WS2812B LEDs only, or hybrid (switches with a per-key LED).
- **Footprint selection** — choose from the bundled tactile switch and WS2812B footprints (PTS636, PTS647, PTS815, B3U-1000P, TL3342, 6×6 mm, WS2812B 5050 / narrow / 2020 / 1615 / 3535).
- **Real schematic symbols** — switch and WS2812 symbols are taken verbatim from the bundled library `assets/kicad_matrix.kicad_sym`, including each LED variant's own pad numbering.
- **Configurable layout** — rows × columns, key pitch, LED pitch/offset, diode offset, board margin and board thickness.
- **Live preview** — a real-time SVG preview of the board layout.
- **One-click download** — generates a ZIP containing a complete, openable KiCad project.

### Generated project contents

| File | Description |
| --- | --- |
| `<name>.kicad_pro` | KiCad project file (open this) |
| `<name>.kicad_sch` | Schematic: switch matrix + per-key diode, WS2812B chain, controller block, power flags, title block |
| `<name>.kicad_pcb` | Board: footprints placed, nets assigned, board outline drawn |
| `<name>.kicad_sym` | Symbol library (the symbols this board actually uses) |
| `<name>.pretty/` | Footprint library (bundled footprints + generated SOD-123 diode) |
| `sym-lib-table`, `fp-lib-table` | Project library tables — how KiCad resolves the `lib_id`s above |
| `Libraries/` | 3D models referenced by the footprints |
| `README.md` | Notes for the generated project |

The switch matrix uses the standard row/column topology (series diode per key to prevent ghosting), and the WS2812B data line is chained in serpentine order (`DATA_IN` → `DATA_OUT`).

### Schematic symbols

`assets/kicad_matrix.kicad_sym` is the source of truth for the switch and WS2812 symbols. The generator copies the symbol for the selected footprint into the project unchanged, and reads its **pin coordinates** to place the wiring — so editing a symbol in the KiCad symbol editor moves the wires with it rather than disconnecting them. The pad numbering of each WS2812 variant (`1-VDD/2-DOUT/3-GND/4-DIN` on the 5050, plain `1`–`4` in a different order on the 2020/1615/3535) comes from the symbol too, and is used for both the schematic and the board.

Three symbols have no counterpart in that library and are drawn by the generator: the matrix isolation diode (`D_Matrix`), the controller placeholder (`MCU`) and the ERC power flag (`PWR_FLAG`).

Schematic coordinates are millimetres on a 1.27 mm grid — the sheet size is chosen by laying the drawing out against each standard size in turn and taking the first that fits. A matrix too large for KiCad's 1200 mm maximum sheet is reported as an error rather than drawn off the page; roughly 640 LEDs, or 200 keys plus LEDs, fit on one sheet.

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
├── assets/                 # Company logo + bundled KiCad symbols, footprints & 3D models
│   ├── kicad_matrix.kicad_sym  # Schematic symbol library (switches + WS2812 variants)
│   ├── kicad_footprints/   # .kicad_mod footprint files
│   ├── kicad_models/       # STEP/STP 3D models
│   └── logo/               # Company logo
├── scripts/                # Node validation + schematic preview scripts
├── src/
│   ├── components/         # BoardPreview, FilesPreview
│   ├── kicad/              # KiCad generation core (sexpr, symbols, generator, zip)
│   └── pages/              # Main UI page
├── index.html
├── package.json
└── vite.config.js
```

## Development

Validate the generator (geometry, connectivity, netlist consistency and sheet fit across every footprint pairing and a range of matrix sizes):

```bash
npm test
```

Render a generated schematic to SVG to look at it without opening KiCad:

```bash
npm run render-sch tmp_test/hybrid/test_board.kicad_sch
```

## License

The bundled KiCad footprints and 3D models retain their original licensing.
