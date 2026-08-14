// agent_manifest_transfer.mjs — carry a manifest to a machine that has no agent on it (#470).
//
// `--from <instance>` mirrors a sibling directory inside the same agent root. That works on a
// machine that already runs an agent, and a Pi is a different machine, which is the entire point of
// it. So the first step of the remote-agent goal had no path through the tool at all, and what
// happened instead was somebody copying JSON by hand — the thing
// docs/DESIGN_CONNECT_REMOTE_AGENT.md opens by saying is not a tool.
//
// This is not `--from` with a path argument, and the difference is the reason it is a separate
// module. Three classes of field live in one manifest:
//
//   AUTHORISATION — grantors, task_carriers, relays. This repo cannot derive them and must not
//     guess them. They are the whole reason a transfer exists, and they travel.
//   IDENTITY — id, pubkey. Per agent. Carrying them would let one export seat two agents as the
//     same key, which is the impersonation the whole design is built to prevent.
//   HOST — every *_dir, every *_ref, every uid and gid. Per machine. uid 1001 on a laptop is not
//     uid 1001 on a Pi; a mirrored uid declares a privilege separation that does not exist there,
//     and it declares it silently. These are DROPPED, not copied, and the drop is reported.
//
// A template is a public artifact by construction: it holds relay URLs and public keys and nothing
// else. It is still swept before it is written and again before it is read, because "by
// construction" is a claim about the code and the sweep is a claim about the bytes.
import { secretInText } from './agent_startup.mjs'

// Travels. Every one of these is something this repo cannot work out for itself.
export const PORTABLE = ['version', 'grantors', 'task_carriers', 'relays', 'broker_mode', 'delivery_mode', 'worker_enabled']

// Required in a template before it may seat an agent. `relays` and `grantors` decide who may
// instruct this agent and where it listens; a template missing either would install an agent that
// looks configured and answers to nobody, or to anyone. Defaulting them is the failure this project
// keeps having, so absence is a refusal.
export const REQUIRED = ['grantors', 'task_carriers', 'relays']

// Never travels, and each is dropped for a different reason. Named individually rather than matched
// by suffix so that a new field is a decision someone makes, not a regex outcome.
export const HOST_ONLY = ['state_dir', 'runtime_dir', 'spool_dir', 'bunker_uri_ref', 'bunker_client_ref',
  'watcher_uid', 'broker_uid', 'adapter_uid', 'worker_uid', 'broker_adapter_gid', 'worker_handoff_gid']
export const IDENTITY_ONLY = ['id', 'pubkey']

const HEX64 = /^[0-9a-f]{64}$/i
const isHexList = v => Array.isArray(v) && v.length > 0 && v.every(x => HEX64.test(String(x)))
const isRelayList = v => Array.isArray(v) && v.length > 0 && v.every(x => /^wss:\/\/[^\s]+$/i.test(String(x)))

/**
 * Reduce a working manifest to what may cross a machine boundary.
 *
 * Returns `{ template, dropped }` — `dropped` names every field left behind, because a transfer
 * that quietly discards half a manifest is indistinguishable from one that carried it.
 * Throws rather than returning when the result would carry a credential.
 */
export function exportTemplate(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('exportTemplate needs a manifest object')
  }
  const template = {}
  for (const k of PORTABLE) if (manifest[k] !== undefined) template[k] = manifest[k]
  for (const k of REQUIRED) {
    if (template[k] === undefined) throw new Error(`this manifest has no ${k}, so a template from it would seat an agent that answers to nobody`)
  }
  const dropped = [...HOST_ONLY, ...IDENTITY_ONLY].filter(k => manifest[k] !== undefined)
  const leak = secretInText(JSON.stringify(template))
  if (leak) throw new Error(`refusing to write a manifest template containing ${leak}`)
  return { template, dropped }
}

/**
 * Turn a template plus this machine's own facts into a manifest ready to write.
 *
 * `host` supplies exactly the fields the template refused to carry. Nothing is defaulted: a
 * template that arrives without an authorisation field is a refusal, not a manifest with a hole
 * in it.
 *
 * Returns `{ manifest, warnings }`. The warnings are the register
 * docs/DESIGN_CONNECT_REMOTE_AGENT.md §II asks for — said out loud at the moment the values are
 * copied, because a register nobody reads is not a register.
 */
export function importTemplate(template, host) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('the manifest template is not a JSON object')
  }
  const leak = secretInText(JSON.stringify(template))
  if (leak) throw new Error(`refusing to read a manifest template containing ${leak} — templates are public artifacts and this one is not`)

  const { name, pubkey, stateDir, runtimeDir, spoolDir, uriPath, clientPath } = host || {}
  if (!name) throw new Error('importTemplate needs the agent name')
  if (!HEX64.test(String(pubkey || ''))) throw new Error('importTemplate needs a 64-hex pubkey for this agent')

  const missing = REQUIRED.filter(k => template[k] === undefined)
  if (missing.length) {
    throw new Error(`template is missing ${missing.join(', ')} — this repo cannot derive ${missing.length === 1 ? 'it' : 'them'}, and an agent seated without ${missing.length === 1 ? 'it' : 'them'} looks configured and is not`)
  }
  if (!isHexList(template.grantors)) throw new Error('template grantors must be a non-empty list of 64-hex keys')
  if (!isHexList(template.task_carriers)) throw new Error('template task_carriers must be a non-empty list of 64-hex keys')
  if (!isRelayList(template.relays)) throw new Error('template relays must be a non-empty list of wss:// URLs')

  const carried = [...HOST_ONLY, ...IDENTITY_ONLY].filter(k => template[k] !== undefined)
  if (carried.length) {
    throw new Error(`template carries ${carried.join(', ')}, which is per-machine or per-agent and must not travel — re-export it with --export`)
  }

  const manifest = {}
  for (const k of PORTABLE) if (template[k] !== undefined) manifest[k] = template[k]
  manifest.id = name
  manifest.pubkey = String(pubkey).toLowerCase()
  manifest.state_dir = stateDir
  manifest.runtime_dir = runtimeDir
  manifest.spool_dir = spoolDir
  manifest.bunker_uri_ref = uriPath
  manifest.bunker_client_ref = clientPath

  const warnings = [
    `imported relays: ${manifest.relays.join(', ')} — an agent's whole authorisation depends on these`,
    `imported grantors: ${manifest.grantors.length} key(s), task carriers: ${manifest.task_carriers.length} — nothing here verified that any of them is live`,
    `no uids or gids were imported: they are per-machine, and a mirrored uid declares a privilege separation this host may not have. Set them here if this host runs one.`,
  ]
  return { manifest, warnings }
}
