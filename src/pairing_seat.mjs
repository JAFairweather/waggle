// pairing_seat.mjs — the three decisions `tools/join.mjs` makes after custody is proved (#489).
//
// They live here because the review of #491 found every defect in the tool and none in the module,
// and that was not a coincidence: `tools/join.mjs` runs its whole ceremony at import, so nothing in
// `tests/` could reach any of it. Extracting the decisions does not remove the untested surface —
// it moves it to the call site, where what is left is wiring rather than judgement.

/**
 * What a `--seat <dir>` write consists of, and whether it may proceed.
 *
 * THE IDENTITY IS PART OF THE SEAT, and this is the whole reason the function exists. The ceremony
 * proves the bunker signs as `A` and then, before this fix, wrote only the URI and the client key —
 * spending the proof instead of carrying it. Nothing recoverable from those two files names `A`:
 * the `bunker://<hex>` is the remote SIGNER's address, and NIP-46 permits it to differ from the
 * identity it signs with. So the next session has nothing to pin to, and `relay_invite_signer.mjs`
 * then pins to whatever the bunker REPORTS — consistently, verifiably, to the wrong key if the
 * bunker holds more than one. Silent, and green all the way down.
 *
 * REFUSES RATHER THAN OVERWRITES, per the rule `tools/connect-agent.mjs` states for every other
 * credential in this repo: an existing credential is left exactly as found. `--seat` aimed at a
 * live agent's directory would otherwise clobber a working pairing unrecoverably — and, before the
 * identity file existed, could not even tell you which identity it had destroyed.
 *
 * Pure: the caller passes the names already on disk. That keeps both branches assertable without a
 * temp dir, and keeps the refusal reason — which is the thing an operator acts on — under test.
 *
 * @param {object} seat
 * @param {string} seat.identityPubkey  64-hex `A`, the pubkey custody was proved against
 * @param {string} seat.pairingUri      the `bunker://` URI
 * @param {string} seat.clientNsec      this session's half of the pairing
 * @param {string[]} [seat.present]     file names already in the seat directory
 * @returns {{ok: true, files: Array<{name: string, value: string}>}|{ok: false, reason: string}}
 */
export function seatPlan({ identityPubkey, pairingUri, clientNsec, present = [] } = {}) {
  const hex = String(identityPubkey || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'seatPlan needs the 64-hex identity custody was proved against' }
  if (!pairingUri) return { ok: false, reason: 'seatPlan needs the pairing URI' }
  if (!clientNsec) return { ok: false, reason: 'seatPlan needs the client key' }

  const files = [
    { name: 'identity', value: hex },
    { name: 'bunker-uri', value: String(pairingUri) },
    { name: 'bunker-client', value: String(clientNsec) },
  ]

  // Any one of the three already present means this directory is somebody's seat. Refuse the whole
  // write — a partial seat is worse than none, because it reads as complete.
  const clash = files.map(f => f.name).filter(n => present.includes(n))
  if (clash.length) {
    return {
      ok: false,
      reason: `the seat directory already holds ${clash.sort().join(', ')} — refusing to overwrite a live pairing. `
        + 'Point --seat at an empty directory, or move the existing seat aside first.',
    }
  }
  return { ok: true, files }
}

/**
 * What to say when the wait ended with no usable token.
 *
 * `join: no pairing token arrived before the deadline` is FALSE when tokens arrived and were
 * refused, and false in the direction that costs the most: it sends the operator to look at the
 * relay when the fault is in the token they mis-sealed. Only the hive can produce a refused token
 * — strangers are dropped before decryption — so a refusal always means a typo or a stale mint.
 *
 * The two cases exit differently so a script can tell them apart, which is the point of asserting
 * the reason rather than only the refusal.
 *
 * @param {number} refusals  how many tokens arrived from the hive and were refused
 * @returns {{exitCode: number, lines: string[]}}
 */
export function timeoutReport(refusals = 0) {
  const n = Number(refusals) || 0
  if (n > 0) {
    return {
      exitCode: 5,
      lines: [
        `${n} pairing token${n === 1 ? '' : 's'} arrived from the hive and ${n === 1 ? 'was' : 'were'} refused — see the reasons above.`,
        'The relay carried them, so the fault is in the token, not the lane: ask the owner to reseal',
        'against a fresh request id. The request key is burned, so the ones already sent are dead.',
      ],
    }
  }
  return {
    exitCode: 4,
    lines: [
      'no pairing token arrived before the deadline. The request key is burned, so a',
      'token sealed to it now can never be opened — ask the owner to approve again',
      'and run this command fresh. Grants issued in the meantime are still live.',
    ],
  }
}

/**
 * Resolve with the FIRST truthy result among `tasks`, cancelling the losers; null if every task
 * resolves falsy or throws.
 *
 * `Promise.all` was the bug. Each relay listener holds its own timer and resolves `null` AT THE
 * DEADLINE, so waiting for all of them put the full `--wait` window (900s by default, four relays)
 * between the token landing and the custody challenge starting. The happy path — owner approves,
 * token arrives in seconds — sat idle for fifteen minutes, and a short-expiry pairing could go
 * stale in the gap between "opened" and "used".
 *
 * @param {Array<(reg: {onCancel: (fn: Function) => void}) => Promise<any>>} tasks
 * @returns {Promise<any>}
 */
export function firstTruthy(tasks) {
  return new Promise(resolve => {
    if (!Array.isArray(tasks) || tasks.length === 0) return resolve(null)
    let settled = false
    let outstanding = tasks.length
    const cancellers = []
    const finish = value => {
      if (settled) return
      settled = true
      for (const c of cancellers) { try { c() } catch {} }
      resolve(value)
    }
    for (const task of tasks) {
      const reg = { onCancel(fn) { if (typeof fn === 'function') cancellers.push(fn) } }
      let p
      try { p = Promise.resolve(task(reg)) } catch { p = Promise.resolve(null) }
      p.then(
        v => { if (v) finish(v); else if (--outstanding === 0) finish(null) },
        () => { if (--outstanding === 0) finish(null) },
      )
    }
  })
}
