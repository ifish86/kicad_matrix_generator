// WS2812 footprint pad-number -> logical pin function mapping.
//
// Footprints whose pads are numbered 1..4 without semantic names are mapped by
// matching pad positions against the known WS2812B_5050 geometry
// (top-right = VDD, bottom-right = DOUT, bottom-left = GND, top-left = DIN).

export const LED_PIN_MAPS = {
  'WS2812-1615': { 1: 'DIN', 2: 'VDD', 3: 'DOUT', 4: 'GND' },
  LED3535: { 1: 'GND', 2: 'DIN', 3: 'VDD', 4: 'DOUT' }
}

export const DEFAULT_LED_MAP = { 1: 'VDD', 2: 'DOUT', 3: 'GND', 4: 'DIN' }

/** Determine the logical function of a WS2812 footprint pad. */
export function ledPadFunction(footprintName, padNumber) {
  const up = String(padNumber).toUpperCase()
  if (up.includes('VDD')) return 'VDD'
  if (up.includes('DOUT')) return 'DOUT'
  if (up.includes('GND')) return 'GND'
  if (up.includes('DIN')) return 'DIN'
  const map = LED_PIN_MAPS[footprintName] || DEFAULT_LED_MAP
  return map[padNumber] || null
}
