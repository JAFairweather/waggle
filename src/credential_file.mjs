import { dirname, resolve } from 'node:path'

// Ordinary credential files remain owner-only. systemd LoadCredential= is the one exception:
// it projects a root-owned 0440 file into a private /run/credentials/<unit> mount and grants the
// service access through that mount. Accepting 0440 anywhere else would make a copied secret
// group-readable, so all four bindings below are required together.
export function credentialModeIsPrivate(path, stat, credentialsDirectory = process.env.CREDENTIALS_DIRECTORY) {
  if (!stat || !Number.isInteger(stat.mode)) return false
  if ((stat.mode & 0o077) === 0) return true
  const directory = String(credentialsDirectory || '')
  if (!directory.startsWith('/run/credentials/')) return false
  const exactDirectory = resolve(directory), exactPath = resolve(String(path || ''))
  return dirname(exactPath) === exactDirectory &&
    (stat.mode & 0o777) === 0o440 && stat.uid === 0 && stat.gid === 0
}
