// Asset registry: bundles the provided KiCad footprints (raw text) and 3D
// models (URLs) into the app, plus a lightweight parser that extracts pad and
// model information used by the generator.

import { parse, op, children, child } from './sexpr.js'
import { ledPadFunction } from './ledpins.js'

// --- Footprints (raw .kicad_mod text) -------------------------------------
import swPts636 from '../../assets/kicad_footprints/SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS.kicad_mod?raw'
import swPts647 from '../../assets/kicad_footprints/SW_SPST_PTS647_Sx38.kicad_mod?raw'
import swPts815 from '../../assets/kicad_footprints/SW_SPST_PTS815.kicad_mod?raw'
import swB3u from '../../assets/kicad_footprints/SW_SPST_B3U-1000P-B.kicad_mod?raw'
import swTl3342 from '../../assets/kicad_footprints/SW_TL3342F160QG.kicad_mod?raw'
import swPush6 from '../../assets/kicad_footprints/SW_PUSH_6mm_H5mm.kicad_mod?raw'
import led5050 from '../../assets/kicad_footprints/WS2812B_5050.kicad_mod?raw'
import ledNarrow from '../../assets/kicad_footprints/WS2812B-NARROW.kicad_mod?raw'
import led2020 from '../../assets/kicad_footprints/WS2812-2020.kicad_mod?raw'
import led1615 from '../../assets/kicad_footprints/WS2812-1615.kicad_mod?raw'
import led3535 from '../../assets/kicad_footprints/LED3535.kicad_mod?raw'

// --- 3D models (URLs) ------------------------------------------------------
import mPts636 from '../../assets/kicad_models/SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS.step?url'
import mPts647 from '../../assets/kicad_models/SW_SPST_PTS647Sx38.step?url'
import mPts815 from '../../assets/kicad_models/PTS815SJK250.stp?url'
import mB3u from '../../assets/kicad_models/SW_SPST_B3U-1000P-B.step?url'
import mTl3342 from '../../assets/kicad_models/SW_SPST_TL3342.step?url'
import mPush6 from '../../assets/kicad_models/SW_PUSH_6mm_H5mm.step?url'
import mLed5050 from '../../assets/kicad_models/Led_WS2812B_5050.STEP?url'
import mLed2020 from '../../assets/kicad_models/Led_WS2812B_2020.STEP?url'
import mLed1615 from '../../assets/kicad_models/XL-1615RGB v2.step?url'
import mLed3535 from '../../assets/kicad_models/SMD WS2812B Mini 3535.step?url'

const FOOTPRINT_SOURCES = {
  SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS: swPts636,
  SW_SPST_PTS647_Sx38: swPts647,
  SW_SPST_PTS815: swPts815,
  SW_SPST_B3U_1000P_B: swB3u,
  SW_TL3342F160QG: swTl3342,
  SW_PUSH_6mm_H5mm: swPush6,
  WS2812B_5050: led5050,
  'WS2812B-NARROW': ledNarrow,
  'WS2812-2020': led2020,
  'WS2812-1615': led1615,
  LED3535: led3535
}

// basename -> URL
const MODEL_URLS = {
  'SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS.step': mPts636,
  'SW_SPST_PTS647Sx38.step': mPts647,
  'PTS815SJK250.stp': mPts815,
  'SW_SPST_B3U-1000P-B.step': mB3u,
  'SW_SPST_TL3342.step': mTl3342,
  'SW_PUSH_6mm_H5mm.step': mPush6,
  'Led_WS2812B_5050.STEP': mLed5050,
  'Led_WS2812B_2020.STEP': mLed2020,
  'XL-1615RGB v2.step': mLed1615,
  'SMD WS2812B Mini 3535.step': mLed3535
}

// Footprint pad-number -> logical WS2812 pin function, for footprints whose
// pads are numbered 1..4 without semantic names. Re-exported from ledpins.js.
export { ledPadFunction } from './ledpins.js'

export const SWITCH_FOOTPRINTS = [
  { name: 'SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS', label: 'PTS636 6×3.5 mm tactile (SMD)' },
  { name: 'SW_SPST_PTS647_Sx38', label: 'PTS647 4.5×3.5 mm tactile (SMD)' },
  { name: 'SW_SPST_PTS815', label: 'PTS815 4.5×2.6 mm tactile (SMD)' },
  { name: 'SW_SPST_B3U_1000P_B', label: 'B3U-1000P tactile (SMD)' },
  { name: 'SW_TL3342F160QG', label: 'TL3342 6×6 mm tactile (SMD)' },
  { name: 'SW_PUSH_6mm_H5mm', label: '6×6 mm tactile, H=5 mm (THT)' }
]

export const LED_FOOTPRINTS = [
  { name: 'WS2812B_5050', label: 'WS2812B 5050 (5.0×5.0 mm)' },
  { name: 'WS2812B-NARROW', label: 'WS2812B narrow (5050 slim)' },
  { name: 'WS2812-2020', label: 'WS2812B 2020 (2.0×2.0 mm)' },
  { name: 'WS2812-1615', label: 'WS2812B 1615 (1.6×1.5 mm)' },
  { name: 'LED3535', label: 'WS2812B 3535 (3.5×3.5 mm)' }
]

/** Parse a .kicad_mod source string into a tree + extracted metadata. */
export function parseFootprint(name, source) {
  const tree = parse(source)
  const pads = []
  for (const pad of children(tree, 'pad')) {
    const items = pad.items
    const number = items.length > 1 && (items[1].t === 'string' || items[1].t === 'atom') ? items[1].v : ''
    const type = items.length > 2 ? items[2].v : ''
    const atNode = child(pad, 'at')
    const sizeNode = child(pad, 'size')
    const layersNode = child(pad, 'layers')
    const pos = atNode ? { x: num(atNode.items[1]), y: num(atNode.items[2]) } : { x: 0, y: 0 }
    const size = sizeNode ? { w: num(sizeNode.items[1]), h: num(sizeNode.items[2]) } : { w: 1, h: 1 }
    const layers = layersNode ? layersNode.items.slice(1).map((it) => it.v) : []
    pads.push({ number, type, pos, size, layers })
  }
  const modelNode = child(tree, 'model')
  const modelPath = modelNode ? modelNode.items[1].v : ''
  return { name, tree, pads, modelPath }
}

function num(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** Build the runtime registry: { name -> parsed footprint }. */
export function buildRegistry() {
  const registry = {}
  for (const [name, source] of Object.entries(FOOTPRINT_SOURCES)) {
    registry[name] = parseFootprint(name, source)
  }
  return registry
}

/** Return the list of 3D model asset entries needed for a board config.
 *  Each entry: { path (inside project), basename, url } */
export function modelEntriesFor(registry, { switchFootprint, ledFootprint }) {
  const entries = []
  const seen = new Set()
  const add = (fpName) => {
    const fp = registry[fpName]
    if (!fp || !fp.modelPath) return
    const rel = fp.modelPath.replace('${KIPRJMOD}/', '').replace('${KICAD8_3DMODEL_DIR}/', '')
    if (seen.has(rel)) return
    const basename = rel.split('/').pop()
    const url = MODEL_URLS[basename]
    if (url) {
      seen.add(rel)
      entries.push({ path: rel, basename, url })
    }
  }
  if (switchFootprint) add(switchFootprint)
  if (ledFootprint) add(ledFootprint)
  return entries
}
