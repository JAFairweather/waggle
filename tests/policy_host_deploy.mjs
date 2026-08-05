import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const socket = read('deploy/waggle-policy.socket'), service = read('deploy/waggle-policy@.service'), slice = read('deploy/waggle-policy.slice')
const sshd = read('deploy/sshd-waggle-policy.conf'), install = read('deploy/policy-host-install.sh')
const verify = read('deploy/verify-policy-host.sh'), forward = read('tools/buzz-policy-forward.mjs')
let fails = 0
const ok = (name, value) => { console.log(`${value ? 'ok  ' : 'FAIL'} — ${name}`); if (!value) fails++ }
const has = (text, pattern) => pattern.test(text)

ok('socket activation creates one isolated process per request', has(socket, /^Accept=yes$/m) && has(service, /^StandardInput=socket$/m) && has(service, /^StandardOutput=socket$/m))
ok('socket and transaction have explicit resource ceilings', has(socket, /^MaxConnections=4$/m) && has(socket, /^MaxConnectionsPerSource=2$/m) && has(service, /^MemoryMax=192M$/m) && has(service, /^TasksMax=16$/m) && has(service, /^CPUQuota=100%$/m))
ok('all transactions share a host-wide aggregate ceiling', has(service, /^Slice=waggle-policy\.slice$/m) && has(slice, /^MemoryMax=384M$/m) && has(slice, /^TasksMax=48$/m) && has(slice, /^CPUQuota=100%$/m))
ok('only the ingress group can enter the policy socket', has(socket, /^SocketUser=waggle-policy$/m) && has(socket, /^SocketGroup=waggle-policy-ingress$/m) && has(socket, /^SocketMode=0660$/m))
ok('the credential-bearing transaction runs as the non-login policy identity', has(service, /^User=waggle-policy$/m) && has(service, /^Group=waggle-policy$/m))
ok('policy process can write only its journal', has(service, /^ProtectSystem=strict$/m) && has(service, /^ReadOnlyPaths=\/opt\/waggle-policy$/m) && has(service, /^ReadWritePaths=\/var\/lib\/waggle-policy\/journal$/m))
ok('root-only sources enter through private systemd credential copies', (service.match(/^LoadCredential=/gm) || []).length === 4 && (service.match(/^Environment=.*=%d\//gm) || []).length === 4 && !service.includes('EnvironmentFile='))
ok('service sandbox retains only required socket/network families', has(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m) && has(service, /^NoNewPrivileges=yes$/m) && has(service, /^PrivateDevices=yes$/m))
ok('SSH ingress is forced, key-only, and has no forwarding or PTY', ['ForceCommand ', 'AuthenticationMethods publickey', 'PermitTTY no', 'AllowAgentForwarding no', 'AllowTcpForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no', 'PermitTunnel no'].every(x => sshd.includes(x)))
ok('the forward edge has one compiled socket and imports no signer', forward.includes("const SOCKET = '/run/waggle-policy/request.sock'") && !/^import .*nostr_signer/m.test(forward) && !/process\.env/.test(forward))
ok('the forward edge refuses caller argv', forward.includes('process.argv.length !== 2'))
ok('installer keeps key/config/code root-owned and journal policy-owned', install.includes("chown root:root /etc/ssh/authorized_keys/waggle-policy-ingress") && install.includes('/etc/waggle-policy/credentials') && install.includes('/var/lib/waggle-policy/journal'))
ok('installer seals and manifests the complete runtime closure', ['! -user root', '! -group root', '-perm /022', '-type l', 'release.sha256', 'sha256sum'].every(x => install.includes(x)))
ok('installer validates sshd before reload', install.indexOf('"$SSHD" -t') > 0 && install.indexOf('"$SSHD" -t') < install.indexOf('systemctl reload ssh.service'))
ok('installer does not arm the socket before policy and credentials exist', !/enable --now waggle-policy\.socket/.test(install))
ok('verifier checks credentials, complete immutable release, and active/enabled state', ['poster.bunker-uri', 'poster.client-nsec', 'recovery.secret', 'root:root 600', 'release.sha256', 'sha256sum -c', '! -user root', '-type l', 'is-enabled', 'is-active'].every(x => verify.includes(x)))

const weakened = service.replace('ReadWritePaths=/var/lib/waggle-policy/journal', 'ReadWritePaths=/opt/waggle-policy /etc/waggle-policy')
ok('NEGATIVE CONTROL — writable code/config would be detected', !has(weakened, /^ReadWritePaths=\/var\/lib\/waggle-policy\/journal$/m))
const shell = sshd.replace(/^    ForceCommand.*$/m, '')
ok('NEGATIVE CONTROL — removing ForceCommand would be detected', !/^    ForceCommand /m.test(shell))
const multiplied = service.replace('Slice=waggle-policy.slice', '')
ok('NEGATIVE CONTROL — removing the aggregate slice is detected', !/^Slice=waggle-policy\.slice$/m.test(multiplied))

console.log(fails ? `\npolicy_host_deploy: ${fails} FAILED` : '\npolicy_host_deploy: all checks passed')
process.exit(fails ? 1 : 0)
