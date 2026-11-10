// hive-seats.mjs — herd-cloud seats the other sources cannot see (waggle-dev, at Dead Rabbit's request).
//
// A seat is an agent that runs on herd-cloud and holds a Hive memory writer key, but has no Buzz channel,
// no agent card and no grant yet. The bridge roster, cards and grants all miss it, so the list never named
// it. Each seat here becomes a row, shown as "no Buzz channel" until it has one. Add a seat when it is made
// (herd-infra add-agent knows the key); take it out only when the seat is retired. Public keys only.
export const SEATS = Object.freeze([
  { pubkey: '664092127d52c6a8e2fb337d0f82b62a0490060d5725e19fea92ba9861ecbecc', label: 'Crusty', harness: 'Pi', buzz: false },
])
export const NO_BUZZ = 'no Buzz channel'
