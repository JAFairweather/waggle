// hive-focus.mjs — the hive at 50 agents (#698, build step 4).
//
// docs/DESIGN_HIVE_CONSOLE.md, "At 50 agents". Find an agent narrows the grid to one agent's row and
// column. Its name panel then reads the column and the row as counts: the ✓ list stays open as
// chips, since that is the answer people look for, and every other state folds into a count that
// opens. Groups fold to one summary line. Every count comes from the same square states the grid
// draws (hive-square.mjs), passed in as `kindOf`, so the counts and the squares cannot disagree.
//
// Pure: the page and the suite run the same words.

const GIVES = new Set(['work', 'copy', 'blocked'])
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Agents whose name holds the query, or whose key starts with it. An empty query finds no one.
export function findAgents(rows, q, nameOf) {
  const query = String(q || '').trim().toLowerCase()
  if (!query) return []
  const hex = /^[0-9a-f]{4,64}$/.test(query)
  return rows.filter(r => nameOf(r.pubkey).toLowerCase().includes(query) || (hex && r.pubkey.startsWith(query)))
}

// The focused agent's column (who gives it work) and row (whom it gives work), each as the pubkeys
// in every state. kindOf(taker, giver) returns the square's kind, or null where the grid has none.
export function focusOf(pk, { rows, columns, kindOf }) {
  const me = rows.find(r => r.pubkey === pk)
  if (!me) return null
  const tally = pairs => {
    const by = {}
    for (const [other, kind] of pairs) if (kind && kind !== 'self') (by[kind] ||= []).push(other.pubkey)
    return by
  }
  const col = columns.find(t => t.pubkey === pk)
  return {
    pk,
    column: col ? tally(rows.filter(r => r.pubkey !== pk).map(r => [r, kindOf(col, r)])) : null,
    row: tally(columns.filter(t => t.pubkey !== pk).map(t => [t, kindOf(t, me)]).filter(([, k]) => k !== 'person')),
  }
}

const gives = by => [...GIVES].flatMap(k => by[k] || [])

// The words. Each line names its state, its count, and the pubkeys "Show them" opens.
export function focusLines(f, { nameOf }) {
  const name = nameOf(f.pk)
  const changes = by => [...(by.add || []), ...(by.remove || [])]
  let column
  if (!f.column) column = { head: `${name === 'you' ? 'You take' : `${name} takes`} no work through this page`, chips: [], rest: [] }
  else {
    const ok = gives(f.column), c = f.column
    column = {
      head: ok.length ? `${ok.length} can give ${name === 'you' ? 'you' : 'it'} work` : `Nobody can give ${name === 'you' ? 'you' : 'it'} work`,
      chips: ok,
      rest: [
        c.blocked?.length && { kind: 'blocked', pks: c.blocked, text: `${c.blocked.length} of those ${ok.length} it can't answer back by name` },
        c.copy?.length && { kind: 'copy', pks: c.copy, text: `${c.copy.length} of those ${ok.length} come from your copy of Buzz's list` },
        c.none?.length && { kind: 'none', pks: c.none, text: `${c.none.length} it won't act on what they say` },
        c.unknown?.length && { kind: 'unknown', pks: c.unknown, text: `${c.unknown.length} not known yet` },
        changes(c).length && { kind: 'add', pks: changes(c), text: `${plural(changes(c).length, 'change', 'changes')} of yours, not signed yet` },
      ].filter(Boolean),
    }
  }
  const r = f.row, ok = gives(r)
  const row = {
    head: ok.length ? `${name === 'you' ? 'You give' : 'It gives'} ${ok.length} work` : `${name === 'you' ? 'You give' : 'It gives'} nobody work`,
    chips: ok,
    rest: [
      r.blocked?.length && { kind: 'blocked', pks: r.blocked, text: `${r.blocked.length} of those ${ok.length} can't answer back by name` },
      r.none?.length && { kind: 'none', pks: r.none, text: `${r.none.length} won't act on ${name === 'you' ? 'you' : 'it'}` },
      r.unknown?.length && { kind: 'unknown', pks: r.unknown, text: `${r.unknown.length} not known yet` },
      changes(r).length && { kind: 'add', pks: changes(r), text: `${plural(changes(r).length, 'change', 'changes')} of yours, not signed yet` },
    ].filter(Boolean),
  }
  return { column, row }
}

// One line per group when it folds: "Frontier lab harnesses · 3 agents · 4 give work", where the
// last count is the ✓ squares across the group's rows.
export function groupLine(label, groupRows, { columns, kindOf }) {
  let n = 0
  for (const r of groupRows) for (const t of columns) if (t.pubkey !== r.pubkey && GIVES.has(kindOf(t, r))) n++
  return `${label} · ${plural(groupRows.length, 'agent', 'agents')} · ${n} give work`
}

// Groups start folded once the grid has more rows than a screen holds.
export const FOLD_ABOVE = 30
export const foldedAtStart = rowCount => rowCount > FOLD_ABOVE
