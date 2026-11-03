// hive-focus.mjs — the hive at 50 agents (#698, build step 4).
//
// docs/DESIGN_HIVE_CONSOLE.md, "At 50 agents". Find an agent narrows the grid to one agent's row and
// column. Its name panel then reads the column and the row as counts: the ✓ list stays open as
// chips, since that is the answer people look for, and every other state folds into a count that
// opens. Groups fold to one summary line. Every count comes from the same square states the grid
// draws (hive-square.mjs), passed in as `kindOf`, so the counts and the squares cannot disagree.
//
// Every count is the signed state: an unsigned change of yours is its own line, and never moves a
// count until you sign it. A square read only from your copy of Buzz's list is counted apart from
// the ones nvoy's rules answer, and says so.
//
// Pure: the page and the suite run the same words.

const READ = ['work', 'blocked']
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Agents whose name holds the query, or whose key starts with it. An empty query finds no one.
export function findAgents(rows, q, nameOf) {
  const query = String(q || '').trim().toLowerCase()
  if (!query) return []
  const hex = /^[0-9a-f]{4,64}$/.test(query)
  return rows.filter(r => nameOf(r.pubkey).toLowerCase().includes(query) || (hex && r.pubkey.startsWith(query)))
}

// The focused agent's column (who gives it work) and row (whom it gives work), each as the pubkeys
// in every state. kindOf(taker, giver) returns the square's signed kind, or null where the grid has
// none; changeOf(taker, giver) returns your unsigned 'add' or 'remove' for it, if any.
export function focusOf(pk, { rows, columns, kindOf, changeOf = () => null }) {
  const me = rows.find(r => r.pubkey === pk)
  if (!me) return null
  const tally = pairs => {
    const by = {}
    for (const [other, kind, change] of pairs) {
      if (kind && kind !== 'self') (by[kind] ||= []).push(other.pubkey)
      if (change) (by[change] ||= []).push(other.pubkey)
    }
    return by
  }
  const col = columns.find(t => t.pubkey === pk)
  return {
    pk,
    column: col ? tally(rows.filter(r => r.pubkey !== pk).map(r => [r, kindOf(col, r), changeOf(col, r)])) : null,
    row: tally(columns.filter(t => t.pubkey !== pk).map(t => [t, kindOf(t, me), changeOf(t, me)]).filter(([, k]) => k !== 'person')),
  }
}

const read = by => READ.flatMap(k => by[k] || [])
const glyphOf = (ok, by) => ok.length ? 'work' : by.copy?.length ? 'copy' : 'none'

// The words. Each line names its state, its count, and the pubkeys "Show them" opens. `glyph` is the
// square the head draws: ✓ only where nvoy's rules answer, the copy square where only your copy does.
export function focusLines(f, { nameOf }) {
  const name = nameOf(f.pk), you = name === 'you'
  const pending = (by, stop) => [
    by.remove?.length && { kind: 'remove', pks: by.remove, text: `${by.remove.length} you're stopping, not signed yet. Until you sign, nothing changes` },
    by.add?.length && { kind: 'add', pks: by.add, text: `${by.add.length} you're adding, not signed yet. Until you sign, ${stop}` },
  ]
  let column
  if (!f.column) column = { head: `${you ? 'You take' : `${name} takes`} no work through this page`, glyph: 'none', chips: [], rest: [] }
  else {
    const c = f.column, ok = read(c), it = you ? 'you' : 'it'
    column = {
      head: ok.length ? `${ok.length} can give ${it} work`
        : c.copy?.length ? `Only your copy of Buzz's list says anyone can give ${it} work` : `Nobody can give ${it} work`,
      glyph: glyphOf(ok, c),
      chips: ok,
      rest: [
        c.blocked?.length && { kind: 'blocked', pks: c.blocked, text: `${c.blocked.length} of those ${ok.length} ${it} can't answer back by name` },
        c.copy?.length && { kind: 'copy', pks: c.copy, text: `${c.copy.length} by your copy of Buzz's list. Buzz's own list isn't read` },
        c.none?.length && { kind: 'none', pks: c.none, text: `${c.none.length} ${it} won't act on what they say` },
        c.unknown?.length && { kind: 'unknown', pks: c.unknown, text: `${c.unknown.length} not known yet` },
        ...pending(c, `they can't`),
      ].filter(Boolean),
    }
  }
  const r = f.row, ok = read(r), gives = you ? 'You give' : 'It gives'
  const row = {
    head: ok.length ? `${gives} ${ok.length} work`
      : r.copy?.length ? `Only your copies of Buzz's lists say ${you ? 'you give' : 'it gives'} anyone work` : `${gives} nobody work`,
    glyph: glyphOf(ok, r),
    chips: ok,
    rest: [
      r.blocked?.length && { kind: 'blocked', pks: r.blocked, text: `${r.blocked.length} of those ${ok.length} can't answer back by name` },
      r.copy?.length && { kind: 'copy', pks: r.copy, text: `${r.copy.length} by your copies of Buzz's lists. Buzz's own lists aren't read` },
      r.none?.length && { kind: 'none', pks: r.none, text: `${r.none.length} won't act on ${you ? 'you' : 'it'}` },
      r.unknown?.length && { kind: 'unknown', pks: r.unknown, text: `${r.unknown.length} not known yet` },
      ...pending(r, `they won't act on ${you ? 'you' : 'it'}`),
    ].filter(Boolean),
  }
  return { column, row }
}

// One line per group when it folds: "Frontier lab harnesses · 3 agents · 4 give work", where the
// count is the signed ✓ squares across the group's rows, and squares only your copy of Buzz's list
// answers are counted after it.
export function groupLine(label, groupRows, { columns, kindOf }) {
  let n = 0, copy = 0
  for (const r of groupRows) for (const t of columns) {
    if (t.pubkey === r.pubkey) continue
    const k = kindOf(t, r)
    if (READ.includes(k)) n++
    else if (k === 'copy') copy++
  }
  return `${label} · ${plural(groupRows.length, 'agent', 'agents')} · ${n} give work${copy ? ` · ${copy} by your copy of Buzz` : ''}`
}

// Groups start folded once the grid has more rows than a screen holds.
export const FOLD_ABOVE = 30
export const foldedAtStart = rowCount => rowCount > FOLD_ABOVE
