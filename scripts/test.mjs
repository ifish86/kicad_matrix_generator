// Quick validation of the KiCad generator, runnable in plain Node (no Vite).
// Builds a footprint registry from the real assets, generates a project for
// every board type, and sanity-checks the output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, serialize, children, child } from '../src/kicad/sexpr.js'
import { generateProject, computeLayout } from '../src/kicad/generator.js'

const ROOT = new URL('..', import.meta.url).pathname
const FP_DIR = join(ROOT, 'assets/kicad_footprints')

function num(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function parseFootprint(name, source) {
  const tree = parse(source)
  const pads = []
  for (const pad of children(tree, 'pad')) {
    const number = pad.items.length > 1 ? pad.items[1].v : ''
    const atNode = child(pad, 'at')
    const sizeNode = child(pad, 'size')
    pads.push({
      number,
      pos: { x: num(atNode.items[1].v), y: num(atNode.items[2].v) },
      size: { w: num(sizeNode.items[1].v), h: num(sizeNode.items[2].v) }
    })
  }
  const modelNode = child(tree, 'model')
  return { name, tree, pads, modelPath: modelNode ? modelNode.items[1].v : '' }
}

const registry = {}
for (const f of [
  'SW_Tactile_SPST_NO_Straight_CK_PTS636Sx25SMTRLFS',
  'SW_SPST_PTS647_Sx38',
  'SW_SPST_PTS815',
  'SW_SPST_B3U-1000P-B',
  'SW_TL3342F160QG',
  'SW_PUSH_6mm_H5mm',
  'WS2812B_5050',
  'WS2812B-NARROW',
  'WS2812-2020',
  'WS2812-1615',
  'LED3535'
]) {
  registry[f] = parseFootprint(f, readFileSync(join(FP_DIR, `${f}.kicad_mod`), 'utf8'))
}

let failures = 0
function assert(cond, msg) {
  if (!cond) {
    failures++
    console.error('  ✗', msg)
  }
}

for (const type of ['switches', 'leds', 'hybrid']) {
  console.log(`\n=== type: ${type} ===`)
  const cfg = { name: 'test_board', type, rows: 3, cols: 4 }
  const project = generateProject(cfg, registry)

  const outDir = join(ROOT, 'tmp_test', type)
  mkdirSync(outDir, { recursive: true })
  for (const f of project.files) {
    const rel = f.path.replace('test_board/', '')
    const target = join(outDir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, f.content)
  }

  // every emitted s-expression parses and round-trips
  for (const f of project.files) {
    if (f.path.endsWith('.kicad_sch') || f.path.endsWith('.kicad_pcb') || f.path.endsWith('.kicad_sym') || f.path.endsWith('.kicad_mod')) {
      try {
        const t = parse(f.content)
        const rt = serialize(t)
        assert(typeof rt === 'string' && rt.length > 0, `${f.path} round-trip`)
      } catch (e) {
        failures++
        console.error(`  ✗ ${f.path} failed to parse:`, e.message)
      }
    }
  }

  const pro = project.files.find((f) => f.path.endsWith('.kicad_pro'))
  const proJson = JSON.parse(pro.content)
  assert(proJson.meta && proJson.meta.version === 1, 'pro meta version')
  assert(proJson.sheets && proJson.sheets.length === 1, 'pro has one sheet')
  assert(proJson.libraries.pinned_footprint_libs.length === 1, 'pinned footprint lib')
  assert(proJson.libraries.pinned_symbol_libs.length === 1, 'pinned symbol lib')

  const pcb = parse(project.files.find((f) => f.path.endsWith('.kicad_pcb')).content)
  const sch = parse(project.files.find((f) => f.path.endsWith('.kicad_sch')).content)

  const fpCount = children(pcb, 'footprint').length
  const schSymCount = children(sch, 'symbol').length
  const netNodes = children(pcb, 'net').length
  console.log(`  footprints=${fpCount} symbols=${schSymCount} nets=${netNodes - 1}`)

  const expectFootprints = type === 'hybrid' ? 12 * 2 + 12 : type === 'switches' ? 12 * 2 : 12
  assert(fpCount === expectFootprints, `footprint count ${fpCount} == ${expectFootprints}`)
  assert(schSymCount > 0, 'schematic has symbols')

  // every pad net reference must exist in the net list
  const netNames = new Set()
  for (const n of children(pcb, 'net')) netNames.add(n.items[2].v)
  for (const fp of children(pcb, 'footprint')) {
    for (const pad of children(fp, 'pad')) {
      const net = child(pad, 'net')
      if (net) assert(netNames.has(net.items[2].v), `pad net ${net.items[2].v} defined`)
    }
  }

  // layout preview
  const layout = computeLayout(cfg, registry)
  assert(Number.isFinite(layout.width) && layout.width > 0, 'layout width')
  assert(layout.switches.length + layout.leds.length > 0, 'layout has components')
  console.log(`  board ${layout.width.toFixed(2)} × ${layout.height.toFixed(2)} mm`)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
