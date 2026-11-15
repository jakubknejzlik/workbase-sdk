#!/usr/bin/env bun
// Dispatch before loading a server, preserving their separate process boundaries.
const command = process.argv[2]
if (command === 'data') {
  process.argv.splice(2, 1)
  await import('./data/stdio.ts')
} else if (command === 'ops') {
  process.argv.splice(2, 1)
  if (process.argv[2] === 'bootstrap-instance-owner') {
    const { run } = await import('./ops/cli.ts')
    const { exitCode, result } = await run(process.argv.slice(2))
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = exitCode
  } else await import('./ops/stdio.ts')
} else {
  if (command === 'config') process.argv.splice(2, 1)
  await import('./stdio.ts')
}
export {}
