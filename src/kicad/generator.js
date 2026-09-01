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
  makeSwitchSymbol,
  makeDiodeSymbol,
  makeLedSymbol,
  makeControllerSymbol,
  makePowerFlagSymbol,
  controllerPinNumbers
} from './symbols.js'
import { ledPadFunction } from './ledpins.js'

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

function instProp(key, value, x, y, hide = false) {
  return list(
    'property',
    str(key),
    str(value),
    list('at', atom(x), atom(y), atom(0)),
    list(
      'effects',
      list('font', list('size', atom(1.27), atom(1.27))),
      ...(hide ? [list('hide', atom('yes'))] : [])
    )
  )
}

function symbolInstance(lib, symbolName, ref, value, footprint, x, y, pinNumbers, rootSheet, projectName, opts = {}) {
  const { inBom = true, onBoard = true } = opts
  return list(
    'symbol',
    list('lib_id', str(`${lib}:${symbolName}`)),
    list('at', atom(x), atom(y), atom(0)),
    list('unit', atom(1)),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom(inBom ? 'yes' : 'no')),
    list('on_board', atom(onBoard ? 'yes' : 'no')),
    list('dnp', atom('no')),
    list('uuid', str(uuid())),
    instProp('Reference', ref, x, y - 150),
    instProp('Value', value, x, y + 150),
    instProp('Footprint', footprint, x, y + 250, true),
    instProp('Datasheet', '', x, y + 350, true),
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
    list('pts', list('xy', atom(x1), atom(y1)), list('xy', atom(x2), atom(y2))),
    list('stroke', list('width', atom(0)), list('type', atom('default'))),
    list('uuid', str(uuid()))
  )
}

function label(name, x, y) {
  return list(
    'label',
    str(name),
    list('at', atom(x), atom(y), atom(0)),
    list('effects', list('font', list('size', atom(1.27), atom(1.27))), list('justify', atom('left'))),
    list('uuid', str(uuid()))
  )
}

function globalLabel(name, x, y) {
  return list(
    'global_label',
    str(name),
    list('shape', atom('input')),
    list('at', atom(x), atom(y), atom(0)),
    list('effects', list('font', list('size', atom(1.27), atom(1.27))), list('justify', atom('left'))),
    list('uuid', str(uuid())),
    list(
      'property',
      str('Intersheetrefs'),
      str('${INTERSHEET_REFS}'),
      list('at', atom(0), atom(0), atom(0)),
      list('effects', list('font', list('size', atom(1.27), atom(1.27))), list('justify', atom('left')), list('hide', atom('yes')))
    )
  )
}

function buildSchematic(c, nets, pins, rootSheet) {
  const lib = c.name
  const symbols = []
  if (c.hasSwitches) {
    symbols.push(makeSwitchSymbol())
    symbols.push(makeDiodeSymbol())
  }
  if (c.hasLeds) symbols.push(makeLedSymbol(pins.led))
  symbols.push(makeControllerSymbol(c.hasSwitches ? c.rows : 0, c.hasSwitches ? c.cols : 0, c.hasLeds))
  if (c.hasLeds) symbols.push(makePowerFlagSymbol())

  // In the schematic's embedded lib_symbols section, symbol names must match
  // the instance lib_id, i.e. they carry the full "library:name" prefix.
  for (const s of symbols) {
    s.items[1] = str(`${lib}:${s.items[1].v}`)
  }

  const items = []

  if (c.hasSwitches) {
    const originX = 1000
    const originY = 1000
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const sx = originX + col * 900
        const sy = originY + r * 500
        const ref = `SW${r * c.cols + col + 1}`
        const dRef = `D${r * c.cols + col + 1}`
        items.push(symbolInstance(lib, 'SW_Push', ref, 'SW_Push', `${lib}:${c.switchFootprint}`, sx, sy, ['1', '2'], rootSheet, lib))
        items.push(symbolInstance(lib, 'D_Small', dRef, '1N4148W', `${lib}:D_SOD123`, sx + 360, sy, ['2', '1'], rootSheet, lib))
        // switch pin 1 (left, -200 mils) -> ROW net
        items.push(wire(sx - 200, sy, sx - 260, sy))
        items.push(globalLabel(`ROW${r}`, sx - 260, sy))
        // switch pin 2 (right, +200 mils) -> diode anode (per-key net)
        items.push(wire(sx + 200, sy, sx + 260, sy))
        items.push(label(`SW${r}_${col}`, sx + 230, sy))
        // diode cathode -> COL net
        items.push(wire(sx + 460, sy, sx + 520, sy))
        items.push(globalLabel(`COL${col}`, sx + 520, sy))
      }
    }
  }

  if (c.hasLeds) {
    const originX = 1000
    const originY = c.hasSwitches ? 1000 + c.rows * 500 + 600 : 1000
    const n = c.rows * c.cols
    for (let r = 0; r < c.rows; r++) {
      for (let col = 0; col < c.cols; col++) {
        const lx = originX + col * 1200
        const ly = originY + r * 1000
        const k = snakeIndex(c, r, col)
        const ref = `LED${r * c.cols + col + 1}`
        items.push(
          symbolInstance(lib, 'WS2812B', ref, 'WS2812B', `${lib}:${c.ledFootprint}`, lx, ly, Object.values(pins.led), rootSheet, lib)
        )
        // VDD (top)
        items.push(wire(lx, ly + 300, lx, ly + 400))
        items.push(globalLabel('VDD', lx, ly + 400))
        // GND (bottom)
        items.push(wire(lx, ly - 300, lx, ly - 400))
        items.push(globalLabel('GND', lx, ly - 400))
        // DIN (left)
        items.push(wire(lx - 300, ly, lx - 400, ly))
        if (k === 0) items.push(globalLabel('DATA_IN', lx - 400, ly))
        else items.push(label(dataNetName(k, n), lx - 400, ly))
        // DOUT (right)
        items.push(wire(lx + 300, ly, lx + 400, ly))
        if (k + 1 === n) items.push(globalLabel('DATA_OUT', lx + 400, ly))
        else items.push(label(dataNetName(k + 1, n), lx + 400, ly))
      }
    }
  }

  // Controller block (schematic-only placeholder) + ERC power flags.
  const ctrlRows = c.hasSwitches ? c.rows : 0
  const ctrlCols = c.hasSwitches ? c.cols : 0
  const leftCount = ctrlRows + (c.hasLeds ? 1 : 0)
  const rightCount = ctrlCols + (c.hasLeds ? 2 : 0)
  const ctrlTop = (Math.max(leftCount, rightCount) - 1) * 50 // mils
  const cx = 300
  const cy = 1000

  items.push(
    symbolInstance(
      lib,
      'MCU',
      'U1',
      'Controller',
      '',
      cx,
      cy,
      controllerPinNumbers(ctrlRows, ctrlCols, c.hasLeds),
      rootSheet,
      lib,
      { inBom: false, onBoard: false }
    )
  )
  for (let i = 0; i < ctrlRows; i++) {
    const y = cy + ctrlTop - i * 100
    items.push(wire(cx - 100, y, cx - 200, y))
    items.push(globalLabel(`ROW${i}`, cx - 200, y))
  }
  for (let j = 0; j < ctrlCols; j++) {
    const y = cy + ctrlTop - j * 100
    items.push(wire(cx + 100, y, cx + 200, y))
    items.push(globalLabel(`COL${j}`, cx + 200, y))
  }
  if (c.hasLeds) {
    const gndY = cy + ctrlTop - ctrlRows * 100
    items.push(wire(cx - 100, gndY, cx - 200, gndY))
    items.push(globalLabel('GND', cx - 200, gndY))
    const vddY = cy + ctrlTop - ctrlCols * 100
    items.push(wire(cx + 100, vddY, cx + 200, vddY))
    items.push(globalLabel('VDD', cx + 200, vddY))
    const dataY = cy + ctrlTop - (ctrlCols + 1) * 100
    items.push(wire(cx + 100, dataY, cx + 200, dataY))
    items.push(globalLabel('DATA_IN', cx + 200, dataY))

    // Power flags below the matrix
    const flagY =
      1000 +
      (c.hasSwitches ? c.rows * 500 : 0) +
      (c.hasSwitches && c.hasLeds ? 600 : 0) +
      (c.hasLeds ? c.rows * 1000 : 0) +
      500
    items.push(symbolInstance(lib, 'PWR_FLAG', '#FLG1', 'PWR_FLAG', '', 1000, flagY, ['1'], rootSheet, lib, { inBom: false, onBoard: false }))
    items.push(wire(1000, flagY, 1000, flagY + 100))
    items.push(globalLabel('VDD', 1000, flagY + 100))
    items.push(symbolInstance(lib, 'PWR_FLAG', '#FLG2', 'PWR_FLAG', '', 1000, flagY + 300, ['1'], rootSheet, lib, { inBom: false, onBoard: false }))
    items.push(wire(1000, flagY + 300, 1000, flagY + 400))
    items.push(globalLabel('GND', 1000, flagY + 400))
  }

  // pick paper size
  let maxX = 2000
  let maxY = 2000
  for (const it of items) {
    const o = op(it)
    if (o === 'wire') {
      const pts = child(it, 'pts')
      for (const xy of children(pts, 'xy')) {
        maxX = Math.max(maxX, parseFloat(xy.items[1].v))
        maxY = Math.max(maxY, parseFloat(xy.items[2].v))
      }
    }
  }
  const paper = pickPaper(maxX + 1000, maxY + 1000)

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

  return list(
    'kicad_sch',
    list('version', atom(20231120)),
    list('generator', str('eeschema')),
    list('generator_version', str('8.0')),
    list('uuid', str(rootSheet)),
    list('paper', str(paper)),
    titleBlock,
    list('lib_symbols', ...symbols),
    ...items,
    list('sheet_instances', list('path', str('/'), list('page', str('1'))))
  )
}

function pickPaper(w, h) {
  const sizes = [
    ['A4', 11693, 8268],
    ['A3', 16535, 11693],
    ['A2', 23386, 16535],
    ['A1', 33110, 23386],
    ['A0', 46811, 33110]
  ]
  for (const [name, pw, ph] of sizes) if (w <= pw && h <= ph) return name
  return 'A0'
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
    const fnMap = {}
    for (const pad of ledFp.pads) {
      const f = ledPadFunction(ledFp.name, pad.number)
      if (f) fnMap[pad.number] = f
    }
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

function buildSymbolLib(c, pins) {
  const symbols = []
  if (c.hasSwitches) {
    symbols.push(makeSwitchSymbol())
    symbols.push(makeDiodeSymbol())
  }
  if (c.hasLeds) symbols.push(makeLedSymbol(pins.led))
  return list(
    'kicad_symbol_lib',
    list('version', atom(20231120)),
    list('generator', str('kicad_symbol_editor')),
    list('generator_version', str('8.0')),
    ...symbols
  )
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
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Top-level entry point

/** Generate the complete project. Returns { files, summary }. */
export function generateProject(config, registry) {
  const c = normalizeConfig(config)
  const nets = buildNets(c)
  const rootSheet = uuid()

  // LED pin numbers per function, used by schematic + symbol lib
  const pins = {}
  if (c.hasLeds) {
    const ledFp = registry[c.ledFootprint]
    if (!ledFp) throw new Error(`Unknown LED footprint: ${c.ledFootprint}`)
    const p = {}
    for (const pad of ledFp.pads) {
      const f = ledPadFunction(ledFp.name, pad.number)
      if (f && !(f in p)) p[f] = pad.number
    }
    if (!(p.VDD && p.DOUT && p.GND && p.DIN)) {
      throw new Error(`Could not map VDD/DOUT/GND/DIN pins for ${c.ledFootprint}`)
    }
    // canonical order must match the symbol pin order (VDD, DOUT, GND, DIN)
    pins.led = { VDD: p.VDD, DOUT: p.DOUT, GND: p.GND, DIN: p.DIN }
  }

  const files = []

  const schTree = buildSchematic(c, nets, pins, rootSheet)
  files.push({ path: `${c.name}/${c.name}.kicad_sch`, content: serialize(schTree) + '\n' })

  const pcbTree = buildPcb(c, nets, pins, registry)
  files.push({ path: `${c.name}/${c.name}.kicad_pcb`, content: serialize(pcbTree) + '\n' })

  files.push({ path: `${c.name}/${c.name}.kicad_pro`, content: buildProjectJson(c, rootSheet) + '\n' })

  const symLib = buildSymbolLib(c, pins)
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
