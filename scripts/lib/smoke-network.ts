/** Apply kernel IP isolation to the entire process tree, even when descendants
 * clear NODE_OPTIONS or start a different runtime. Local Unix IPC remains usable
 * by esbuild, tsx and the provisioning evaluator. Unsupported hosts fail closed. */
export function isolateSmokeNetwork(command: string, args: string[]): [string, string[]] {
  if (process.platform === 'darwin') return ['/usr/bin/sandbox-exec', ['-p',
    '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(deny network-inbound (local ip "*:*"))(deny network-bind (local ip "*:*"))',
    command, ...args]]
  if (process.platform === 'linux') return ['unshare', ['--user', '--map-root-user', '--net', '--', command, ...args]]
  throw new Error('Packed smoke requires macOS sandbox-exec or Linux unshare for post-install IP isolation')
}
