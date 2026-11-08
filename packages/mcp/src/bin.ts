#!/usr/bin/env bun
// Dispatch before loading either server, preserving their separate process boundaries.
const command = process.argv[2]
if (command === 'data') {
  process.argv.splice(2, 1)
  await import('./data/stdio.ts')
} else {
  if (command === 'config') process.argv.splice(2, 1)
  await import('./stdio.ts')
}
export {}
