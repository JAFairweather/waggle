// hive-seats.mjs — herd-cloud seats the other sources cannot see (waggle-dev, at Dead Rabbit's request).
//
// A seat is an agent that runs on herd-cloud and holds a Hive memory writer key, but has no Buzz channel,
// no agent card and no grant yet. The bridge roster, cards and grants all miss it, so the list never named
// it. Each seat here becomes ONE row, shown as "no Buzz channel" until the roster or a card names it.
//
// Two identities, kept apart (Hive hive-crusty-on-buzz-key-plan): `pubkey` is the Hive writer key the seat
// has now; `channel` is the Buzz channel identity onboarding creates later (null until the owner binds it).
// The row is keyed by `channel` once there is one, and the writer key is shown on it as the Hive writer, so
// joining Buzz moves the same row instead of leaving an old one behind. `group` is the table group it sits
// in (a PLATFORMS id) before and after. Add a seat when it is made; set `channel` when the bind is read back.
// Public keys only.
export const SEATS = Object.freeze([
  { pubkey: '664092127d52c6a8e2fb337d0f82b62a0490060d5725e19fea92ba9861ecbecc', channel: null, label: 'Crusty', harness: 'Pi', group: 'third-party' },
])
export const rowKeyOf = seat => seat.channel || seat.pubkey
export const NO_BUZZ = 'no Buzz channel'
