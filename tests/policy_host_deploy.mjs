import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const socket = read('deploy/waggle-policy.socket'), service = read('deploy/waggle-policy@.service'), slice = read('deploy/waggle-policy.slice')
const sshd = read('deploy/sshd-waggle-policy.conf'), install = read('deploy/policy-host-install.sh')
const verify = read('deploy/verify-policy-host.sh'), forward = read('tools/buzz-policy-forward.mjs')
const shadowSocket = read('deploy/waggle-policy-shadow.socket'), shadowService = read('deploy/waggle-policy-shadow@.service')
const shadowForward = read('tools/buzz-policy-shadow-forward.mjs'), shadowTool = read('tools/buzz-policy-shadow.mjs')
const shadowClient = read('deploy/waggle-policy-shadow-client.conf')
const deployRunner = read('deploy/policy-host-deploy-runner.sh')
const deployRunnerService = read('deploy/policy-host-deploy-runner.service')
const deployRunnerTimer = read('deploy/policy-host-deploy-runner.timer')
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
ok('policy host pulls code without a GitHub-to-production SSH credential',
  deployRunner.includes('git -C "$HUB" fetch') && !/\bscp\b|\brsync\b|ssh ["'$]/.test(deployRunner))
ok('only an exact commit with successful CI can promote',
  deployRunner.includes('TARGET_SHA=$(git -C "$HUB" rev-parse') && deployRunner.includes('case "$STATE"') &&
  deployRunner.includes('success)') && deployRunner.includes('failure)') && deployRunner.includes('pending)'))
ok('release archive is a closed runtime list and excludes host policy and credentials',
  deployRunner.includes('"$TARGET_SHA" src tools deploy package.json package-lock.json') &&
  !deployRunner.includes('config.json') && !deployRunner.includes('poster.bunker-uri'))
ok('promotion stages an immutable release and retains an explicit rollback release',
  deployRunner.includes('STAGE="$RELEASE_ROOT/.stage-$TARGET_SHA"') &&
  deployRunner.includes('PREVIOUS="$RELEASE_ROOT/previous"') && deployRunner.includes('rollback()') &&
  deployRunner.includes('mv "$STAGE" "$TREE"'))
ok('deployment watermark follows install, restart, and final verification',
  deployRunner.indexOf('printf \'%s\\n\' "$TARGET_SHA"') > deployRunner.lastIndexOf('sh -c "$VERIFY_CMD"') &&
  deployRunner.lastIndexOf('sh -c "$VERIFY_CMD"') > deployRunner.lastIndexOf('sh -c "$RESTART_CMD"') &&
  deployRunner.lastIndexOf('sh -c "$RESTART_CMD"') > deployRunner.lastIndexOf('sh -c "$INSTALL_CMD"'))
ok('failed verification restores and verifies the previous release',
  /rollback\(\)[\s\S]+mv "\$PREVIOUS" "\$TREE"[\s\S]+ROLLBACK VERIFICATION FAILED/.test(deployRunner))
ok('systemd runs the pull runner locally and the timer is persistent',
  deployRunnerService.includes('ExecStart=/bin/sh /opt/waggle-policy-hub/deploy/policy-host-deploy-runner.sh') &&
  deployRunnerService.includes('ProtectHome=yes') && deployRunnerTimer.includes('OnUnitActiveSec=3min') &&
  deployRunnerTimer.includes('Persistent=true'))

// Exercise a real archive -> stage -> promote and then a failed candidate -> rollback. The host
// mutations are explicit seams; git archive, directory rotation, and the watermark are real.
const deployFixture = mkdtempSync(resolve(tmpdir(), 'waggle-policy-deploy-'))
const fixtureHub = resolve(deployFixture, 'hub')
const fixtureTree = resolve(deployFixture, 'live')
const fixtureReleases = resolve(deployFixture, 'releases')
const fixtureSha = resolve(deployFixture, 'DEPLOYED_SHA')
const liveAuth = resolve(deployFixture, 'live.pub')
const shadowAuth = resolve(deployFixture, 'shadow.pub')
const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', root, fixtureHub], { encoding: 'utf8' })
ok('deploy fixture clones the exact reviewed repository', clone.status === 0)
const fixtureHead = spawnSync('git', ['-C', fixtureHub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
mkdirSync(fixtureTree, { recursive: true })
writeFileSync(resolve(fixtureTree, 'previous-proof'), 'old verified release\n')
writeFileSync(liveAuth, 'restrict ssh-ed25519 AAAATestLive live\n')
writeFileSync(shadowAuth, 'restrict ssh-ed25519 AAAATestShadow shadow\n')
const fixtureEnv = { ...process.env, WP_ALLOW_NON_ROOT: '1', WP_TEST_SKIP_OWNERSHIP: '1',
  WP_HUB: fixtureHub, WP_TREE: fixtureTree, WP_RELEASE_ROOT: fixtureReleases, WP_SHA_FILE: fixtureSha,
  WP_REF: fixtureHead, WP_NO_FETCH: '1', WP_CI_STATE_CMD: 'echo success #', WP_NPM_CMD: ':',
  WP_INSTALL_CMD: ':', WP_RESTART_CMD: ':', WP_VERIFY_CMD: 'test -f package.json',
  WP_LIVE_AUTHORIZED_KEY: liveAuth, WP_SHADOW_AUTHORIZED_KEY: shadowAuth }
const promoted = spawnSync('/bin/sh', ['deploy/policy-host-deploy-runner.sh'], { cwd: root, env: fixtureEnv, encoding: 'utf8' })
ok('green exact commit promotes and verifies a staged release', promoted.status === 0 && existsSync(resolve(fixtureTree, 'package.json')))
ok('successful promotion retains the prior release', existsSync(resolve(fixtureReleases, 'previous', 'previous-proof')))
ok('successful promotion records the exact verified SHA', readFileSync(fixtureSha, 'utf8').trim() === fixtureHead)

// Create a second local commit, force final verification to fail, and prove directory rotation
// restores the first candidate while leaving its SHA as the last verified deployment.
writeFileSync(resolve(fixtureHub, 'src', 'policy-deploy-failure-fixture.mjs'), 'export const candidate = true\n')
spawnSync('git', ['-C', fixtureHub, 'add', 'src/policy-deploy-failure-fixture.mjs'])
spawnSync('git', ['-C', fixtureHub, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'candidate'])
const secondHead = spawnSync('git', ['-C', fixtureHub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const rejected = spawnSync('/bin/sh', ['deploy/policy-host-deploy-runner.sh'], { cwd: root,
  env: { ...fixtureEnv, WP_REF: secondHead, WP_VERIFY_CMD: 'false' }, encoding: 'utf8' })
ok('failed candidate exits nonzero and emits a rollback alarm', rejected.status === 1 && /restoring previous/.test(rejected.stderr))
ok('failed candidate restores the previously verified release', existsSync(resolve(fixtureTree, 'package.json')) && !existsSync(resolve(fixtureTree, 'src', 'policy-deploy-failure-fixture.mjs')))
ok('failed candidate cannot advance the verified deployment SHA', readFileSync(fixtureSha, 'utf8').trim() === fixtureHead)
rmSync(deployFixture, { recursive: true, force: true })

const weakened = service.replace('ReadWritePaths=/var/lib/waggle-policy/journal', 'ReadWritePaths=/opt/waggle-policy /etc/waggle-policy')
ok('NEGATIVE CONTROL — writable code/config would be detected', !has(weakened, /^ReadWritePaths=\/var\/lib\/waggle-policy\/journal$/m))
const shell = sshd.replace(/^    ForceCommand \/usr\/bin\/node \/opt\/waggle-policy\/tools\/buzz-policy-forward\.mjs$/m, '')
ok('NEGATIVE CONTROL — removing ForceCommand would be detected', !shell.includes('ForceCommand /usr/bin/node /opt/waggle-policy/tools/buzz-policy-forward.mjs'))
const multiplied = service.replace('Slice=waggle-policy.slice', '')
ok('NEGATIVE CONTROL — removing the aggregate slice is detected', !/^Slice=waggle-policy\.slice$/m.test(multiplied))

console.log(fails ? `\npolicy_host_deploy: ${fails} FAILED` : '\npolicy_host_deploy: all checks passed')
process.exit(fails ? 1 : 0)
