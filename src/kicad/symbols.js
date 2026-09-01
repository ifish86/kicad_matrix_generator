// Schematic symbols.
//
// The switch and WS2812 symbols come from the bundled KiCad symbol library
// (assets/kicad_matrix.kicad_sym). They are copied into the generated project
// verbatim, so the schematic renders exactly like the library the parts were
// drawn in — and, just as importantly, the generator reads the real pin
// coordinates out of them instead of assuming a layout.
//
// The diode, controller placeholder and power flag have no counterpart in that
// library, so they are drawn here in the same style (2.54 mm pin grid).

import { parse, list, str, atom, op, child, clone } from './sexpr.js'

const FONT = (size = 1.27) => list('font', list('size', atom(size), atom(size)))

// ---------------------------------------------------------------------------
// Footprint -> library symbol
//
// Every switch symbol in the library is the same two-terminal SPST drawing, so
// footprints without a dedicated symbol reuse the closest one. The WS2812
// symbols differ: each variant carries the pad numbering of its own footprint.

export const SWITCH_SYMBOL_FOR = {
  SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS: 'SW_SMD_TS-1101',
  SW_SPST_PTS647_Sx38: 'SW_6x6_SMD',
  SW_SPST_PTS815: 'SW_4x3_SMD',
  'SW_SPST_B3U-1000P-B': 'SW_SMD_B3U',
  SW_TL3342F160QG: 'SW_6x6_SMD', // same 6x6 SMD tactile outline, pads 1/2
  SW_PUSH_6mm_H5mm: 'SW_6x6_TH'
}

export const LED_SYMBOL_FOR = {
  WS2812B_5050: 'WS2812_5050',
  'WS2812B-NARROW': 'WS2812_5050', // identical 1-VDD/2-DOUT/3-GND/4-DIN pads
  'WS2812-2020': 'WS2812_2020',
  'WS2812-1615': 'WS2812_1615',
  LED3535: 'WS2812_3535'
}

// ---------------------------------------------------------------------------
// Library access

/**
 * Parse a .kicad_sym source into { version, symbols: Map<name, node> }.
 * Symbols are stored as parsed trees and cloned on every read, so callers can
 * mutate what they get back.
 */
export function parseSymbolLibrary(source) {
  const tree = parse(source)
  if (op(tree) !== 'kicad_symbol_lib') throw new Error('Not a KiCad symbol library')
  const symbols = new Map()
  for (const it of tree.items) {
    if (it.t === 'list' && op(it) === 'symbol') {
      const name = it.items[1]
      if (name && (name.t === 'string' || name.t === 'atom')) symbols.set(name.v, it)
    }
  }
  if (symbols.size === 0) throw new Error('Symbol library contains no symbols')
  return { tree, symbols }
}

/**
 * A copy of a library symbol, downgraded to the KiCad 8 file format: the
 * library was written by KiCad 9 and carries `(embedded_fonts ...)`, a token
 * KiCad 8 cannot parse. Everything else round-trips unchanged.
 */
export function libSymbol(symlib, name) {
  const found = symlib.symbols.get(name)
  if (!found) throw new Error(`Symbol "${name}" is not in the symbol library`)
  return stripKicad9Tokens(clone(found))
}

const KICAD9_ONLY = new Set(['embedded_fonts'])

function stripKicad9Tokens(node) {
  if (node.t !== 'list') return node
  node.items = node.items.filter((it) => !(it.t === 'list' && KICAD9_ONLY.has(op(it))))
  for (const it of node.items) stripKicad9Tokens(it)
  return node
}

/**
 * Every pin of a symbol, in library coordinates (+Y up). `x`/`y` is the
 * connection point — the end a wire must touch. The body end of the pin is
 * `length` away in the direction of `rot`.
 */
export function symbolPins(sym) {
  const pins = []
  const visit = (node) => {
    for (const it of node.items) {
      if (it.t !== 'list') continue
      if (op(it) === 'pin') {
        const at = child(it, 'at')
        const len = child(it, 'length')
        const nameNode = child(it, 'name')
        const numNode = child(it, 'number')
        pins.push({
          type: it.items[1] ? it.items[1].v : 'passive',
          x: parseFloat(at.items[1].v),
          y: parseFloat(at.items[2].v),
          rot: at.items[3] ? parseFloat(at.items[3].v) : 0,
          length: len ? parseFloat(len.items[1].v) : 0,
          name: nameNode ? nameNode.items[1].v : '',
          number: numNode ? numNode.items[1].v : ''
        })
      } else if (op(it) === 'symbol') {
        visit(it)
      }
    }
  }
  visit(sym)
  return pins
}

/** Pin numbers keyed by pin name, e.g. { VDD: '1-VDD', DI: '4-DIN', … }. */
export function pinsByName(sym) {
  const byName = {}
  for (const p of symbolPins(sym)) if (p.name && !(p.name in byName)) byName[p.name] = p.number
  return byName
}

/**
 * WS2812 pad numbers per logical function, read straight out of the library
 * symbol (whose pin names are DI/DO/VDD/GND). This is the single source of
 * truth for LED pin mapping — schematic and PCB both use it.
 */
export function ledPinNumbers(sym) {
  const byName = pinsByName(sym)
  const pins = { VDD: byName.VDD, DOUT: byName.DO, GND: byName.GND, DIN: byName.DI }
  for (const [fn, num] of Object.entries(pins)) {
    if (num === undefined) throw new Error(`LED symbol is missing its ${fn} pin`)
  }
  return pins
}

/**
 * Bounding box of a symbol in library coordinates, covering graphics and pin
 * connection points. Used to lay symbols out without overlapping.
 */
export function symbolBounds(sym) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    b.minX = Math.min(b.minX, x)
    b.maxX = Math.max(b.maxX, x)
    b.minY = Math.min(b.minY, y)
    b.maxY = Math.max(b.maxY, y)
  }
  const pair = (node) => node && add(parseFloat(node.items[1].v), parseFloat(node.items[2].v))
  const visit = (node) => {
    for (const it of node.items) {
      if (it.t !== 'list') continue
      switch (op(it)) {
        case 'rectangle':
          pair(child(it, 'start'))
          pair(child(it, 'end'))
          break
        case 'polyline':
        case 'bezier': {
          const pts = child(it, 'pts')
          if (pts) for (const xy of pts.items) if (xy.t === 'list' && op(xy) === 'xy') pair(xy)
          break
        }
        case 'circle': {
          const c = child(it, 'center')
          const r = child(it, 'radius')
          if (c && r) {
            const cx = parseFloat(c.items[1].v)
            const cy = parseFloat(c.items[2].v)
            const rad = parseFloat(r.items[1].v)
            add(cx - rad, cy - rad)
            add(cx + rad, cy + rad)
          }
          break
        }
        case 'arc':
          pair(child(it, 'start'))
          pair(child(it, 'mid'))
          pair(child(it, 'end'))
          break
        case 'symbol':
          visit(it)
          break
        default:
          break
      }
    }
  }
  visit(sym)
  for (const p of symbolPins(sym)) add(p.x, p.y)
  return b
}

/** Rewrite a symbol's Footprint property (the library ships project-agnostic
 *  values like "0LED:WS2812-2020"). Mutates and returns `sym`. */
export function setSymbolFootprint(sym, value) {
  for (const it of sym.items) {
    if (it.t === 'list' && op(it) === 'property' && it.items[1] && it.items[1].v === 'Footprint') {
      it.items[2] = str(value)
      return sym
    }
  }
  return sym
}

/** Read a symbol property value, or '' when absent. */
export function symbolProperty(sym, key) {
  for (const it of sym.items) {
    if (it.t === 'list' && op(it) === 'property' && it.items[1] && it.items[1].v === key) {
      return it.items[2] ? it.items[2].v : ''
    }
  }
  return ''
}

/** Rename a symbol (the schematic's lib_symbols entries are "lib:name"). */
export function renameSymbol(sym, name) {
  sym.items[1] = str(name)
  return sym
}

// ---------------------------------------------------------------------------
// Symbols built here (no equivalent in the bundled library)

export function symProp(key, value, x, y, angle = 0, hideOrOpts = false) {
  const opts = typeof hideOrOpts === 'object' ? hideOrOpts : { hide: hideOrOpts }
  const { hide = false, justify = null } = opts
  const justifyNode = justify ? list('justify', ...justify.split(' ').map((j) => atom(j))) : null
  const effects = list(
    'effects',
    FONT(),
    ...(justifyNode ? [justifyNode] : []),
    ...(hide ? [list('hide', atom('yes'))] : [])
  )
  return list('property', str(key), str(value), list('at', atom(x), atom(y), atom(angle)), effects)
}

function rect(start, end, width = 0.254, fillType = 'none') {
  return list(
    'rectangle',
    list('start', atom(start[0]), atom(start[1])),
    list('end', atom(end[0]), atom(end[1])),
    list('stroke', list('width', atom(width)), list('type', atom('default'))),
    list('fill', list('type', atom(fillType)))
  )
}

function polyline(pts, width = 0) {
  const xyList = pts.map((p) => list('xy', atom(p[0]), atom(p[1])))
  return list(
    'polyline',
    list('pts', ...xyList),
    list('stroke', list('width', atom(width)), list('type', atom('default'))),
    list('fill', list('type', atom('none')))
  )
}

function pin(type, at, length, name, number) {
  return list(
    'pin',
    atom(type),
    atom('line'),
    list('at', atom(at[0]), atom(at[1]), atom(at[2])),
    list('length', atom(length)),
    list('name', str(name), list('effects', FONT())),
    list('number', str(number), list('effects', FONT()))
  )
}

const hideYes = (key, ...extra) => list(key, ...extra, list('hide', atom('yes')))

/** Small-signal diode (1N4148W) — pin 1 cathode, pin 2 anode, pins at ±2.54. */
export function makeDiodeSymbol() {
  const body = list(
    'symbol',
    str('D_Matrix_0_1'),
    polyline([[-1.27, -1.27], [1.27, 0], [-1.27, 1.27], [-1.27, -1.27]], 0.254),
    polyline([[1.27, -1.27], [1.27, 1.27]], 0.254),
    polyline([[-2.54, 0], [-1.27, 0]], 0),
    polyline([[1.27, 0], [2.54, 0]], 0),
    pin('passive', [-5.08, 0, 0], 2.54, 'A', '2'),
    pin('passive', [5.08, 0, 180], 2.54, 'K', '1')
  )
  return list(
    'symbol',
    str('D_Matrix'),
    hideYes('pin_numbers'),
    hideYes('pin_names', list('offset', atom(0.254))),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom('yes')),
    list('on_board', atom('yes')),
    symProp('Reference', 'D', 0, 2.54, 0),
    symProp('Value', '1N4148W', 0, -2.54, 0),
    symProp('Footprint', '', 0, -5.08, 0, true),
    symProp('Datasheet', '', 0, -7.62, 0, true),
    symProp('Description', 'Matrix isolation diode', 0, 0, 0, true),
    body
  )
}

/**
 * Ordered pin-number list for the controller symbol: rows, then columns, then
 * — when LEDs are present — GND, VDD and DATA. Matches makeControllerSymbol.
 */
export function controllerPinNumbers(rows, cols, hasLeds) {
  const total = rows + cols + (hasLeds ? 3 : 0)
  return Array.from({ length: total }, (_, i) => String(i + 1))
}

/** Pin pitch of the controller symbol, in mm. Used by the schematic layout. */
export const CTRL_PITCH = 2.54

/**
 * Generic controller block: row pins down the left edge, column pins down the
 * right, GND on the left and VDD/DATA on the right when LEDs are present.
 * Schematic-only — it is not placed on the board.
 */
export function makeControllerSymbol(rows, cols, hasLeds) {
  const leftNames = [...Array.from({ length: rows }, (_, i) => `ROW${i}`), ...(hasLeds ? ['GND'] : [])]
  const rightNames = [
    ...Array.from({ length: cols }, (_, j) => `COL${j}`),
    ...(hasLeds ? ['VDD', 'DATA'] : [])
  ]
  const maxCount = Math.max(leftNames.length, rightNames.length, 1)
  const topY = ((maxCount - 1) / 2) * CTRL_PITCH
  const halfW = 12.7

  // Pin numbers run rows, then columns, then GND, VDD, DATA — hence the
  // interleaved ordering here (GND is the last left pin but not the last pin).
  const numbers = {}
  let n = 0
  for (let i = 0; i < rows; i++) numbers[`ROW${i}`] = String(++n)
  for (let j = 0; j < cols; j++) numbers[`COL${j}`] = String(++n)
  if (hasLeds) {
    numbers.GND = String(++n)
    numbers.VDD = String(++n)
    numbers.DATA = String(++n)
  }

  const pins = []
  leftNames.forEach((name, i) => {
    const type = name === 'GND' ? 'power_in' : 'passive'
    pins.push(pin(type, [-halfW - 2.54, topY - i * CTRL_PITCH, 0], 2.54, name, numbers[name]))
  })
  rightNames.forEach((name, i) => {
    // VDD is an input: the board is powered from that rail, and PWR_FLAG is the
    // only thing that declares it driven. Two power outputs on one net is an
    // ERC conflict.
    const type = name === 'VDD' ? 'power_in' : name === 'DATA' ? 'output' : 'passive'
    pins.push(pin(type, [halfW + 2.54, topY - i * CTRL_PITCH, 180], 2.54, name, numbers[name]))
  })

  const bodyTop = topY + CTRL_PITCH
  const bodyBottom = topY - (maxCount - 1) * CTRL_PITCH - CTRL_PITCH
  const body = list(
    'symbol',
    str('MCU_0_1'),
    rect([-halfW, bodyBottom], [halfW, bodyTop], 0.254, 'background'),
    ...pins
  )
  return list(
    'symbol',
    str('MCU'),
    list('pin_names', list('offset', atom(0.762))),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom('no')),
    list('on_board', atom('no')),
    symProp('Reference', 'U', 0, bodyTop + 2.54, 0),
    symProp('Value', 'Controller', 0, bodyBottom - 2.54, 0),
    symProp('Footprint', '', 0, bodyBottom - 5.08, 0, true),
    symProp('Datasheet', '', 0, bodyBottom - 7.62, 0, true),
    symProp('Description', 'Matrix controller connection point', 0, 0, 0, true),
    body
  )
}

/** ERC power flag — marks a net as driven. Not placed on the board. */
export function makePowerFlagSymbol() {
  const body = list(
    'symbol',
    str('PWR_FLAG_0_1'),
    polyline([[0, 0], [0, 1.27], [-1.016, 1.905], [0, 2.54], [1.016, 1.905], [0, 1.27]], 0.254),
    pin('power_out', [0, 0, 90], 0, 'pwr', '1')
  )
  return list(
    'symbol',
    str('PWR_FLAG'),
    hideYes('pin_numbers'),
    hideYes('pin_names', list('offset', atom(0))),
    list('exclude_from_sim', atom('yes')),
    list('in_bom', atom('no')),
    list('on_board', atom('no')),
    symProp('Reference', '#FLG', 0, 3.81, 0, true),
    symProp('Value', 'PWR_FLAG', 0, -1.27, 0),
    symProp('Footprint', '', 0, -3.81, 0, true),
    symProp('Datasheet', '', 0, -6.35, 0, true),
    symProp('Description', 'Power flag (ERC only)', 0, 0, 0, true),
    body
  )
}
