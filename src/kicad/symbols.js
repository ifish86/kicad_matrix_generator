// Builds KiCad symbol definitions (used both in the .kicad_sym library and in
// the schematic's embedded lib_symbols section).

import { list, str, atom } from './sexpr.js'

const FONT = (size = 1.27) => list('font', list('size', atom(size), atom(size)))

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
  return list(
    'property',
    str(key),
    str(value),
    list('at', atom(x), atom(y), atom(angle)),
    effects
  )
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

function polyline(pts, width = 0.254) {
  const xyList = pts.map((p) => list('xy', atom(p[0]), atom(p[1])))
  return list(
    'polyline',
    list('pts', ...xyList),
    list('stroke', list('width', atom(width)), list('type', atom('default'))),
    list('fill', list('type', atom('none')))
  )
}

function circle(center, radius, width = 0.254, fillType = 'none') {
  return list(
    'circle',
    list('center', atom(center[0]), atom(center[1])),
    list('radius', atom(radius)),
    list('stroke', list('width', atom(width)), list('type', atom('default'))),
    list('fill', list('type', atom(fillType)))
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

/** Two-terminal SPST push-button — replica of KiCad's Switch:SW_Push. */
export function makeSwitchSymbol() {
  const body = list(
    'symbol',
    str('SW_Push_0_1'),
    circle([-2.032, 0], 0.508, 0),
    polyline([[0, 1.27], [0, 3.048]], 0),
    polyline([[2.54, 1.27], [-2.54, 1.27]], 0),
    circle([2.032, 0], 0.508, 0),
    pin('passive', [-5.08, 0, 0], 2.54, '1', '1'),
    pin('passive', [5.08, 0, 180], 2.54, '2', '2')
  )
  return list(
    'symbol',
    str('SW_Push'),
    list('pin_numbers', atom('hide')),
    list('pin_names', list('offset', atom(1.016)), atom('hide')),
    list('in_bom', atom('yes')),
    list('on_board', atom('yes')),
    symProp('Reference', 'SW', 1.27, 2.54, 0, { justify: 'left' }),
    symProp('Value', 'SW_Push', 0, -1.524, 0),
    symProp('Footprint', '', 0, 5.08, 0, true),
    symProp('Datasheet', '~', 0, 5.08, 0, true),
    body
  )
}

/** Small-signal diode (1N4148 style) — pin 1 cathode, pin 2 anode. */
export function makeDiodeSymbol() {
  const body = list(
    'symbol',
    str('D_Small_0_1'),
    polyline([[-0.762, -1.27], [1.27, 0], [-0.762, 1.27], [-0.762, -1.27]]),
    polyline([[1.27, -1.27], [1.27, 1.27]]),
    polyline([[-1.27, 0], [1.27, 0]]),
    pin('passive', [-2.54, 0, 0], 2.54, 'A', '2'),
    pin('passive', [2.54, 0, 180], 2.54, 'K', '1')
  )
  return list(
    'symbol',
    str('D_Small'),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom('yes')),
    list('on_board', atom('yes')),
    symProp('Reference', 'D', 0, -3.81),
    symProp('Value', '1N4148W', 0, 3.81),
    symProp('Footprint', '', 0, 5.08, 0, true),
    symProp('Datasheet', '', 0, 6.35, 0, true),
    body
  )
}

/**
 * Ordered pin-number list for the generic controller symbol. The order is
 * rows (R0..), columns (C0..), then — when LEDs are present — GND, VDD and
 * DATA. The symbol builder below lays out pins in this exact order.
 */
export function controllerPinNumbers(rows, cols, hasLeds) {
  const nums = []
  for (let i = 0; i < rows; i++) nums.push(String(nums.length + 1))
  for (let j = 0; j < cols; j++) nums.push(String(nums.length + 1))
  if (hasLeds) {
    nums.push(String(nums.length + 1)) // GND
    nums.push(String(nums.length + 1)) // VDD
    nums.push(String(nums.length + 1)) // DATA
  }
  return nums
}

/**
 * Generic microcontroller / controller block. Rows on the left edge, columns
 * on the right edge; GND/VDD/DATA are added when LEDs are present. This is a
 * schematic-only placeholder (not placed on the board).
 */
export function makeControllerSymbol(rows, cols, hasLeds) {
  const leftCount = rows + (hasLeds ? 1 : 0) // R0.. + GND
  const rightCount = cols + (hasLeds ? 2 : 0) // C0.. + VDD + DATA
  const maxCount = Math.max(leftCount, rightCount)
  const topY = ((maxCount - 1) / 2) * 2.54

  const pins = []
  let n = 0
  for (let i = 0; i < rows; i++) {
    n++
    pins.push(pin('passive', [-2.54, topY - i * 2.54, 0], 2.54, `R${i}`, String(n)))
  }
  for (let j = 0; j < cols; j++) {
    n++
    pins.push(pin('passive', [2.54, topY - j * 2.54, 180], 2.54, `C${j}`, String(n)))
  }
  if (hasLeds) {
    n++
    pins.push(pin('passive', [-2.54, topY - rows * 2.54, 0], 2.54, 'GND', String(n)))
    n++
    pins.push(pin('passive', [2.54, topY - cols * 2.54, 180], 2.54, 'VDD', String(n)))
    n++
    pins.push(pin('passive', [2.54, topY - (cols + 1) * 2.54, 180], 2.54, 'DATA', String(n)))
  }

  const bodyTop = topY + 1.27
  const bodyBottom = topY - (maxCount - 1) * 2.54 - 1.27
  const body = list(
    'symbol',
    str('MCU_0_1'),
    rect([-1.27, bodyBottom], [1.27, bodyTop]),
    polyline([[-1.27, bodyBottom], [1.27, bodyBottom], [1.27, bodyTop], [-1.27, bodyTop], [-1.27, bodyBottom]]),
    ...pins
  )
  return list(
    'symbol',
    str('MCU'),
    list('exclude_from_sim', atom('no')),
    list('in_bom', atom('no')),
    list('on_board', atom('no')),
    symProp('Reference', 'U', 0, bodyTop + 1.27),
    symProp('Value', 'Controller', 0, bodyBottom - 1.27),
    symProp('Footprint', '', 0, bodyBottom - 2.54, 0, true),
    symProp('Datasheet', '', 0, bodyBottom - 3.81, 0, true),
    body
  )
}

/** ERC power flag — marks a net as powered (no PCB footprint). */
export function makePowerFlagSymbol() {
  const body = list(
    'symbol',
    str('PWR_FLAG_0_1'),
    polyline([[0, 0], [0, 2.54]]),
    polyline([[-1.27, 1.27], [1.27, 1.27]]),
    pin('power_out', [0, 0, 90], 2.54, 'pwr', '1')
  )
  return list(
    'symbol',
    str('PWR_FLAG'),
    list('exclude_from_sim', atom('yes')),
    list('in_bom', atom('no')),
    list('on_board', atom('no')),
    symProp('Reference', '#FLG', 0, 3.81, 0, true),
    symProp('Value', 'PWR_FLAG', 0, -1.27, 0, true),
    symProp('Footprint', '', 0, -2.54, 0, true),
    symProp('Datasheet', '', 0, -3.81, 0, true),
    body
  )
}

/**
 * WS2812B symbol — replica of KiCad's LED:WS2812B (NeoPixel-style icon).
 * The visual is identical for every variant; only the pin numbers change per
 * footprint. `pins` maps each function to its pad number, e.g.
 * { VDD: '1-VDD', DOUT: '2-DOUT', GND: '3-GND', DIN: '4-DIN' }.
 * Pin placement follows the standard symbol:
 * VDD top, DOUT right, GND bottom, DIN left.
 */
export function makeLedSymbol(pins) {
  const stroke = (w) => list('stroke', list('width', atom(w)), list('type', atom('default')))
  const pline = (pts) =>
    list(
      'polyline',
      list('pts', ...pts.map((p) => list('xy', atom(p[0]), atom(p[1])))),
      stroke(0),
      list('fill', list('type', atom('none')))
    )
  const ledIcon = list(
    'symbol',
    str('WS2812B_0_1'),
    pline([[1.27, -3.556], [1.778, -3.556]]),
    pline([[1.27, -2.54], [1.778, -2.54]]),
    pline([[4.699, -3.556], [2.667, -3.556]]),
    pline([[2.286, -2.54], [1.27, -3.556], [1.27, -3.048]]),
    pline([[2.286, -1.524], [1.27, -2.54], [1.27, -2.032]]),
    pline([[3.683, -1.016], [3.683, -3.556], [3.683, -4.064]]),
    pline([[4.699, -1.524], [2.667, -1.524], [3.683, -3.556], [4.699, -1.524]]),
    list(
      'rectangle',
      list('start', atom(5.08), atom(5.08)),
      list('end', atom(-5.08), atom(-5.08)),
      stroke(0.254),
      list('fill', list('type', atom('background')))
    )
  )
  const altBody = list(
    'symbol',
    str('WS2812B_0_0'),
    list(
      'text',
      str('RGB'),
      list('at', atom(2.286), atom(-4.191), atom(0)),
      list('effects', list('font', list('size', atom(0.762), atom(0.762))))
    )
  )
  const pinsBody = list(
    'symbol',
    str('WS2812B_1_1'),
    pin('power_in', [0, 7.62, 270], 2.54, 'VDD', pins.VDD),
    pin('output', [7.62, 0, 180], 2.54, 'DOUT', pins.DOUT),
    pin('power_in', [0, -7.62, 90], 2.54, 'GND', pins.GND),
    pin('input', [-7.62, 0, 0], 2.54, 'DIN', pins.DIN)
  )
  return list(
    'symbol',
    str('WS2812B'),
    list('pin_names', list('offset', atom(0.254))),
    list('in_bom', atom('yes')),
    list('on_board', atom('yes')),
    symProp('Reference', 'D', 5.08, 5.715, 0, { justify: 'right bottom' }),
    symProp('Value', 'WS2812B', 1.27, -5.715, 0, { justify: 'left top' }),
    symProp('Footprint', '', 1.27, -7.62, 0, { justify: 'left top', hide: true }),
    symProp('Datasheet', 'https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf', 2.54, -9.525, 0, { justify: 'left top', hide: true }),
    altBody,
    ledIcon,
    pinsBody
  )
}
