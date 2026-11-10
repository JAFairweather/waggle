// hive-seats.mjs — herd-cloud seats the other sources cannot see (waggle-dev, at Dead Rabbit's request).
//
// A seat is an agent that runs on herd-cloud and holds a Hive memory writer key, but has no Buzz channel yet.
// The bridge roster, cards and grants all miss it, so the list never named it. Each seat here becomes ONE row,
// shown as "no Buzz channel" until the bridge roster names its row key. A card alone does not clear it: an agent
// publishes its card before it is in its rooms (nvoy onboard_run order), so it cannot yet receive a mention.
//
// Two identities, kept apart (Hive hive-crusty-on-buzz-key-plan):
//   pubkey   the Hive writer key the seat already has; it signs the seat's Hive saves and never changes here.
//   channel  the Buzz channel identity: the Bunker agent pubkey in the owner's signed add_agent setup request
//            (the `p` tag), NOT the SSH channel-ssh.pub key staged for the broker. It is null until that request is
//            signed, and is set from the signed request, which comes BEFORE the bind_runtime and the join.
// Before `channel` is set the row is keyed by `pubkey`. Once it is set the row is keyed by `channel` and shows the
// writer key on it, so joining Buzz moves the same row instead of leaving an old one behind. `group` is the table
// group (a PLATFORMS id) the row sits in before and after. Add a seat when it is made. Public keys only.
export const SEATS = Object.freeze([
  { pubkey: '664092127d52c6a8e2fb337d0f82b62a0490060d5725e19fea92ba9861ecbecc', channel: '331458f40dfeeaea9d68ff651b951d194ced876287e2808fe9bb4796ffef2a71', label: 'Crusty', harness: 'Pi', group: 'third-party' },
])
export const rowKeyOf = seat => seat.channel || seat.pubkey
export const NO_BUZZ = 'no Buzz channel'
