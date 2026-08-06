// Nvoy's universal capability plane discovers Waggle's public 440/441 events directly.
// There is no second index write for keyless capability grants: the proof is a cold, exact-id
// relay read after publication. A relay OK is not enough; OK-and-drop is a known failure mode.

export async function verifyNvoyVisibility({ relays, event, query, verify }) {
  const reads = await Promise.all(relays.map(url => query(url, { ids: [event.id], limit: 1 })))
  let visible = 0, answered = 0
  for (const read of reads) {
    if (read?.answered) answered++
    if ((read?.out || []).some(found => found?.id === event.id && found.pubkey === event.pubkey &&
        found.kind === event.kind && verify(found))) visible++
  }
  return { visible, answered, total: relays.length }
}
