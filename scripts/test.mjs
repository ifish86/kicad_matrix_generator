// Quick validation of the KiCad generator, runnable in plain Node (no Vite).
// Builds a footprint registry from the real assets, generates a project for
// every board type, and sanity-checks the output.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, serialize, children, child, op } from '../src/kicad/sexpr.js'
import { generateProject, computeLayout } from '../src/kicad/generator.js'
import { parseSymbolLibrary, SWITCH_SYMBOL_FOR, LED_SYMBOL_FOR } from '../src/kicad/symbols.js'

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

const symlib = parseSymbolLibrary(readFileSync(join(ROOT, 'assets/kicad_matrix.kicad_sym'), 'utf8'))

const PAPER_MM = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] }
const GRID = 1.27
const key = (x, y) => `${x.toFixed(3)},${y.toFixed(3)}`
const numOf = (n) => parseFloat(n.v)

function pageSize(sch) {
  const paper = child(sch, 'paper')
  const name = paper.items[1].v
  if (name === 'User') return [numOf(paper.items[2]), numOf(paper.items[3])]
  if (!PAPER_MM[name]) throw new Error(`unknown paper ${name}`)
  return PAPER_MM[name]
}

/** Pins of a lib_symbols entry, in library coordinates (+Y up). */
function libPins(symNode) {
  const pins = []
  const visit = (node) => {
    for (const it of node.items) {
      if (it.t !== 'list') continue
      if (op(it) === 'pin') {
        const at = child(it, 'at')
        const number = child(it, 'number')
        pins.push({ x: numOf(at.items[1]), y: numOf(at.items[2]), number: number.items[1].v })
      } else if (op(it) === 'symbol') visit(it)
    }
  }
  visit(symNode)
  return pins
}

/**
 * Geometric audit of a schematic: everything on the sheet, on the grid, and
 * every pin actually wired to something. These are exactly the properties that
 * were silently broken when coordinates were emitted in mils.
 */
function checkSchematic(sch, label) {
  const [pw, ph] = pageSize(sch)
  const libSyms = new Map()
  for (const s of children(child(sch, 'lib_symbols'), 'symbol')) libSyms.set(s.items[1].v, s)

  const onGrid = (v) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-6
  const inPage = (x, y) => x >= 0 && y >= 0 && x <= pw && y <= ph

  // wire endpoints and label anchors are the points a pin may connect to
  const endpoints = new Map()
  const addEndpoint = (x, y) => endpoints.set(key(x, y), (endpoints.get(key(x, y)) || 0) + 1)

  for (const w of children(sch, 'wire')) {
    for (const xy of children(child(w, 'pts'), 'xy')) {
      const x = numOf(xy.items[1])
      const y = numOf(xy.items[2])
      addEndpoint(x, y)
      assert(inPage(x, y), `${label}: wire endpoint ${x},${y} off the ${pw}×${ph} sheet`)
      assert(onGrid(x) && onGrid(y), `${label}: wire endpoint ${x},${y} off the 1.27 mm grid`)
    }
  }

  const anchors = new Set()
  for (const kind of ['label', 'global_label', 'hierarchical_label']) {
    for (const l of children(sch, kind)) {
      const at = child(l, 'at')
      const x = numOf(at.items[1])
      const y = numOf(at.items[2])
      anchors.add(key(x, y))
      assert(inPage(x, y), `${label}: ${kind} "${l.items[1].v}" at ${x},${y} off the sheet`)
      assert(onGrid(x) && onGrid(y), `${label}: ${kind} "${l.items[1].v}" at ${x},${y} off grid`)
    }
  }

  let pinCount = 0
  for (const inst of children(sch, 'symbol')) {
    const libId = child(inst, 'lib_id').items[1].v
    const at = child(inst, 'at')
    const ix = numOf(at.items[1])
    const iy = numOf(at.items[2])
    assert(libSyms.has(libId), `${label}: ${libId} missing from lib_symbols`)
    assert(inPage(ix, iy), `${label}: ${libId} placed at ${ix},${iy} off the ${pw}×${ph} sheet`)
    assert(onGrid(ix) && onGrid(iy), `${label}: ${libId} at ${ix},${iy} off the 1.27 mm grid`)
    if (!libSyms.has(libId)) continue

    const pins = libPins(libSyms.get(libId))
    const declared = children(inst, 'pin').map((p) => p.items[1].v).sort()
    const actual = pins.map((p) => p.number).sort()
    assert(
      JSON.stringify(declared) === JSON.stringify(actual),
      `${label}: ${libId} instance pins [${declared}] != symbol pins [${actual}]`
    )

    for (const p of pins) {
      // schematics use +Y down, symbols +Y up
      const px = Number((ix + p.x).toFixed(4))
      const py = Number((iy - p.y).toFixed(4))
      pinCount++
      assert(inPage(px, py), `${label}: ${libId} pin ${p.number} at ${px},${py} off the sheet`)
      assert(
        endpoints.has(key(px, py)) || anchors.has(key(px, py)),
        `${label}: ${libId} pin ${p.number} at ${px},${py} is not connected to a wire`
      )
    }
  }

  // every wire endpoint must land on a pin, a label, or another wire
  const pinPoints = new Set()
  for (const inst of children(sch, 'symbol')) {
    const libId = child(inst, 'lib_id').items[1].v
    if (!libSyms.has(libId)) continue
    const at = child(inst, 'at')
    const ix = numOf(at.items[1])
    const iy = numOf(at.items[2])
    for (const p of libPins(libSyms.get(libId))) {
      pinPoints.add(key(Number((ix + p.x).toFixed(4)), Number((iy - p.y).toFixed(4))))
    }
  }
  for (const [pt, count] of endpoints) {
    assert(
      pinPoints.has(pt) || anchors.has(pt) || count > 1,
      `${label}: wire end ${pt} dangles (no pin, label or wire there)`
    )
  }

  assert(!serialize(sch).includes('embedded_fonts'), `${label}: KiCad 9-only embedded_fonts token present`)
  return { paper: `${pw}×${ph}`, pins: pinCount, symbols: children(sch, 'symbol').length }
}


/**
 * Rough text-overlap check. KiCad will happily draw two labels on top of each
 * other; the geometry checks above cannot see it, but it makes a schematic
 * unreadable, which is half of what was wrong before.
 */
function checkTextOverlap(sch, label) {
  const boxes = []
  const add = (text, x, y, size, angle, anchor) => {
    if (!text) return
    const w = text.length * size * 0.75
    const h = size * 1.2
    let box = { x1: x, y1: y - h, x2: x + w, y2: y }
    if (anchor === 'end') box = { x1: x - w, y1: y - h, x2: x, y2: y }
    if (angle === 90) box = { x1: x - h / 2, y1: y - w, x2: x + h / 2, y2: y }
    if (angle === 270) box = { x1: x - h / 2, y1: y, x2: x + h / 2, y2: y + w }
    boxes.push({ text, ...box })
  }
  for (const inst of children(sch, 'symbol')) {
    for (const prop of children(inst, 'property')) {
      const eff = child(prop, 'effects')
      if (eff && child(eff, 'hide')) continue
      const at = child(prop, 'at')
      add(prop.items[2].v, numOf(at.items[1]), numOf(at.items[2]), 1.27, 0, 'start')
    }
  }
  for (const kind of ['label', 'global_label']) {
    for (const l of children(sch, kind)) {
      const at = child(l, 'at')
      const rot = at.items[3] ? numOf(at.items[3]) : 0
      add(l.items[1].v, numOf(at.items[1]), numOf(at.items[2]), 1.27, rot, rot === 180 ? 'end' : 'start')
    }
  }
  for (const t of children(sch, 'text')) {
    const at = child(t, 'at')
    add(t.items[1].v, numOf(at.items[1]), numOf(at.items[2]), 2.54, 0, 'start')
  }
  boxes.sort((a, b) => a.y1 - b.y1)
  let overlaps = 0
  let example = null
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].y1 < boxes[i].y2; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x1 < b.x2 && b.x1 < a.x2) {
        overlaps++
        if (!example) example = `"${a.text}" over "${b.text}" at ${a.x1.toFixed(1)},${a.y1.toFixed(1)}`
      }
    }
  }
  assert(overlaps === 0, `${label}: ${overlaps} overlapping text items (${example})`)
  return overlaps
}

/** Net names the schematic declares, via its labels. */
function schematicNets(sch) {
  const names = new Set()
  for (const kind of ['label', 'global_label']) {
    for (const l of children(sch, kind)) names.add(l.items[1].v)
  }
  return names
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
  const project = generateProject(cfg, registry, symlib)

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

  // schematic geometry: on the sheet, on the grid, every pin wired
  const audit = checkSchematic(sch, type)
  checkTextOverlap(sch, type)
  console.log(`  sheet ${audit.paper} mm, ${audit.pins} pins wired`)

  // the board's nets and the schematic's labels must agree, or the netlist
  // silently diverges between schematic and PCB
  const schNets = schematicNets(sch)
  for (const name of netNames) {
    if (name === '') continue
    assert(schNets.has(name), `net ${name} exists on the board but has no schematic label`)
  }
  for (const name of schNets) {
    assert(netNames.has(name), `schematic label ${name} has no matching board net`)
  }

  // the standalone .kicad_sym must define every symbol the schematic uses,
  // under the bare name half of its lib_id
  const symLib = parse(project.files.find((f) => f.path.endsWith('.kicad_sym')).content)
  const defined = new Set(children(symLib, 'symbol').map((x) => x.items[1].v))
  for (const inst of children(sch, 'symbol')) {
    const [libName, symName] = child(inst, 'lib_id').items[1].v.split(':')
    assert(libName === 'test_board', `lib_id library is ${libName}`)
    assert(defined.has(symName), `${symName} missing from test_board.kicad_sym`)
  }

  // the project must be able to resolve its own lib_ids
  const symTable = project.files.find((f) => f.path.endsWith('sym-lib-table'))
  const fpTable = project.files.find((f) => f.path.endsWith('fp-lib-table'))
  assert(symTable && symTable.content.includes('test_board.kicad_sym'), 'sym-lib-table present')
  assert(fpTable && fpTable.content.includes('test_board.pretty'), 'fp-lib-table present')

  // every .kicad_mod file name must match the footprint name inside it
  for (const f of project.files.filter((x) => x.path.endsWith('.kicad_mod'))) {
    const base = f.path.split('/').pop().replace('.kicad_mod', '')
    const inner = parse(f.content).items[1].v
    assert(base === inner, `${base}.kicad_mod declares footprint "${inner}"`)
  }

  // layout preview
  const layout = computeLayout(cfg, registry)
  assert(Number.isFinite(layout.width) && layout.width > 0, 'layout width')
  assert(layout.switches.length + layout.leds.length > 0, 'layout has components')
  console.log(`  board ${layout.width.toFixed(2)} × ${layout.height.toFixed(2)} mm`)
}


// ---------------------------------------------------------------------------
// Coverage sweep: every footprint pairing, and the matrix sizes that bracket
// the single-sheet limit. Guards against the schematic drifting off the sheet
// again for a combination nobody happened to try.

console.log('\n=== coverage sweep ===')
let sweepOk = 0
let sweepOver = 0
for (const sw of Object.keys(SWITCH_SYMBOL_FOR)) {
  for (const led of Object.keys(LED_SYMBOL_FOR)) {
    for (const [rows, cols] of [[1, 1], [4, 5], [6, 14], [12, 12]]) {
      for (const type of ['switches', 'leds', 'hybrid']) {
        const cfg = { name: 'sweep', type, rows, cols, switchFootprint: sw, ledFootprint: led }
        let project
        try {
          project = generateProject(cfg, registry, symlib)
        } catch (e) {
          // over the single-sheet limit is a documented, explicit outcome
          if (/larger than KiCad/.test(e.message)) {
            sweepOver++
            continue
          }
          failures++
          console.error(`  ✗ ${type} ${rows}x${cols} ${sw}/${led}: ${e.message}`)
          continue
        }
        const sch = parse(project.files.find((f) => f.path.endsWith('.kicad_sch')).content)
        const tag = `${type} ${rows}x${cols} ${sw}/${led}`
        checkSchematic(sch, tag)
        checkTextOverlap(sch, tag)
        sweepOk++
      }
    }
  }
}
console.log(`  ${sweepOk} configurations validated, ${sweepOver} correctly rejected as over-size`)

// realistic large boards, where the longest net names appear
for (const [type, rows, cols] of [['hybrid', 6, 15], ['leds', 16, 40], ['switches', 32, 40]]) {
  const project = generateProject({ name: 'large', type, rows, cols }, registry, symlib)
  const sch = parse(project.files.find((f) => f.path.endsWith('.kicad_sch')).content)
  const audit = checkSchematic(sch, `large ${type} ${rows}x${cols}`)
  checkTextOverlap(sch, `large ${type} ${rows}x${cols}`)
  console.log(`  ${type} ${rows}x${cols}: ${audit.symbols} symbols on a ${audit.paper} mm sheet`)
}

// the over-size guard must actually fire, and must not fire on sane sizes
let rejected = false
try {
  generateProject({ name: 'big', type: 'hybrid', rows: 32, cols: 40 }, registry, symlib)
} catch (e) {
  rejected = /larger than KiCad/.test(e.message)
}
assert(rejected, '32x40 hybrid is rejected with the over-size message')
try {
  generateProject({ name: 'kbd', type: 'hybrid', rows: 6, cols: 15 }, registry, symlib)
} catch (e) {
  failures++
  console.error(`  ✗ a 6x15 hybrid keyboard should generate: ${e.message}`)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
