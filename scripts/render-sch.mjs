// Render a .kicad_sch to SVG, for eyeballing generated schematics without
// launching KiCad.  Usage: node scripts/render-sch.mjs <file.kicad_sch> [out.svg]
//
// It is a preview, not a faithful KiCad renderer: it draws the sheet border,
// symbol graphics, pins, wires, labels and text at their real coordinates,
// which is enough to see overlaps, gaps and anything sitting off the page.

import { readFileSync, writeFileSync } from 'node:fs'
import { parse, children, child, op } from '../src/kicad/sexpr.js'

const PAPER_MM = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] }
const n = (v) => parseFloat(v.v)
const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch])

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/render-sch.mjs <file.kicad_sch> [out.svg]')
  process.exit(2)
}
const out = process.argv[3] || file.replace(/\.kicad_sch$/, '.svg')
const sch = parse(readFileSync(file, 'utf8'))

const paper = child(sch, 'paper')
const [pw, ph] =
  paper.items[1].v === 'User' ? [n(paper.items[2]), n(paper.items[3])] : PAPER_MM[paper.items[1].v]

const libSyms = new Map()
for (const s of children(child(sch, 'lib_symbols'), 'symbol')) libSyms.set(s.items[1].v, s)

const svg = []
const push = (s) => svg.push(s)

// --- symbol graphics -------------------------------------------------------
// Library symbols use +Y up, the schematic +Y down, hence `iy - py` throughout.

function drawSymbolBody(sym, ix, iy) {
  const tx = (x) => (ix + x).toFixed(3)
  const ty = (y) => (iy - y).toFixed(3)
  const visit = (node) => {
    for (const it of node.items) {
      if (it.t !== 'list') continue
      switch (op(it)) {
        case 'rectangle': {
          const s = child(it, 'start')
          const e = child(it, 'end')
          const x1 = ix + n(s.items[1])
          const y1 = iy - n(s.items[2])
          const x2 = ix + n(e.items[1])
          const y2 = iy - n(e.items[2])
          const fill = child(it, 'fill')
          const ftype = fill ? child(fill, 'type').items[1].v : 'none'
          push(
            `<rect x="${Math.min(x1, x2).toFixed(3)}" y="${Math.min(y1, y2).toFixed(3)}" ` +
              `width="${Math.abs(x2 - x1).toFixed(3)}" height="${Math.abs(y2 - y1).toFixed(3)}" ` +
              `fill="${ftype === 'background' ? '#fffbe6' : 'none'}" stroke="#8b0000" stroke-width="0.2"/>`
          )
          break
        }
        case 'polyline': {
          const pts = children(child(it, 'pts'), 'xy')
            .map((xy) => `${tx(n(xy.items[1]))},${ty(n(xy.items[2]))}`)
            .join(' ')
          push(`<polyline points="${esc(pts)}" fill="none" stroke="#8b0000" stroke-width="0.2"/>`)
          break
        }
        case 'circle': {
          const c = child(it, 'center')
          push(
            `<circle cx="${tx(n(c.items[1]))}" cy="${ty(n(c.items[2]))}" ` +
              `r="${n(child(it, 'radius').items[1]).toFixed(3)}" fill="none" stroke="#8b0000" stroke-width="0.2"/>`
          )
          break
        }
        case 'text': {
          const at = child(it, 'at')
          push(
            `<text x="${tx(n(at.items[1]))}" y="${ty(n(at.items[2]))}" font-size="1.2" fill="#8b0000">` +
              `${esc(it.items[1].v)}</text>`
          )
          break
        }
        case 'pin': {
          const at = child(it, 'at')
          const px = n(at.items[1])
          const py = n(at.items[2])
          const rot = at.items[3] ? n(at.items[3]) : 0
          const len = n(child(it, 'length').items[1])
          const dx = rot === 0 ? len : rot === 180 ? -len : 0
          const dy = rot === 90 ? len : rot === 270 ? -len : 0
          push(
            `<line x1="${tx(px)}" y1="${ty(py)}" x2="${tx(px + dx)}" y2="${ty(py + dy)}" ` +
              `stroke="#8b0000" stroke-width="0.2"/>` +
              `<circle cx="${tx(px)}" cy="${ty(py)}" r="0.35" fill="none" stroke="#c00" stroke-width="0.12"/>`
          )
          break
        }
        case 'symbol':
          visit(it)
          break
        default:
          break
      }
    }
  }
  visit(sym)
}

// --- sheet -----------------------------------------------------------------
push(`<rect x="0" y="0" width="${pw}" height="${ph}" fill="#fffef8" stroke="#333" stroke-width="0.4"/>`)
push(
  `<rect x="5" y="5" width="${pw - 10}" height="${ph - 10}" fill="none" stroke="#999" stroke-width="0.2"/>`
)

for (const w of children(sch, 'wire')) {
  const pts = children(child(w, 'pts'), 'xy')
  push(
    `<line x1="${n(pts[0].items[1])}" y1="${n(pts[0].items[2])}" ` +
      `x2="${n(pts[1].items[1])}" y2="${n(pts[1].items[2])}" stroke="#006400" stroke-width="0.25"/>`
  )
}

for (const inst of children(sch, 'symbol')) {
  const libId = child(inst, 'lib_id').items[1].v
  const at = child(inst, 'at')
  const ix = n(at.items[1])
  const iy = n(at.items[2])
  if (libSyms.has(libId)) drawSymbolBody(libSyms.get(libId), ix, iy)
  for (const prop of children(inst, 'property')) {
    const effects = child(prop, 'effects')
    if (effects && child(effects, 'hide')) continue
    const pat = child(prop, 'at')
    push(
      `<text x="${n(pat.items[1])}" y="${n(pat.items[2])}" font-size="1.2" fill="#004a7c" ` +
        `text-anchor="middle">${esc(prop.items[2].v)}</text>`
    )
  }
}

for (const kind of ['label', 'global_label', 'hierarchical_label']) {
  for (const l of children(sch, kind)) {
    const at = child(l, 'at')
    const x = n(at.items[1])
    const y = n(at.items[2])
    const rot = at.items[3] ? n(at.items[3]) : 0
    const color = kind === 'label' ? '#8B008B' : '#b8860b'
    const anchor = rot === 180 ? 'end' : 'start'
    push(
      `<g transform="translate(${x},${y}) rotate(${rot === 180 ? 0 : -rot})">` +
        `<circle r="0.4" fill="${color}"/>` +
        `<text x="${rot === 180 ? -1 : 1}" y="-0.6" font-size="1.3" fill="${color}" ` +
        `text-anchor="${anchor}">${esc(l.items[1].v)}</text></g>`
    )
  }
}

for (const t of children(sch, 'text')) {
  const at = child(t, 'at')
  const size = child(child(t, 'effects'), 'font')
  const fs = size ? n(child(size, 'size').items[1]) : 2
  push(
    `<text x="${n(at.items[1])}" y="${n(at.items[2])}" font-size="${fs}" fill="#111" ` +
      `font-weight="bold">${esc(t.items[1].v)}</text>`
  )
}

writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw} ${ph}" width="${pw * 3}" height="${ph * 3}" ` +
    `font-family="DejaVu Sans, sans-serif">\n${svg.join('\n')}\n</svg>\n`
)
console.log(`${out}  (${paper.items[1].v}, ${pw}×${ph} mm, ${children(sch, 'symbol').length} symbols)`)
