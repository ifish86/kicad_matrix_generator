// KiCad project generator.
//
// Produces a complete, self-contained KiCad 8 project for a matrix of switches
// and/or WS2812B addressable RGB LEDs:
//   <name>.kicad_pro   – project settings + library wiring
//   <name>.kicad_sch   – schematic (fully connected, annotated)
//   <name>.kicad_pcb   – board (footprints placed, nets assigned, outline drawn)
//   <name>.kicad_sym   – symbol library
//   <name>.pretty/     – footprint library (copies of provided footprints)
//   Libraries/         – 3D models referenced by the footprints
//   README.md          – usage notes

import { parse, serialize, list, str, atom, op, children, child, walk, clone } from './sexpr.js'
import { uuid } from './uuid.js'
import {
  SWITCH_SYMBOL_FOR,
  LED_SYMBOL_FOR,
  libSymbol,
  symbolPins,
  symbolBounds,
  symbolProperty,
  setSymbolFootprint,
  renameSymbol,
  ledPinNumbers,
  makeDiodeSymbol,
  makeControllerSymbol,
  makePowerFlagSymbol,
  controllerPinNumbers
} from './symbols.js'

// ---------------------------------------------------------------------------
// Helpers

const r4 = (v) => Math.round(v * 10000) / 10000
const mm = (v) => String(r4(v))

export function sanitizeName(name) {
  const s = String(name || 'matrix_board')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'matrix_board'
}

export function normalizeConfig(input = {}) {
  const c = { ...input }
  c.name = sanitizeName(c.name || 'matrix_board')
  c.type = ['switches', 'leds', 'hybrid'].includes(c.type) ? c.type : 'hybrid'
  c.rows = clampInt(c.rows, 1, 32, 4)
  c.cols = clampInt(c.cols, 1, 40, 5)
  c.switchFootprint = c.switchFootprint || 'SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS'
  c.ledFootprint = c.ledFootprint || 'WS2812B_5050'
  c.keyPitch = clampNum(c.keyPitch, 5, 100, 19.05)
  c.ledPitch = clampNum(c.ledPitch, 3, 100, 19.05)
  c.ledOffset = clampNum(c.ledOffset, 1, 50, 5.08)
  c.diodeOffset = clampNum(c.diodeOffset, 2, 50, 6.35)
  c.margin = clampNum(c.margin, 1, 50, 5)
  c.thickness = clampNum(c.thickness, 0.4, 6, 1.6)
  c.silkText = (c.silkText || c.name).trim() || c.name
  c.hasSwitches = c.type === 'switches' || c.type === 'hybrid'
  c.hasLeds = c.type === 'leds' || c.type === 'hybrid'
  return c
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, n))
}
function clampNum(v, min, max, dflt) {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

// ---------------------------------------------------------------------------
// Net naming

function dataNetName(k, total) {
  if (k === 0) return 'DATA_IN'
  if (k === total) return 'DATA_OUT'
  return `SD${k}`
}

function buildNets(c) {
  const names = []
  const map = {}
  const add = (name) => {
    if (!(name in map)) {
      map[name] = names.length + 1 // net 0 is reserved for ""
      names.push(name)
    }
    return map[name]
  }
  if (c.hasSwitches) {
    for (let r = 0; r < c.rows; r++) add(`ROW${r}`)
    for (let col = 0; col < c.cols; col++) add(`COL${col}`)
    for (let r = 0; r < c.rows; r++) for (let col = 0; col < c.cols; col++) add(`SW${r}_${col}`)
  }
  if (c.hasLeds) {
    add('VDD')
    add('GND')
    const n = c.rows * c.cols
    for (let k = 0; k <= n; k++) add(dataNetName(k, n))
  }
  return { names, map }
}

// ---------------------------------------------------------------------------
// Layout (millimetres, KiCad Pcbnew coordinate system: +Y up)

function switchPos(c, r, col) {
  return {
    x: (col - (c.cols - 1) / 2) * c.keyPitch,
    y: ((c.rows - 1) / 2 - r) * c.keyPitch
  }
}

function ledPos(c, r, col) {
  const s = switchPos(c, r, col)
  if (c.type === 'hybrid') return { x: s.x, y: s.y - c.ledOffset }
  return {
    x: (col - (c.cols - 1) / 2) * c.ledPitch,
    y: ((c.rows - 1) / 2 - r) * c.ledPitch
  }
}

function snakeIndex(c, r, col) {
  return r * c.cols + (r % 2 === 0 ? col : c.cols - 1 - col)
}

function diodePos(c, r, col) {
  const s = switchPos(c, r, col)
  return { x: s.x, y: s.y + c.diodeOffset }
}

/**
 * Compute component placement + board outline for previewing (and reuse by the
 * PCB builder). Returns plain data suitable for rendering.
 */
export function computeLayout(config, registry) {
  const c = normalizeConfig(config)
  const switches = []
  const leds = []
  const diodes = []
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }

  const expand = (cx, cy, pads) => {
    for (const pad of pads) {
      const hw = pad.size ? pad.size.w / 2 : 0
      const hh = pad.size ? pad.size.h / 2 : 0
      bounds.minX = Math.min(bounds.minX, cx + pad.pos.x - hw)
      bounds.maxX = Math.max(bounds.maxX, cx + pad.pos.x + hw)
      bounds.minY = Math.min(bounds.minY, cy + pad.pos.y - hh)
      bounds.maxY = Math.max(bounds.maxY, cy + pad.pos.y + hh)
    }
  }

  if (c.hasSwitches) {
    const swFp = registry[c.switchFootprint]
    const diodePads = extractPads(makeDiodeFootprint())
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const idx = r * c.cols + col + 1
        const sp = switchPos(c, r, col)
        const dp = diodePos(c, r, col)
        switches.push({ x: sp.x, y: sp.y, ref: `SW${idx}` })
        diodes.push({ x: dp.x, y: dp.y, ref: `D${idx}` })
        if (swFp) expand(sp.x, sp.y, swFp.pads)
        expand(dp.x, dp.y, diodePads)
      }
    }
  }

  if (c.hasLeds) {
    const ledFp = registry[c.ledFootprint]
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const idx = r * c.cols + col + 1
        const lp = ledPos(c, r, col)
        leds.push({ x: lp.x, y: lp.y, ref: `LED${idx}`, snake: snakeIndex(c, r, col) })
        if (ledFp) expand(lp.x, lp.y, ledFp.pads)
      }
    }
  }

  bounds.minX = r4(bounds.minX - c.margin)
  bounds.maxX = r4(bounds.maxX + c.margin)
  bounds.minY = r4(bounds.minY - c.margin)
  bounds.maxY = r4(bounds.maxY + c.margin)
  const w = r4(bounds.maxX - bounds.minX)
  const h = r4(bounds.maxY - bounds.minY)

  return { switches, leds, diodes, bounds, width: w, height: h }
}

// ---------------------------------------------------------------------------
// Static PCB sections (layers + setup) as parseable templates

const PCB_LAYERS = `(layers
	(0 "F.Cu" signal)
	(31 "B.Cu" signal)
	(32 "B.Adhes" user "B.Adhesive")
	(33 "F.Adhes" user "F.Adhesive")
	(34 "B.Paste" user)
	(35 "F.Paste" user)
	(36 "B.SilkS" user "B.Silkscreen")
	(37 "F.SilkS" user "F.Silkscreen")
	(38 "B.Mask" user)
	(39 "F.Mask" user)
	(40 "Dwgs.User" user "User.Drawings")
	(41 "Cmts.User" user "User.Comments")
	(42 "Eco1.User" user "User.Eco1")
	(43 "Eco2.User" user "User.Eco2")
	(44 "Edge.Cuts" user)
	(45 "Margin" user)
	(46 "B.CrtYd" user "B.Courtyard")
	(47 "F.CrtYd" user "F.Courtyard")
	(48 "B.Fab" user)
	(49 "F.Fab" user)
	(50 "User.1" user)
	(51 "User.2" user)
	(52 "User.3" user)
	(53 "User.4" user)
	(54 "User.5" user)
	(55 "User.6" user)
	(56 "User.7" user)
	(57 "User.8" user)
	(58 "User.9" user)
)`

const PCB_SETUP = `(setup
	(pad_to_mask_clearance 0)
	(allow_soldermask_bridges_in_footprints no)
	(pcbplotparams
		(layerselection 0x00010fc_ffffffff)
		(plot_on_all_layers_selection 0x0000000_00000000)
		(disableapertmacros no)
		(usegerberextensions no)
		(usegerberattributes yes)
		(usegerberadvancedattributes yes)
		(creategerberjobfile yes)
		(dashed_line_dash_ratio 12.000000)
		(dashed_line_gap_ratio 3.000000)
		(svgprecision 4)
		(plotframeref no)
		(viasonmask no)
		(mode 1)
		(useauxorigin no)
		(hpglpennumber 1)
		(hpglpenspeed 20)
		(hpglpendiameter 15.000000)
		(pdf_front_fp_property_popups yes)
		(pdf_back_fp_property_popups yes)
		(pdf_metadata yes)
		(pdf_single_page no)
		(pdf_multilayer_mode 1)
		(pdf_hide_dangling_tracks no)
		(pdf_custom_dashed_lines no)
		(psnegative no)
		(psa4output no)
		(drillshape 1)
		(scaleselection 1)
		(plotdirectory "")
	)
)`

// ---------------------------------------------------------------------------
// Schematic builders
//
// IMPORTANT: KiCad schematic files are in MILLIMETRES, on a 1.27 mm (50 mil)
// grid. Every coordinate below is mm. Wire endpoints are derived from the real
// pin coordinates of the symbols rather than assumed, so a symbol edit in the
// library can never silently disconnect the generated wiring.

const GRID = 1.27
const SHEET_MARGIN = 12.7
const TITLE_BLOCK_H = 38.1 // reserved strip at the bottom of the sheet
const MAX_PAGE_MM = 1200 // KiCad's maximum user page size
const LEAD = 2.54 // wire stub from a pin to a label or the next part
const LABEL_W = 11.43 // room reserved for global-label text + its flag
const TEXT_H = 2.54

const snap = (v) => Math.round(v / GRID) * GRID

/** Schematic position of a symbol pin. Library symbols use +Y up, schematics
 *  use +Y down, so the Y offset is negated. */
function pinPos(instX, instY, p) {
  return { x: r4(instX + p.x), y: r4(instY - p.y) }
}

/** Look a pin up by number; throws rather than silently misplacing a wire. */
function pinByNumber(pins, number, symbolName) {
  const found = pins.find((p) => p.number === String(number))
  if (!found) throw new Error(`Symbol ${symbolName} has no pin ${number}`)
  return found
}

function pinByName(pins, name, symbolName) {
  const found = pins.find((p) => p.name === name)
  if (!found) throw new Error(`Symbol ${symbolName} has no pin named ${name}`)
  return found
}

function instProp(key, value, x, y, opts = {}) {
  const { hide = false, justify = null, angle = 0 } = opts
  const justifyNode = justify ? list('justify', ...justify.split(' ').map((j) => atom(j))) : null
  return list(
    'property',
    str(key),
    str(value),
    list('at', atom(mm(x)), atom(mm(y)), atom(angle)),
    list(
      'effects',
      list('font', list('size', atom(1.27), atom(1.27))),
      ...(justifyNode ? [justifyNode] : []),
      ...(hide ? [list('hide', atom('yes'))] : [])
    )
  )
}

/**
 * A placed symbol. `refAt` is the Reference-text offset relative to the symbol
 * origin; Value/Footprint/Datasheet are hidden because a matrix schematic
 * repeats the same part hundreds of times (they remain in the BOM).
 */
function symbolInstance(opts) {
  const {
    lib,
    symbolName,
    ref,
    value,
    footprint,
    x,
    y,
    pinNumbers,
    rootSheet,
    projectName,
    inBom = true,
    onBoard = true,
    refAt = [0, -5.08],
    refJustify = null,
    showValue = false,
    valueAt = [0, 5.08]
  } = opts
  return list(
    'symbol',
    list('lib_id', str(`${lib}:${symbolName}`)),
    list('at', atom(mm(x)), atom(mm(y)), atom(0)),
    list('unit', atom(1)),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom(inBom ? 'yes' : 'no')),
    list('on_board', atom(onBoard ? 'yes' : 'no')),
    list('dnp', atom('no')),
    list('uuid', str(uuid())),
    instProp('Reference', ref, r4(x + refAt[0]), r4(y + refAt[1]), { justify: refJustify }),
    instProp('Value', value, r4(x + valueAt[0]), r4(y + valueAt[1]), { hide: !showValue }),
    instProp('Footprint', footprint, x, y, { hide: true }),
    instProp('Datasheet', '', x, y, { hide: true }),
    ...pinNumbers.map((n) => list('pin', str(String(n)), list('uuid', str(uuid())))),
    list(
      'instances',
      list(
        'project',
        str(projectName),
        list('path', str(`/${rootSheet}`), list('reference', str(ref)), list('unit', atom(1)))
      )
    )
  )
}

function wire(x1, y1, x2, y2) {
  return list(
    'wire',
    list('pts', list('xy', atom(mm(x1)), atom(mm(y1))), list('xy', atom(mm(x2)), atom(mm(y2)))),
    list('stroke', list('width', atom(0)), list('type', atom('default'))),
    list('uuid', str(uuid()))
  )
}

function label(name, x, y, angle = 0) {
  return list(
    'label',
    str(name),
    list('at', atom(mm(x)), atom(mm(y)), atom(angle)),
    list(
      'effects',
      list('font', list('size', atom(1.27), atom(1.27))),
      list('justify', atom(angle === 180 ? 'right' : 'left'), atom('bottom'))
    ),
    list('uuid', str(uuid()))
  )
}

function globalLabel(name, x, y, angle = 0, shape = 'bidirectional') {
  return list(
    'global_label',
    str(name),
    list('shape', atom(shape)),
    list('at', atom(mm(x)), atom(mm(y)), atom(angle)),
    list(
      'effects',
      list('font', list('size', atom(1.27), atom(1.27))),
      list('justify', atom(angle === 180 ? 'right' : 'left'))
    ),
    list('uuid', str(uuid())),
    list(
      'property',
      str('Intersheetrefs'),
      str('${INTERSHEET_REFS}'),
      list('at', atom(0), atom(0), atom(0)),
      list(
        'effects',
        list('font', list('size', atom(1.27), atom(1.27))),
        list('justify', atom('left')),
        list('hide', atom('yes'))
      )
    )
  )
}

function schText(content, x, y, size = 2.54) {
  return list(
    'text',
    str(content),
    list('at', atom(mm(x)), atom(mm(y)), atom(0)),
    list(
      'effects',
      list('font', list('size', atom(size), atom(size))),
      list('justify', atom('left'), atom('bottom'))
    ),
    list('uuid', str(uuid()))
  )
}

/**
 * Collects schematic items and tracks the bounding box of everything placed,
 * so the paper size can be chosen to actually contain the drawing.
 */
function makeSheet() {
  const items = []
  const libSymbols = []
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const cover = (x, y) => {
    bbox.minX = Math.min(bbox.minX, x)
    bbox.maxX = Math.max(bbox.maxX, x)
    bbox.minY = Math.min(bbox.minY, y)
    bbox.maxY = Math.max(bbox.maxY, y)
  }
  return {
    items,
    libSymbols,
    bbox,
    cover,
    coverBox(x1, y1, x2, y2) {
      cover(x1, y1)
      cover(x2, y2)
    },
    add(node) {
      items.push(node)
      return node
    },
    /** Place a symbol and extend the bbox by its library bounds (Y flipped). */
    place(node, x, y, bounds) {
      items.push(node)
      cover(x + bounds.minX, y - bounds.maxY)
      cover(x + bounds.maxX, y - bounds.minY)
      return node
    },
    wire(x1, y1, x2, y2) {
      items.push(wire(x1, y1, x2, y2))
      cover(x1, y1)
      cover(x2, y2)
    },
    label(name, x, y, angle = 0) {
      items.push(label(name, x, y, angle))
      coverLabel(cover, name, x, y, angle)
    },
    globalLabel(name, x, y, angle = 0, shape = 'bidirectional') {
      items.push(globalLabel(name, x, y, angle, shape))
      coverLabel(cover, name, x, y, angle)
    },
    text(content, x, y, size = 2.54) {
      items.push(schText(content, x, y, size))
      cover(x, y - size)
      cover(x + content.length * size * 0.7, y)
    }
  }
}

/** Approximate ink extent of a label so it is not clipped by the page edge. */
function coverLabel(cover, name, x, y, angle) {
  const len = name.length * 1.0 + 3.0 // ~1 mm per glyph at size 1.27, plus flag
  if (angle === 180) {
    cover(x - len, y - TEXT_H)
    cover(x, y + TEXT_H)
  } else if (angle === 90) {
    cover(x - TEXT_H, y - len)
    cover(x + TEXT_H, y)
  } else if (angle === 270) {
    cover(x - TEXT_H, y)
    cover(x + TEXT_H, y + len)
  } else {
    cover(x, y - TEXT_H)
    cover(x + len, y + TEXT_H)
  }
}

/**
 * How many cells to put in a schematic row.
 *
 * One matrix column per schematic column is preferred, so the drawing mirrors
 * the board. That shape is only kept while the resulting block also fits the
 * height available; otherwise rows are widened until it does, which is what
 * lets a tall drawing use the width of the sheet instead of demanding a bigger
 * one.
 */
function cellsPerRow(count, preferred, cellW, cellH, availW, availH) {
  const maxFit = Math.max(1, Math.min(count, Math.floor(availW / cellW)))
  const blockH = (per) => Math.ceil(count / per) * cellH
  const wanted = preferred > 0 ? Math.min(preferred, count) : 0
  if (wanted > 0 && wanted <= maxFit && blockH(wanted) <= availH) return wanted
  const maxRows = Math.max(1, Math.floor(availH / cellH))
  const needed = Math.max(1, Math.ceil(count / maxRows))
  return Math.max(1, Math.min(maxFit, Math.max(needed, wanted || 1)))
}

const PAPER_SIZES = [
  ['A4', 297, 210],
  ['A3', 420, 297],
  ['A2', 594, 420],
  ['A1', 841, 594],
  ['A0', 1189, 841]
]

/**
 * Lay the schematic out, then pick the smallest sheet that holds it. The two
 * are circular — how wide the rows are decides how tall the drawing is — so the
 * layout is re-run for each candidate sheet and the first one that fits wins.
 * That keeps the drawing filling the page instead of a narrow strip down one
 * side of an oversized sheet.
 */
function buildSchematic(c, nets, pins, rootSheet, symlib) {
  let last = null
  for (const [, pw, ph] of PAPER_SIZES) {
    const sheet = layoutSchematic(c, pins, rootSheet, symlib, pw - 2 * SHEET_MARGIN, ph)
    last = { sheet, pw, ph }
    if (fitsPage(sheet, pw, ph)) return assembleSchematic(c, rootSheet, sheet, [pw, ph], PAPER_SIZES.find((s) => s[1] === pw)[0])
  }
  // Nothing standard fits: fall back to a custom sheet, capped at KiCad's limit.
  const sheet = layoutSchematic(c, pins, rootSheet, symlib, MAX_PAGE_MM - 2 * SHEET_MARGIN, MAX_PAGE_MM)
  const uw = Math.min(MAX_PAGE_MM, Math.ceil(sheet.bbox.maxX + SHEET_MARGIN))
  const uh = Math.min(MAX_PAGE_MM, Math.ceil(sheet.bbox.maxY + SHEET_MARGIN + TITLE_BLOCK_H))
  if (!fitsPage(sheet, uw, uh)) {
    throw new Error(
      `A ${c.rows} x ${c.cols} ${c.type} matrix needs a schematic sheet of about ` +
        `${Math.ceil(sheet.bbox.maxX + 2 * SHEET_MARGIN)} x ` +
        `${Math.ceil(sheet.bbox.maxY + SHEET_MARGIN + TITLE_BLOCK_H)} mm, which is larger than ` +
        `KiCad's ${MAX_PAGE_MM} mm maximum page. Reduce the matrix size — roughly 640 LEDs, ` +
        `or 200 keys plus LEDs, fit on one sheet.`
    )
  }
  return assembleSchematic(c, rootSheet, sheet, [uw, uh], 'User')
}

/** Does the drawing clear the page edges and the title block? */
function fitsPage(sheet, pw, ph) {
  return (
    sheet.bbox.minX >= 0 &&
    sheet.bbox.minY >= 0 &&
    sheet.bbox.maxX <= pw - SHEET_MARGIN &&
    sheet.bbox.maxY <= ph - TITLE_BLOCK_H
  )
}

function layoutSchematic(c, pins, rootSheet, symlib, availW, pageH) {
  const lib = c.name
  const sheet = makeSheet()

  // --- symbols used by this board -----------------------------------------
  const libSymbols = sheet.libSymbols

  let swSym = null
  let swPins = null
  let dSym = null
  let dPins = null
  if (c.hasSwitches) {
    const swName = SWITCH_SYMBOL_FOR[c.switchFootprint]
    if (!swName) throw new Error(`No schematic symbol mapped for switch footprint ${c.switchFootprint}`)
    swSym = libSymbol(symlib, swName)
    setSymbolFootprint(swSym, `${lib}:${c.switchFootprint}`)
    swPins = symbolPins(swSym)
    dSym = makeDiodeSymbol()
    setSymbolFootprint(dSym, `${lib}:D_SOD123`)
    dPins = symbolPins(dSym)
  }

  let ledSym = null
  let ledPins = null
  if (c.hasLeds) {
    const ledName = LED_SYMBOL_FOR[c.ledFootprint]
    if (!ledName) throw new Error(`No schematic symbol mapped for LED footprint ${c.ledFootprint}`)
    ledSym = libSymbol(symlib, ledName)
    setSymbolFootprint(ledSym, `${lib}:${c.ledFootprint}`)
    ledPins = symbolPins(ledSym)
  }

  const ctrlRows = c.hasSwitches ? c.rows : 0
  const ctrlCols = c.hasSwitches ? c.cols : 0
  const mcuSym = makeControllerSymbol(ctrlRows, ctrlCols, c.hasLeds)
  const mcuPins = symbolPins(mcuSym)
  const flagSym = c.hasLeds ? makePowerFlagSymbol() : null

  const swSymName = c.hasSwitches ? swSym.items[1].v : null
  const ledSymName = c.hasLeds ? ledSym.items[1].v : null
  const swValue = c.hasSwitches ? symbolProperty(swSym, 'Value') || swSymName : ''
  const ledValue = c.hasLeds ? symbolProperty(ledSym, 'Value') || ledSymName : ''

  for (const s of [swSym, dSym, ledSym, mcuSym, flagSym]) {
    if (!s) continue
    const bare = s.items[1].v
    renameSymbol(s, `${lib}:${bare}`)
    libSymbols.push(s)
  }

  const symName = (s) => s.items[1].v.split(':').slice(1).join(':')

  // --- controller block (top-left) ----------------------------------------
  const mcuBounds = symbolBounds(mcuSym)
  const mcuX = snap(SHEET_MARGIN + LABEL_W - mcuBounds.minX)
  const mcuY = snap(SHEET_MARGIN + TEXT_H * 2 + mcuBounds.maxY)

  sheet.text('Controller', SHEET_MARGIN, snap(SHEET_MARGIN + TEXT_H), 2.54)
  sheet.place(
    symbolInstance({
      lib,
      symbolName: symName(mcuSym),
      ref: 'U1',
      value: 'Controller',
      footprint: '',
      x: mcuX,
      y: mcuY,
      pinNumbers: controllerPinNumbers(ctrlRows, ctrlCols, c.hasLeds),
      rootSheet,
      projectName: lib,
      inBom: false,
      onBoard: false,
      refAt: [0, r4(-mcuBounds.maxY - 2.54)],
      showValue: true,
      valueAt: [0, r4(-mcuBounds.minY + 2.54)]
    }),
    mcuX,
    mcuY,
    mcuBounds
  )

  for (const p of mcuPins) {
    const pt = pinPos(mcuX, mcuY, p)
    const left = p.x < 0
    const ex = r4(pt.x + (left ? -LEAD : LEAD))
    sheet.wire(pt.x, pt.y, ex, pt.y)
    const net = p.name === 'DATA' ? 'DATA_IN' : p.name
    const shape =
      p.name === 'DATA' ? 'output' : p.name === 'VDD' || p.name === 'GND' ? 'input' : 'bidirectional'
    sheet.globalLabel(net, ex, pt.y, left ? 180 : 0, shape)
  }

  let cursorY = snap(sheet.bbox.maxY + 12.7)

  // --- power flags (VDD / GND driven, keeps ERC quiet) ---------------------
  if (c.hasLeds) {
    const flagBounds = symbolBounds(flagSym)
    const flagPin = symbolPins(flagSym)[0]
    let fx = snap(SHEET_MARGIN + LABEL_W)
    const fy = snap(cursorY - flagBounds.minY)
    sheet.text('Power', SHEET_MARGIN, snap(cursorY - TEXT_H), 2.54)
    for (const [i, net] of ['VDD', 'GND'].entries()) {
      sheet.place(
        symbolInstance({
          lib,
          symbolName: symName(flagSym),
          ref: `#FLG${i + 1}`,
          value: 'PWR_FLAG',
          footprint: '',
          x: fx,
          y: fy,
          pinNumbers: ['1'],
          rootSheet,
          projectName: lib,
          inBom: false,
          onBoard: false,
          refAt: [0, r4(-flagBounds.maxY - 2.54)]
        }),
        fx,
        fy,
        flagBounds
      )
      const pt = pinPos(fx, fy, flagPin)
      sheet.wire(pt.x, pt.y, pt.x, r4(pt.y + LEAD))
      sheet.globalLabel(net, pt.x, r4(pt.y + LEAD), 270, 'output')
      fx = snap(fx + 25.4)
    }
    cursorY = snap(sheet.bbox.maxY + 12.7)
  }

  // --- switch matrix -------------------------------------------------------
  if (c.hasSwitches) {
    const swBounds = symbolBounds(swSym)
    const dBounds = symbolBounds(dSym)
    const sw1 = pinByNumber(swPins, '1', swSymName)
    const sw2 = pinByNumber(swPins, '2', swSymName)
    const dA = pinByNumber(dPins, '2', 'D_Matrix') // anode
    const dK = pinByNumber(dPins, '1', 'D_Matrix') // cathode

    // Offsets within a cell, measured from the cell's left edge.
    const swOffX = snap(LABEL_W + LEAD - sw1.x)
    const dOffX = snap(swOffX + sw2.x + LEAD - dA.x)
    const cellW = snap(dOffX + dK.x + LEAD + LABEL_W)
    const cellH = snap(
      Math.max(swBounds.maxY - swBounds.minY, dBounds.maxY - dBounds.minY) + 2 * TEXT_H + 5.08
    )
    const rowOffY = snap(Math.max(swBounds.maxY, dBounds.maxY) + 2 * TEXT_H)

    const availH = (pageH - TITLE_BLOCK_H - cursorY) * (c.hasLeds ? 0.45 : 1)
    const perRow = cellsPerRow(c.rows * c.cols, c.cols, cellW, cellH, availW, availH)
    const originX = SHEET_MARGIN
    const originY = snap(cursorY + TEXT_H)

    sheet.text(
      `Switch matrix — ${c.rows} × ${c.cols}${perRow === c.cols ? '' : ` (wrapped at ${perRow} per row)`}`,
      SHEET_MARGIN,
      snap(cursorY - TEXT_H),
      2.54
    )

    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const seq = r * c.cols + col
        const gx = perRow === c.cols ? col : seq % perRow
        const gy = perRow === c.cols ? r : Math.floor(seq / perRow)
        const cellX = snap(originX + gx * cellW)
        const y = snap(originY + gy * cellH + rowOffY)
        const idx = seq + 1
        const swX = snap(cellX + swOffX)
        const dX = snap(cellX + dOffX)

        sheet.place(
          symbolInstance({
            lib,
            symbolName: swSymName,
            ref: `SW${idx}`,
            value: swValue,
            footprint: `${lib}:${c.switchFootprint}`,
            x: swX,
            y,
            pinNumbers: [sw1.number, sw2.number],
            rootSheet,
            projectName: lib,
            refAt: [0, r4(-swBounds.maxY - 1.27)]
          }),
          swX,
          y,
          swBounds
        )
        sheet.place(
          symbolInstance({
            lib,
            symbolName: symName(dSym),
            ref: `D${idx}`,
            value: '1N4148W',
            footprint: `${lib}:D_SOD123`,
            x: dX,
            y,
            pinNumbers: [dK.number, dA.number],
            rootSheet,
            projectName: lib,
            refAt: [0, r4(-dBounds.maxY - 1.27)]
          }),
          dX,
          y,
          dBounds
        )

        const p1 = pinPos(swX, y, sw1)
        const p2 = pinPos(swX, y, sw2)
        const pa = pinPos(dX, y, dA)
        const pk = pinPos(dX, y, dK)

        // ROW net -> switch pin 1
        sheet.wire(r4(p1.x - LEAD), p1.y, p1.x, p1.y)
        sheet.globalLabel(`ROW${r}`, r4(p1.x - LEAD), p1.y, 180)
        // switch pin 2 -> diode anode (per-key net)
        sheet.wire(p2.x, p2.y, pa.x, pa.y)
        sheet.label(`SW${r}_${col}`, r4((p2.x + pa.x) / 2), p2.y)
        // diode cathode -> COL net
        sheet.wire(pk.x, pk.y, r4(pk.x + LEAD), pk.y)
        sheet.globalLabel(`COL${col}`, r4(pk.x + LEAD), pk.y, 0)
      }
    }
    cursorY = snap(sheet.bbox.maxY + 12.7)
  }

  // --- LED chain -----------------------------------------------------------
  // Cells are laid out in chain order, not matrix order, so consecutive LEDs
  // sit side by side and DOUT wires straight into the next DIN. Only the row
  // breaks need a label pair, which keeps the drawing readable at any size.
  if (c.hasLeds) {
    const ledBounds = symbolBounds(ledSym)
    const din = pinByName(ledPins, 'DI', ledSymName)
    const dout = pinByName(ledPins, 'DO', ledSymName)
    const vdd = pinByName(ledPins, 'VDD', ledSymName)
    const gnd = pinByName(ledPins, 'GND', ledSymName)

    // Gap between LEDs: the DOUT->DIN wire plus room for its net label.
    const stepX = snap(dout.x - din.x + 3 * LEAD)
    const rowLead = snap(LABEL_W + LEAD) // label + stub at each end of a row
    const rowPitch = snap(vdd.y - gnd.y + 2 * (LEAD + LABEL_W) + TEXT_H)
    const ledOffY = snap(vdd.y + LEAD + LABEL_W)

    const n = c.rows * c.cols
    const perRow = cellsPerRow(n, c.cols, stepX, rowPitch, availW - 2 * rowLead, pageH - TITLE_BLOCK_H - cursorY)
    const originX = snap(SHEET_MARGIN + rowLead - din.x)
    const originY = snap(cursorY + TEXT_H)

    sheet.text(
      `LED chain — ${n} × WS2812, DATA_IN → DATA_OUT (serpentine across the board)`,
      SHEET_MARGIN,
      snap(cursorY - TEXT_H),
      2.54
    )

    // chain index -> matrix cell, the inverse of snakeIndex()
    const cellOfChain = (k) => {
      const r = Math.floor(k / c.cols)
      const i = k % c.cols
      return { r, col: r % 2 === 0 ? i : c.cols - 1 - i }
    }

    for (let k = 0; k < n; k++) {
      const { r, col } = cellOfChain(k)
      const gx = k % perRow
      const gy = Math.floor(k / perRow)
      const lx = snap(originX + gx * stepX)
      const ly = snap(originY + gy * rowPitch + ledOffY)

      sheet.place(
        symbolInstance({
          lib,
          symbolName: ledSymName,
          ref: `LED${r * c.cols + col + 1}`,
          value: ledValue,
          footprint: `${lib}:${c.ledFootprint}`,
          x: lx,
          y: ly,
          pinNumbers: [pins.led.VDD, pins.led.DOUT, pins.led.GND, pins.led.DIN],
          rootSheet,
          projectName: lib,
          refAt: [r4(-(dout.x - din.x) / 2), r4(-ledBounds.maxY + LEAD + LABEL_W - TEXT_H)],
          refJustify: 'left'
        }),
        lx,
        ly,
        ledBounds
      )

      const pV = pinPos(lx, ly, vdd)
      const pG = pinPos(lx, ly, gnd)
      const pI = pinPos(lx, ly, din)
      const pO = pinPos(lx, ly, dout)

      sheet.wire(pV.x, pV.y, pV.x, r4(pV.y - LEAD))
      sheet.globalLabel('VDD', pV.x, r4(pV.y - LEAD), 90, 'input')
      sheet.wire(pG.x, pG.y, pG.x, r4(pG.y + LEAD))
      sheet.globalLabel('GND', pG.x, r4(pG.y + LEAD), 270, 'input')

      // DIN: chain start, row start, or a direct wire from the previous LED
      if (k === 0) {
        sheet.wire(r4(pI.x - LEAD), pI.y, pI.x, pI.y)
        sheet.globalLabel('DATA_IN', r4(pI.x - LEAD), pI.y, 180, 'input')
      } else if (gx === 0) {
        sheet.wire(r4(pI.x - LEAD), pI.y, pI.x, pI.y)
        sheet.label(dataNetName(k, n), r4(pI.x - LEAD), pI.y, 180)
      }

      // DOUT: chain end, row end, or straight into the next LED's DIN
      if (k + 1 === n) {
        sheet.wire(pO.x, pO.y, r4(pO.x + LEAD), pO.y)
        sheet.globalLabel('DATA_OUT', r4(pO.x + LEAD), pO.y, 0, 'output')
      } else if (gx === perRow - 1) {
        sheet.wire(pO.x, pO.y, r4(pO.x + LEAD), pO.y)
        sheet.label(dataNetName(k + 1, n), r4(pO.x + LEAD), pO.y, 0)
      } else {
        // Straight into the next LED's DIN. The link still carries its net
        // label so the schematic and the board agree on the net name.
        const nextIn = pinPos(snap(lx + stepX), ly, din)
        sheet.wire(pO.x, pO.y, nextIn.x, nextIn.y)
        sheet.label(dataNetName(k + 1, n), pO.x, pO.y, 0)
      }
    }
  }

  return sheet
}

function assembleSchematic(c, rootSheet, sheet, [pw, ph], paperName) {
  const titleBlock = list(
    'title_block',
    list('title', str(c.silkText)),
    list('date', str(new Date().toISOString().slice(0, 10))),
    list('rev', str('1.0')),
    list('company', str('')),
    list('comment', atom(1), str(`Generated by KiCad Matrix Generator — ${c.rows}×${c.cols} ${c.type}`)),
    list('comment', atom(2), str('')),
    list('comment', atom(3), str('')),
    list('comment', atom(4), str('')),
    list('comment', atom(5), str('')),
    list('comment', atom(6), str('')),
    list('comment', atom(7), str('')),
    list('comment', atom(8), str('')),
    list('comment', atom(9), str(''))
  )
  const paperNode =
    paperName === 'User'
      ? list('paper', str('User'), atom(mm(pw)), atom(mm(ph)))
      : list('paper', str(paperName))

  return list(
    'kicad_sch',
    list('version', atom(20231120)),
    list('generator', str('eeschema')),
    list('generator_version', str('8.0')),
    list('uuid', str(rootSheet)),
    paperNode,
    titleBlock,
    list('lib_symbols', ...sheet.libSymbols),
    ...sheet.items,
    list('sheet_instances', list('path', str('/'), list('page', str('1'))))
  )
}

// ---------------------------------------------------------------------------
// Diode footprint (SOD-123)

function makeDiodeFootprint() {
  const pad = (num, x) =>
    list(
      'pad',
      str(num),
      atom('smd'),
      atom('rect'),
      list('at', atom(x), atom(0)),
      list('size', atom(0.9), atom(1.0)),
      list('layers', str('F.Cu'), str('F.Paste'), str('F.Mask')),
      list('uuid', str(uuid()))
    )
  return list(
    'footprint',
    str('D_SOD123'),
    list('version', atom(20240108)),
    list('generator', str('pcbnew')),
    list('generator_version', str('8.0')),
    list('layer', str('F.Cu')),
    list('descr', str('SOD-123 small signal diode (generated)')),
    list('tags', str('diode SOD-123')),
    list('property', str('Reference'), str('REF**'), list('at', atom(0), atom(-1.6), atom(0)), list('layer', str('F.SilkS')), list('uuid', str(uuid())), list('effects', list('font', list('size', atom(1), atom(1)), list('thickness', atom(0.15))))),
    list('property', str('Value'), str('D_SOD123'), list('at', atom(0), atom(1.6), atom(0)), list('layer', str('F.Fab')), list('uuid', str(uuid())), list('effects', list('font', list('size', atom(1), atom(1)), list('thickness', atom(0.15))))),
    list('property', str('Footprint'), str(''), list('at', atom(0), atom(0), atom(0)), list('layer', str('F.Fab')), list('hide', atom('yes')), list('uuid', str(uuid())), list('effects', list('font', list('size', atom(1.27), atom(1.27)), list('thickness', atom(0.15))))),
    list('property', str('Datasheet'), str(''), list('at', atom(0), atom(0), atom(0)), list('layer', str('F.Fab')), list('hide', atom('yes')), list('uuid', str(uuid())), list('effects', list('font', list('size', atom(1.27), atom(1.27)), list('thickness', atom(0.15))))),
    list('attr', atom('smd')),
    list('fp_line', list('start', atom(-1.3), atom(-0.8)), list('end', atom(1.3), atom(-0.8)), list('stroke', list('width', atom(0.12)), list('type', atom('solid'))), list('layer', str('F.SilkS')), list('uuid', str(uuid()))),
    list('fp_line', list('start', atom(1.3), atom(-0.8)), list('end', atom(1.3), atom(0.8)), list('stroke', list('width', atom(0.12)), list('type', atom('solid'))), list('layer', str('F.SilkS')), list('uuid', str(uuid()))),
    list('fp_line', list('start', atom(1.3), atom(0.8)), list('end', atom(-1.3), atom(0.8)), list('stroke', list('width', atom(0.12)), list('type', atom('solid'))), list('layer', str('F.SilkS')), list('uuid', str(uuid()))),
    list('fp_line', list('start', atom(-1.3), atom(0.8)), list('end', atom(-1.3), atom(-0.8)), list('stroke', list('width', atom(0.12)), list('type', atom('solid'))), list('layer', str('F.SilkS')), list('uuid', str(uuid()))),
    list('fp_line', list('start', atom(0.9), atom(0.8)), list('end', atom(0.9), atom(-0.8)), list('stroke', list('width', atom(0.12)), list('type', atom('solid'))), list('layer', str('F.SilkS')), list('uuid', str(uuid()))),
    list('fp_rect', list('start', atom(-1.3), atom(-0.8)), list('end', atom(1.3), atom(0.8)), list('stroke', list('width', atom(0.1)), list('type', atom('solid'))), list('fill', atom('none')), list('layer', str('F.Fab')), list('uuid', str(uuid()))),
    list('fp_rect', list('start', atom(-2.0), atom(-1.15)), list('end', atom(2.0), atom(1.15)), list('stroke', list('width', atom(0.05)), list('type', atom('solid'))), list('fill', atom('none')), list('layer', str('F.CrtYd')), list('uuid', str(uuid()))),
    pad('1', 1.35),
    pad('2', -1.35)
  )
}

// ---------------------------------------------------------------------------
// PCB builders

function setProperty(tree, key, value) {
  for (const p of children(tree, 'property')) {
    if (p.items.length > 1 && p.items[1].v === key) {
      p.items[2] = str(value)
      return
    }
  }
}

function insertNetIntoPad(pad, netNode) {
  const sizeIdx = pad.items.findIndex((it) => it.t === 'list' && op(it) === 'size')
  const atIdx = pad.items.findIndex((it) => it.t === 'list' && op(it) === 'at')
  if (sizeIdx >= 0) pad.items.splice(sizeIdx + 1, 0, netNode)
  else if (atIdx >= 0) pad.items.splice(atIdx + 1, 0, netNode)
  else pad.items.push(netNode)
}

function footprintInstance(fp, lib, ref, value, x, y, angle, netFn) {
  const t = clone(fp.tree)
  // The .kicad_mod tree is (footprint "NAME" ...) — rename the value token.
  t.items[1] = str(`${lib}:${fp.name}`)
  // Strip library-only metadata so the node matches what pcbnew writes for a
  // board footprint instance.
  t.items = t.items.filter((it) => {
    const o = op(it)
    return o !== 'version' && o !== 'generator' && o !== 'generator_version' && o !== 'layer'
  })
  t.items.splice(
    2,
    0,
    list('layer', str('F.Cu')),
    list('uuid', str(uuid())),
    list('at', atom(mm(x)), atom(mm(y)), atom(angle))
  )
  setProperty(t, 'Reference', ref)
  setProperty(t, 'Value', value)
  setProperty(t, 'Footprint', `${lib}:${fp.name}`)
  walk(t, (node) => {
    if (op(node) === 'uuid') node.items[1] = str(uuid())
  })
  for (const pad of children(t, 'pad')) {
    const number = pad.items.length > 1 ? pad.items[1].v : ''
    const net = netFn(number)
    if (net) insertNetIntoPad(pad, list('net', atom(net.num), str(net.name)))
  }
  return t
}

function grLine(x1, y1, x2, y2) {
  return list(
    'gr_line',
    list('start', atom(mm(x1)), atom(mm(y1))),
    list('end', atom(mm(x2)), atom(mm(y2))),
    list('stroke', list('width', atom(0.1)), list('type', atom('default'))),
    list('layer', str('Edge.Cuts')),
    list('uuid', str(uuid()))
  )
}

function grText(text, x, y) {
  return list(
    'gr_text',
    str(text),
    list('at', atom(mm(x)), atom(mm(y))),
    list('layer', str('F.SilkS')),
    list('effects', list('font', list('size', atom(1.5), atom(1.5)), list('thickness', atom(0.2))), list('justify', atom('left'))),
    list('uuid', str(uuid()))
  )
}

function buildPcb(c, nets, pins, registry) {
  const lib = c.name
  const footprints = []
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }

  const expand = (cx, cy, pad) => {
    const hw = pad.size ? pad.size.w / 2 : 0
    const hh = pad.size ? pad.size.h / 2 : 0
    bounds.minX = Math.min(bounds.minX, cx + pad.pos.x - hw)
    bounds.maxX = Math.max(bounds.maxX, cx + pad.pos.x + hw)
    bounds.minY = Math.min(bounds.minY, cy + pad.pos.y - hh)
    bounds.maxY = Math.max(bounds.maxY, cy + pad.pos.y + hh)
  }

  if (c.hasSwitches) {
    const swFp = registry[c.switchFootprint]
    const dioFp = makeDiodeFootprint()
    // makeDiodeFootprint returns a tree; wrap into pseudo registry entry
    const diodeParsed = { name: 'D_SOD123', tree: dioFp, pads: extractPads(dioFp) }
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const idx = r * c.cols + col + 1
        const sp = switchPos(c, r, col)
        const dp = diodePos(c, r, col)
        const rowNet = nets.map[`ROW${r}`]
        const colNet = nets.map[`COL${col}`]
        const swNet = nets.map[`SW${r}_${col}`]

        const sw = footprintInstance(swFp, lib, `SW${idx}`, 'SW_Push', sp.x, sp.y, 0, (num) => {
          if (num === '1') return { num: rowNet, name: `ROW${r}` }
          if (num === '2') return { num: swNet, name: `SW${r}_${col}` }
          return null
        })
        const dio = footprintInstance(diodeParsed, lib, `D${idx}`, '1N4148W', dp.x, dp.y, 0, (num) => {
          if (num === '1') return { num: colNet, name: `COL${col}` }
          if (num === '2') return { num: swNet, name: `SW${r}_${col}` }
          return null
        })
        footprints.push(sw, dio)
        for (const pad of swFp.pads) expand(sp.x, sp.y, pad)
        for (const pad of diodeParsed.pads) expand(dp.x, dp.y, pad)
      }
    }
  }

  if (c.hasLeds) {
    const ledFp = registry[c.ledFootprint]
    // Pad -> function comes from the library symbol, so schematic and board
    // can never disagree about which pad is DIN.
    const fnMap = {}
    for (const [fn, num] of Object.entries(pins.led)) fnMap[num] = fn
    const n = c.rows * c.cols
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const idx = r * c.cols + col + 1
        const lp = ledPos(c, r, col)
        const k = snakeIndex(c, r, col)
        const led = footprintInstance(ledFp, lib, `LED${idx}`, 'WS2812B', lp.x, lp.y, 0, (num) => {
          const f = fnMap[num]
          if (!f) return null
          const name =
            f === 'VDD' ? 'VDD' : f === 'GND' ? 'GND' : f === 'DIN' ? dataNetName(k, n) : dataNetName(k + 1, n)
          return { num: nets.map[name], name }
        })
        footprints.push(led)
        for (const pad of ledFp.pads) expand(lp.x, lp.y, pad)
      }
    }
  }

  // Board outline from pad extents + margin
  bounds.minX -= c.margin
  bounds.maxX += c.margin
  bounds.minY -= c.margin
  bounds.maxY += c.margin

  const netsNodes = [list('net', atom(0), str(''))]
  nets.names.forEach((name, i) => netsNodes.push(list('net', atom(i + 1), str(name))))

  const x1 = r4(bounds.minX)
  const y1 = r4(bounds.minY)
  const x2 = r4(bounds.maxX)
  const y2 = r4(bounds.maxY)

  const edge = [
    grLine(x1, y1, x2, y1),
    grLine(x2, y1, x2, y2),
    grLine(x2, y2, x1, y2),
    grLine(x1, y2, x1, y1)
  ]

  return list(
    'kicad_pcb',
    list('version', atom(20240108)),
    list('generator', str('pcbnew')),
    list('generator_version', str('8.0')),
    list('general', list('thickness', atom(mm(c.thickness)))),
    list('paper', str('A4')),
    parse(PCB_LAYERS),
    parse(PCB_SETUP),
    ...netsNodes,
    ...footprints,
    ...edge,
    grText(c.silkText, r4(bounds.minX + 1), r4(bounds.maxY - 1.5))
  )
}

function extractPads(tree) {
  const pads = []
  for (const pad of children(tree, 'pad')) {
    const number = pad.items.length > 1 ? pad.items[1].v : ''
    const atNode = child(pad, 'at')
    const sizeNode = child(pad, 'size')
    pads.push({
      number,
      pos: { x: parseFloat(atNode.items[1].v), y: parseFloat(atNode.items[2].v) },
      size: { w: parseFloat(sizeNode.items[1].v), h: parseFloat(sizeNode.items[2].v) }
    })
  }
  return pads
}

// ---------------------------------------------------------------------------
// Project (.kicad_pro)

function buildProjectJson(c, rootSheet) {
  const lib = c.name
  const pro = {
    board: {
      '3dviewports': [],
      design_settings: {
        default_text_height: 1.5,
        default_text_width: 1.5,
        default_line_width: 0.1,
        default_text_thickness: 0.3,
        default_solder_mask_min_width: 0.0,
        default_solder_paste_margin: 0.0,
        default_solder_paste_margin_ratio: 0.0,
        default_pad_drill_diameter: 0.8,
        default_pad_diameter: 1.7,
        default_via_diameter: 0.8,
        default_via_drill: 0.4,
        default_netclass: 'Default',
        default_zone_clearance: 0.5,
        default_zone_min_width: 0.25,
        default_keepout_min_width: 0.1,
        default_minimum_clearance: 0.2,
        copper_spacing: 0.2,
        tracks_min_width: 0.2,
        vias_min_size: 0.5,
        vias_min_drill: 0.3,
        board_outline_line_width: 0.1,
        courtyard_outline_line_width: 0.05,
        silkscreen_line_width: 0.15,
        fab_outline_line_width: 0.1,
        reference_text_height: 1.0,
        reference_text_width: 1.0,
        reference_text_thickness: 0.15,
        value_text_height: 1.0,
        value_text_width: 1.0,
        value_text_thickness: 0.15
      },
      layer_presets: [],
      viewports: []
    },
    boards: [],
    cvpcb: { equivalence_files: [] },
    libraries: {
      pinned_footprint_libs: [
        { name: lib, uri: `\${KIPRJMOD}/${lib}.pretty`, options: '', description: '' }
      ],
      pinned_symbol_libs: [
        { name: lib, uri: `\${KIPRJMOD}/${lib}.kicad_sym`, options: '', description: '' }
      ]
    },
    meta: { filename: `${lib}.kicad_pro`, version: 1 },
    net_settings: {
      classes: [
        {
          bus_width: 12.0,
          clearance: 0.2,
          diff_pair_gap: 0.25,
          diff_pair_via_gap: 0.25,
          diff_pair_width: 0.2,
          line_style: 0,
          microvia_diameter: 0.3,
          microvia_drill: 0.1,
          name: 'Default',
          pcb_color: 'rgba(0, 0, 0, 0.000)',
          schematic_color: 'rgba(0, 0, 0, 0.000)',
          track_width: 0.25,
          via_diameter: 0.8,
          via_drill: 0.4,
          wire_width: 6
        }
      ],
      meta: { version: 3 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: []
    },
    pcbnew: {
      last_paths: {
        gencad: '',
        idf: '',
        netlist: '',
        plot: '',
        pos_files: '',
        specctra_dsn: '',
        step: '',
        svg: '',
        vrml: ''
      },
      page_layout_descr_file: ''
    },
    schematic: {
      annotate_start_num: 0,
      bom_export_filename: '',
      drawing_default_sheet_number: '1',
      drawing_default_sheet_revision: '0',
      drawing_default_sheet_title: '',
      drawing_default_line_thickness: 6,
      drawing_default_text_size: 50,
      drawing_default_dashed_lines: true,
      drawing_default_fill_shape: true,
      drawing_default_pen_width: 0.1,
      drawing_dashed_lines_dash_length_ratio: 12.0,
      drawing_dashed_lines_gap_length_ratio: 3.0,
      drawing_erase_color_theme: 0,
      drawing_plot_output_axis: 0,
      drawing_units: 3,
      drawing_intersheets_ref_own_page: false,
      drawing_intersheets_ref_prefix: 'm_',
      drawing_intersheets_ref_short: true,
      drawing_intersheets_ref_show: false,
      drawing_intersheets_ref_format: 0,
      drawing_intersheets_ref_position: 0,
      drawing_title_block_title: '',
      drawing_title_block_date: '',
      drawing_title_block_revision: '',
      drawing_title_block_company: '',
      drawing_title_block_comment_1: '',
      drawing_title_block_comment_2: '',
      drawing_title_block_comment_3: '',
      drawing_title_block_comment_4: '',
      drawing_title_block_comment_5: '',
      drawing_title_block_comment_6: '',
      drawing_title_block_comment_7: '',
      drawing_title_block_comment_8: '',
      drawing_title_block_comment_9: '',
      drawing_gerber_plot_directory: '',
      drawing_gerber_plot_units: 0,
      drawing_gerber_plot_format: 0,
      drawing_gerber_plot_use_aux_axis: false,
      drawing_gerber_plot_gerber_precision: 6,
      drawing_gerber_plot_create_gerber_job_file: true,
      drawing_gerber_plot_subtract_mask_from_silk: false,
      drawing_gerber_plot_coordinate_format: 0,
      drawing_gerber_plot_use_gerber_attributes: true,
      drawing_gerber_plot_use_gerber_x2_attributes: true,
      drawing_gerber_plot_use_gerber_net_attributes: true,
      drawing_gerber_plot_dashed_lines: true,
      drawing_gerber_plot_x2_format: 0,
      drawing_gerber_plot_include_texts: 0,
      drawing_gerber_plot_include_netlist_info: true,
      drawing_gerber_plot_include_sheet_number: true,
      drawing_gerber_plot_include_sheet_title: true,
      drawing_gerber_plot_include_sheet_comment: true,
      drawing_gerber_plot_include_sheet_revision: true,
      drawing_gerber_plot_include_sheet_company: true,
      drawing_gerber_plot_disable_aperture_macros: false,
      drawing_gerber_plot_use_exact_bbox: false,
      drawing_gerber_plot_use_alternate_gerber_theme: false,
      drawing_gerber_plot_drill_file_format: 0,
      drawing_gerber_plot_drill_units: 0,
      drawing_gerber_plot_drill_zero_format: 0,
      drawing_gerber_plot_drill_origin: 0,
      drawing_gerber_plot_drill_oval_hole_format: 0,
      drawing_gerber_plot_drill_mirror_y_axis: false,
      drawing_gerber_plot_npth_pads: true,
      drawing_gerber_plot_include_sheet_reference: true,
      drawing_gerber_plot_disable_aperture_macros: false,
      drawing_gerber_plot_drill_origin_offset_x: 0.0,
      drawing_gerber_plot_drill_origin_offset_y: 0.0
    },
    sheets: [[rootSheet, `${lib}.kicad_sch`]],
    text_variables: {}
  }
  return JSON.stringify(pro, null, 2)
}

// ---------------------------------------------------------------------------
// Symbol library (.kicad_sym)

function buildSymbolLib(c, symlib) {
  const lib = c.name
  const symbols = []
  if (c.hasSwitches) {
    const sw = libSymbol(symlib, SWITCH_SYMBOL_FOR[c.switchFootprint])
    setSymbolFootprint(sw, `${lib}:${c.switchFootprint}`)
    symbols.push(sw)
    const d = makeDiodeSymbol()
    setSymbolFootprint(d, `${lib}:D_SOD123`)
    symbols.push(d)
  }
  if (c.hasLeds) {
    const led = libSymbol(symlib, LED_SYMBOL_FOR[c.ledFootprint])
    setSymbolFootprint(led, `${lib}:${c.ledFootprint}`)
    symbols.push(led)
  }
  symbols.push(makeControllerSymbol(c.hasSwitches ? c.rows : 0, c.hasSwitches ? c.cols : 0, c.hasLeds))
  if (c.hasLeds) symbols.push(makePowerFlagSymbol())
  return list(
    'kicad_symbol_lib',
    list('version', atom(20231120)),
    list('generator', str('kicad_symbol_editor')),
    list('generator_version', str('8.0')),
    ...symbols
  )
}

// ---------------------------------------------------------------------------
// Project library tables
//
// KiCad resolves a "lib:name" lib_id through the project's sym-lib-table and
// fp-lib-table. Without them every symbol and footprint in the project reads as
// unresolved, regardless of what .kicad_pro pins.

function buildLibTables(c) {
  const lib = c.name
  const symTable = [
    '(sym_lib_table',
    '\t(version 7)',
    `\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/${lib}.kicad_sym")(options "")(descr "Matrix symbols"))`,
    ')',
    ''
  ].join('\n')
  const fpTable = [
    '(fp_lib_table',
    '\t(version 7)',
    `\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/${lib}.pretty")(options "")(descr "Matrix footprints"))`,
    ')',
    ''
  ].join('\n')
  return { symTable, fpTable }
}

// ---------------------------------------------------------------------------
// README

function buildReadme(c, rootSheet) {
  const lines = []
  lines.push(`# ${c.silkText}`)
  lines.push('')
  lines.push('KiCad project generated by the KiCad Matrix Generator.')
  lines.push('')
  lines.push('## Contents')
  lines.push('')
  lines.push(`- \`${c.name}.kicad_pro\` — project file (open this in KiCad)`)
  lines.push(`- \`${c.name}.kicad_sch\` — schematic`)
  lines.push(`- \`${c.name}.kicad_pcb\` — board (footprints placed, nets assigned, outline drawn)`)
  lines.push(`- \`${c.name}.kicad_sym\` — symbol library`)
  lines.push(`- \`${c.name}.pretty/\` — footprint library`)
  lines.push('- `sym-lib-table`, `fp-lib-table` — project library tables (how KiCad resolves the above)')
  lines.push(`- \`Libraries/\` — 3D models used by the footprints`)
  lines.push('')
  lines.push('## Configuration')
  lines.push('')
  lines.push(`- Type: ${c.type}`)
  lines.push(`- Matrix: ${c.rows} rows × ${c.cols} cols`)
  if (c.hasSwitches) {
    lines.push(`- Switch footprint: ${c.switchFootprint}`)
    lines.push(`- Key pitch: ${c.keyPitch} mm`)
    lines.push('- Each key: switch + series diode (1N4148W, SOD-123), row/column matrix')
  }
  if (c.hasLeds) {
    lines.push(`- LED footprint: ${c.ledFootprint}`)
    lines.push(`- LED pitch: ${c.ledPitch} mm`)
    lines.push('- LEDs chained in a serpentine DIN → DOUT order (DATA_IN → DATA_OUT)')
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- The switch matrix nets (ROW*, COL*) are assigned but unrouted — route them')
  lines.push('  with the interactive router, or keep the airwires for manual routing.')
  lines.push('- Footprint 3D models are included under `Libraries/` so the 3D viewer works.')
  lines.push('- `U1` is a placeholder for your controller: it carries the ROW/COL (and')
  lines.push('  GND/VDD/DATA) connections for ERC but is not placed on the board. Replace it')
  lines.push('  with your real MCU or connector symbol.')
  lines.push('- Nets cross between blocks via global labels, so the switch matrix, the LED')
  lines.push('  chain and the controller connect without wires running across the sheet.')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Top-level entry point

/**
 * Generate the complete project. Returns { files, summary }.
 * `symlib` is the parsed bundled symbol library (see parseSymbolLibrary).
 */
export function generateProject(config, registry, symlib) {
  const c = normalizeConfig(config)
  if (!symlib || !symlib.symbols) throw new Error('generateProject requires a parsed symbol library')
  const nets = buildNets(c)
  const rootSheet = uuid()

  // LED pad numbers per function, read from the library symbol for this
  // footprint variant — the pad numbering differs between 5050/3535/2020/1615.
  const pins = {}
  if (c.hasLeds) {
    const ledFp = registry[c.ledFootprint]
    if (!ledFp) throw new Error(`Unknown LED footprint: ${c.ledFootprint}`)
    const ledSymName = LED_SYMBOL_FOR[c.ledFootprint]
    if (!ledSymName) throw new Error(`No schematic symbol mapped for LED footprint ${c.ledFootprint}`)
    pins.led = ledPinNumbers(libSymbol(symlib, ledSymName))
    const padNumbers = new Set(ledFp.pads.map((p) => p.number))
    for (const [fn, num] of Object.entries(pins.led)) {
      if (!padNumbers.has(num)) {
        throw new Error(`${ledSymName} pin ${fn} is pad "${num}", which ${c.ledFootprint} does not have`)
      }
    }
  }

  const files = []

  const schTree = buildSchematic(c, nets, pins, rootSheet, symlib)
  files.push({ path: `${c.name}/${c.name}.kicad_sch`, content: serialize(schTree) + '\n' })

  const pcbTree = buildPcb(c, nets, pins, registry)
  files.push({ path: `${c.name}/${c.name}.kicad_pcb`, content: serialize(pcbTree) + '\n' })

  files.push({ path: `${c.name}/${c.name}.kicad_pro`, content: buildProjectJson(c, rootSheet) + '\n' })

  const symLib = buildSymbolLib(c, symlib)
  files.push({ path: `${c.name}/${c.name}.kicad_sym`, content: serialize(symLib) + '\n' })

  // Footprint library
  const copied = new Set()
  if (c.hasSwitches) copied.add(c.switchFootprint)
  if (c.hasLeds) copied.add(c.ledFootprint)
  for (const name of copied) {
    const fp = registry[name]
    if (fp) files.push({ path: `${c.name}/${c.name}.pretty/${name}.kicad_mod`, content: serialize(fp.tree) + '\n' })
  }
  files.push({
    path: `${c.name}/${c.name}.pretty/D_SOD123.kicad_mod`,
    content: serialize(makeDiodeFootprint()) + '\n'
  })

  const tables = buildLibTables(c)
  files.push({ path: `${c.name}/sym-lib-table`, content: tables.symTable })
  files.push({ path: `${c.name}/fp-lib-table`, content: tables.fpTable })

  files.push({ path: `${c.name}/README.md`, content: buildReadme(c, rootSheet) })

  return {
    files,
    summary: {
      name: c.name,
      type: c.type,
      rows: c.rows,
      cols: c.cols,
      keys: c.hasSwitches ? c.rows * c.cols : 0,
      leds: c.hasLeds ? c.rows * c.cols : 0,
      nets: nets.names.length
    }
  }
}
