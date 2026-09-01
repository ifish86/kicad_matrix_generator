// Minimal S-expression parser/serializer for KiCad files.
//
// Trees are represented as plain objects:
//   { t: 'list',   items: Node[] }
//   { t: 'atom',   v: string }        // bare token (number, yes/no, keyword…)
//   { t: 'string', v: string }        // quoted "…" token
//
// The serializer preserves quoted-vs-unquoted tokens from parsing, so
// round-tripping an existing KiCad file is faithful.

export function parse(text) {
  const tokens = tokenize(text)
  let i = 0

  function next() {
    if (i >= tokens.length) throw new Error('Unexpected end of S-expression')
    return tokens[i++]
  }

  function read() {
    const tok = next()
    if (tok === '(') {
      const items = []
      while (tokens[i] !== ')') {
        if (i >= tokens.length) throw new Error('Unterminated list')
        items.push(read())
      }
      i++ // consume ')'
      return { t: 'list', items }
    }
    if (tok === ')') throw new Error('Unexpected ")"')
    if (tok.type === 'string') return { t: 'string', v: tok.value }
    return { t: 'atom', v: tok.value }
  }

  const tree = read()
  if (i !== tokens.length) throw new Error('Trailing tokens after root')
  return tree
}

function tokenize(text) {
  const tokens = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }
    if (c === ';') {
      // comment until end of line
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '(' || c === ')') {
      tokens.push(c)
      i++
      continue
    }
    if (c === '"') {
      i++
      let val = ''
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          val += text[i + 1]
          i += 2
        } else {
          val += text[i]
          i++
        }
      }
      i++ // closing quote
      tokens.push({ type: 'string', value: val })
      continue
    }
    // bare token
    let j = i
    while (j < n && !' \t\r\n()"'.includes(text[j])) j++
    tokens.push({ type: 'atom', value: text.slice(i, j) })
    i = j
  }
  return tokens
}

export function serialize(node, indent = 0) {
  const pad = '\t'.repeat(indent)
  if (node.t === 'atom') return node.v
  if (node.t === 'string') return `"${node.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  if (node.t === 'list') {
    if (node.items.length === 0) return '()'
    // Inline lists that contain no nested lists (compact, KiCad-like style).
    const hasSublist = node.items.some((it) => it.t === 'list')
    if (!hasSublist) {
      return '(' + node.items.map((it) => serialize(it, 0)).join(' ') + ')'
    }
    const parts = node.items.map((it) => serialize(it, indent + 1))
    return '(' + parts.join('\n' + pad + '\t') + ')'
  }
  throw new Error('Unknown node type')
}

// ---- Constructors ---------------------------------------------------------

export const atom = (v) => ({ t: 'atom', v: String(v) })
export const str = (v) => ({ t: 'string', v: String(v) })

// `list` accepts a mix of existing nodes and raw values; raw values (strings,
// numbers, booleans) are converted to atoms automatically.
export const list = (...items) => ({
  t: 'list',
  items: items.map((it) => {
    if (it && typeof it === 'object' && 't' in it) return it
    return { t: 'atom', v: String(it) }
  })
})

// ---- Helpers ---------------------------------------------------------------

/** First token of a list (its operator), as a string, or null. */
export function op(node) {
  if (!node || node.t !== 'list' || node.items.length === 0) return null
  const first = node.items[0]
  return first.t === 'atom' || first.t === 'string' ? first.v : null
}

/** All direct child lists whose operator matches `name`. */
export function children(node, name) {
  if (!node || node.t !== 'list') return []
  return node.items.filter((it) => it.t === 'list' && op(it) === name)
}

/** First direct child list whose operator matches `name`, or null. */
export function child(node, name) {
  const found = children(node, name)
  return found.length ? found[0] : null
}

/** Walk the tree depth-first, calling fn(node, parent) for every node. */
export function walk(node, fn, parent = null) {
  if (!node || node.t !== 'list') return
  fn(node, parent)
  for (const it of node.items) walk(it, fn, node)
}

export function clone(node) {
  if (node.t === 'list') return { t: 'list', items: node.items.map(clone) }
  return { ...node }
}
