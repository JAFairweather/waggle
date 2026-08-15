#!/usr/bin/env node
// The broker's sshd forced command for #488. It accepts no argv, no shell, no path, and no
// destination from the caller: the intent on stdin names a key, and every other byte of the
// authorized_keys line comes from the root-owned config this process is started with.
//
// Same shape as tools/buzz-policy-service.mjs, and for the same reason — a forced command that
// reads argv is a forced command whose caller chose part of the operation.
import { loadSeatConfig, readBoundedIntent, runChannelSeat } from '../src/channel_seat_runner.mjs'

try {
  if (process.argv.length !== 2) throw new Error('channel-seat: arguments are not accepted')
  const configPath = String(process.env.WAGGLE_SEAT_CONFIG_FILE || '')
  if (!configPath) throw new Error('channel-seat: WAGGLE_SEAT_CONFIG_FILE is required')
  const config = loadSeatConfig(configPath)
  const raw = await readBoundedIntent(process.stdin)
  process.stdout.write(runChannelSeat(raw, config))
} catch (error) {
  process.stderr.write(`${String(error?.message || 'channel-seat: refused').slice(0, 512)}\n`)
  process.exitCode = 2
}
