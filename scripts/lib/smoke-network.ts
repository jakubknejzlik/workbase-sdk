import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'

/** Apply kernel IP isolation to the entire process tree, even when descendants
 * clear NODE_OPTIONS or start a different runtime. Local Unix IPC remains usable
 * by esbuild, tsx and the provisioning evaluator. Unsupported hosts fail closed. */
export function isolateSmokeNetwork(command: string, args: string[], env = process.env): [string, string[]] {
  if (process.platform === 'darwin') return ['/usr/bin/sandbox-exec', ['-p',
    '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(deny network-inbound (local ip "*:*"))(deny network-bind (local ip "*:*"))',
    command, ...args]]
  if (process.platform === 'linux') {
    const uid = process.getuid!(), gid = process.getgid!()
    if (uid === 0) throw new Error('Packed smoke IP isolation requires a non-root runner with passwordless sudo on Linux')
    // Hosted Ubuntu restricts unprivileged user namespaces. Create only a network
    // namespace as root, then drop identity and all capabilities before executing.
    // no-new-privs prevents descendants from using sudo to escape the namespace.
    // Restore the runner's PATH and Node loader options, which sudo filters out.
    return ['sudo', ['--non-interactive', '--preserve-env', '--', '/usr/bin/unshare', '--net', '--',
      '/usr/bin/setpriv', `--reuid=${uid}`, `--regid=${gid}`, '--init-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
      '/usr/bin/env', `PATH=${env.PATH ?? ''}`, `NODE_OPTIONS=${env.NODE_OPTIONS ?? ''}`, `NODE_PATH=${env.NODE_PATH ?? ''}`, command, ...args]]
  }
  throw new Error('Packed smoke requires macOS sandbox-exec or Linux unshare for post-install IP isolation')
}

/** Prove the wrapper can execute before claiming any network-denial evidence. */
export function assertSmokeNetworkIsolation(env = process.env, cwd = process.cwd()): void {
  try {
    const linux = process.platform === 'linux'
    const parentNet = linux ? readlinkSync('/proc/self/ns/net') : ''
    const code = `const assert = require('node:assert/strict');
if (process.platform === 'linux') {
  const fs = require('node:fs');
  assert.equal(process.getuid(), ${process.getuid?.() ?? -1});
  assert.equal(process.getgid(), ${process.getgid?.() ?? -1});
  assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), ${JSON.stringify(parentNet)});
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\\s+0+$/m);
  assert.match(status, /^CapBnd:\\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\\s+1$/m);
}
console.log('PACKED_SMOKE_ISOLATION_READY');`
    const [command, args] = isolateSmokeNetwork(process.execPath, ['--eval', code], env)
    const output = execFileSync(command, args, { env, cwd, encoding: 'utf8', timeout: 10000, stdio: 'pipe' })
    if (output.trim() !== 'PACKED_SMOKE_ISOLATION_READY') throw new Error('isolated child did not report readiness')
  } catch (cause) {
    const detail = cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr).trim() : String(cause)
    throw new Error(`Packed smoke IP isolation unavailable; refusing post-install execution. Linux requires passwordless sudo, /usr/bin/unshare --net and /usr/bin/setpriv; macOS requires sandbox-exec. ${detail}`, { cause })
  }
}
