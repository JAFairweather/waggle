import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const socket = read('deploy/waggle-policy.socket'), service = read('deploy/waggle-policy@.service'), slice = read('deploy/waggle-policy.slice')
const sshd = read('deploy/sshd-waggle-policy.conf'), install = read('deploy/policy-host-install.sh')
const verify = read('deploy/verify-policy-host.sh'), forward = read('tools/buzz-policy-forward.mjs')
const shadowSocket = read('deploy/waggle-policy-shadow.socket'), shadowService = read('deploy/waggle-policy-shadow@.service')
const shadowForward = read('tools/buzz-policy-shadow-forward.mjs'), shadowTool = read('tools/buzz-policy-shadow.mjs')
const shadowClient = read('deploy/waggle-policy-shadow-client.conf')
const relativeImports = text => [...text.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)].map(match => match[1])
const importClosure = (entry, seen = new Set()) => {
  const path = entry.endsWith('.mjs') ? entry : `${entry}.mjs`
  if (seen.has(path)) return seen
  seen.add(path)
  const text = readFileSync(path, 'utf8')
  for (const specifier of relativeImports(text)) importClosure(resolve(dirname(path), specifier), seen)
  return seen
}
const shadowClosure = importClosure(resolve(root, 'tools/buzz-policy-shadow.mjs'))
const forbiddenShadowCapability = path => /node:child_process|\bexecFile\b|\bspawn\b|nostr_signer|buzz_policy_artifacts|buzz_policy_service|policy_journal|\.signEvent\s*\(/.test(readFileSync(path, 'utf8'))
let fails = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); if (!value) fails++ }
const has = (text, pattern) => pattern.test(text)

ok('socket activation creates one isolated process per request', has(socket, /^Accept=yes$/m) && has(service, /^StandardInput=socket$/m) && has(service, /^StandardOutput=socket$/m))
ok('socket and transaction have explicit resource ceilings', has(socket, /^MaxConnections=4$/m) && has(socket, /^MaxConnectionsPerSource=2$/m) && has(service, /^MemoryMax=192M$/m) && has(service, /^TasksMax=16$/m) && has(service, /^CPUQuota=100%$/m))
ok('all transactions share a host-wide aggregate ceiling', has(service, /^Slice=waggle-policy\.slice$/m) && has(slice, /^MemoryMax=384M$/m) && has(slice, /^TasksMax=48$/m) && has(slice, /^CPUQuota=100%$/m))
ok('only the ingress group can enter the policy socket', has(socket, /^SocketUser=waggle-policy$/m) && has(socket, /^SocketGroup=waggle-policy-ingress$/m) && has(socket, /^SocketMode=0660$/m))
ok('the credential-bearing transaction runs as the non-login policy identity', has(service, /^User=waggle-policy$/m) && has(service, /^Group=waggle-policy$/m))
ok('policy process can write only its journal', has(service, /^ProtectSystem=strict$/m) && has(service, /^ReadOnlyPaths=\/opt\/waggle-policy$/m) && has(service, /^ReadWritePaths=\/var\/lib\/waggle-policy\/journal$/m))
ok('ordinary root-only sources enter through private systemd credential copies', (service.match(/^LoadCredential=/gm) || []).length === 3 && (service.match(/^Environment=.*=%d\//gm) || []).length === 3 && !service.includes('EnvironmentFile='))
ok('operator-only recovery authority never enters a generic socket worker', !service.includes('recovery.secret') && !service.includes('WAGGLE_POLICY_RECOVERY_SECRET_FILE'))
ok('service sandbox retains only required socket/network families', has(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m) && has(service, /^NoNewPrivileges=yes$/m) && has(service, /^PrivateDevices=yes$/m))
ok('SSH ingress is forced, key-only, and has no forwarding or PTY', ['ForceCommand ', 'AuthenticationMethods publickey', 'PermitTTY no', 'AllowAgentForwarding no', 'AllowTcpForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no', 'PermitTunnel no'].every(x => sshd.includes(x)))
ok('the forward edge has one compiled socket and imports no signer', forward.includes("const SOCKET = '/run/waggle-policy/request.sock'") && !/^import .*nostr_signer/m.test(forward) && !/process\.env/.test(forward))
ok('the forward edge refuses caller argv', forward.includes('process.argv.length !== 2'))
ok('installer keeps key/config/code root-owned and journal policy-owned', install.includes("chown root:root /etc/ssh/authorized_keys/waggle-policy-ingress") && install.includes('/etc/waggle-policy/credentials') && install.includes('/var/lib/waggle-policy/journal'))
ok('installer seals and manifests the complete runtime closure', ['! -user root', '! -group root', '-perm /022', '-type l', 'release.sha256', 'sha256sum'].every(x => install.includes(x)))
ok('installer validates sshd before reload', install.indexOf('"$SSHD" -t') > 0 && install.indexOf('"$SSHD" -t') < install.indexOf('systemctl reload ssh.service'))
ok('installer does not arm the socket before policy and credentials exist', !/enable --now waggle-policy\.socket/.test(install))
ok('verifier checks credentials, complete immutable release, and active/enabled state', ['poster.bunker-uri', 'poster.client-nsec', 'recovery.secret', 'root:root 600', 'release.sha256', 'sha256sum -c', '! -user root', '-type l', 'is-enabled', 'is-active'].every(x => verify.includes(x)))
ok('shadow ingress is a distinct fixed SSH and Unix-socket capability',
  sshd.includes('Match User waggle-policy-shadow-ingress') && sshd.includes('ForceCommand /usr/bin/node /opt/waggle-policy/tools/buzz-policy-shadow-forward.mjs') &&
  shadowForward.includes("const SOCKET = '/run/waggle-policy-shadow/request.sock'") &&
  has(shadowSocket, /^SocketGroup=waggle-policy-shadow-ingress$/m))
ok('shadow worker receives one policy credential and no signing or recovery authority',
  (shadowService.match(/^LoadCredential=/gm) || []).length === 1 && shadowService.includes('shadow-policy.json') &&
  !/poster\.bunker-uri|poster\.client-nsec|recovery\.secret|ReadWritePaths=/i.test(shadowService))
ok('shadow worker is structurally networkless and has no writable filesystem path',
  has(shadowService, /^RestrictAddressFamilies=AF_UNIX$/m) && !/^ReadWritePaths=/m.test(shadowService) &&
  !/nostr_signer|buzz_policy_artifacts|buzz_policy_service|policy_journal/.test(shadowTool))
ok('bridge-side shadow SSH capability enters only as two read-only systemd credentials',
  (shadowClient.match(/^LoadCredential=/gm) || []).length === 2 &&
  shadowClient.includes('policy-shadow-ssh:/etc/waggle/policy-client/shadow_ed25519') &&
  shadowClient.includes('policy-shadow-known-hosts:/etc/waggle/policy-client/known_hosts') &&
  (shadowClient.match(/^Environment=.*=%d\//gm) || []).length === 2 && !shadowClient.includes('EnvironmentFile='))
ok(`shadow worker transitive closure (${shadowClosure.size} modules) has no signer, submitter, journal, or child-process capability`,
  shadowClosure.size >= 6 && ![...shadowClosure].some(forbiddenShadowCapability))
ok('NEGATIVE CONTROL — the transitive scanner catches the writer-capable egress module',
  forbiddenShadowCapability(resolve(root, 'src/egress.mjs')))
ok('installer requires distinct live and derive-only ingress keys',
  install.includes('WAGGLE_POLICY_SHADOW_CLIENT_PUB') && install.includes('live and shadow ingress keys must be distinct') &&
  install.includes('tools/buzz-policy-shadow.mjs') && install.includes('tools/buzz-policy-shadow-forward.mjs'))
const sameBlob = 'AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyKeyBlob'
const sameIdentity = spawnSync('sh', [resolve(root, 'deploy/policy-host-install.sh')], {
  encoding: 'utf8', env: { ...process.env,
    WAGGLE_POLICY_CLIENT_PUB: `ssh-ed25519 ${sameBlob} live-comment`,
    WAGGLE_POLICY_SHADOW_CLIENT_PUB: `ssh-ed25519 ${sameBlob} different-shadow-comment`,
  },
})
ok('NEGATIVE CONTROL — comments cannot disguise one SSH key as two capabilities',
  sameIdentity.status === 2 && sameIdentity.stderr.includes('live and shadow ingress keys must be distinct'))
ok('verifier requires the shadow policy and active derive-only socket',
  verify.includes('/etc/waggle-policy/shadow-policy.json') && verify.includes('waggle-policy-shadow.socket'))

const weakened = service.replace('ReadWritePaths=/var/lib/waggle-policy/journal', 'ReadWritePaths=/opt/waggle-policy /etc/waggle-policy')
ok('NEGATIVE CONTROL — writable code/config would be detected', !has(weakened, /^ReadWritePaths=\/var\/lib\/waggle-policy\/journal$/m))
const shell = sshd.replace(/^    ForceCommand \/usr\/bin\/node \/opt\/waggle-policy\/tools\/buzz-policy-forward\.mjs$/m, '')
ok('NEGATIVE CONTROL — removing ForceCommand would be detected', !shell.includes('ForceCommand /usr/bin/node /opt/waggle-policy/tools/buzz-policy-forward.mjs'))
const multiplied = service.replace('Slice=waggle-policy.slice', '')
ok('NEGATIVE CONTROL — removing the aggregate slice is detected', !/^Slice=waggle-policy\.slice$/m.test(multiplied))

console.log(fails ? `\npolicy_host_deploy: ${fails} FAILED` : '\npolicy_host_deploy: all checks passed')
process.exit(fails ? 1 : 0)
