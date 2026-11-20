// Local harness only: observe native children in their Node parent, which can wait
// for their actual exit status. Never record argv or environment variables.
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const directory = process.env.W29_DIAGNOSTICS_DIRECTORY
if (directory) {
  const { redact } = require('./diagnostics-redact.cjs')
  const pgid = () => {
    try { return Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()) }
    catch { return null }
  }
  const group = pgid()
  const record = event => {
    try { fs.appendFileSync(path.join(directory, 'process-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), observerPid: process.pid, pgid: group, ...event }) + '\n') } catch {}
  }
  record({ kind: 'observer-start', pid: process.pid, parentPid: process.ppid })
  const originalSpawn = cp.spawn
  cp.spawn = function (file, ...rest) {
    const child = originalSpawn.call(this, file, ...rest)
    if (/^workerd(?:\.exe)?$/.test(path.basename(String(file)))) {
      const inspector = Array.isArray(rest[0]) ? rest[0].find(arg => /^--inspector-addr=/.test(arg)) : undefined
      const inspectorPort = inspector ? Number(inspector.match(/:(\d+)$/)?.[1]) || null : null
      record({ kind: 'workerd-start', pid: child.pid, parentPid: process.pid, inspectorPort })
      let control = ''
      child.stdio[3]?.on('data', chunk => {
        control += chunk.toString()
        const lines = control.split('\n')
        control = lines.pop().slice(-4096)
        for (const line of lines) try {
          const message = JSON.parse(line)
          if (message.event === 'listen-inspector' && Number.isInteger(message.port)) record({ kind: 'workerd-inspector', pid: child.pid, port: message.port })
        } catch {}
      })
      let stderrTail = ''
      child.stderr?.on('data', chunk => {
        stderrTail = (stderrTail + redact(chunk.toString())).slice(-16384)
        try { fs.writeFileSync(path.join(directory, `workerd-${child.pid}-stderr.log`), stderrTail) } catch {}
      })
      child.once('error', error => record({ kind: 'workerd-error', pid: child.pid, error: redact(error.message) }))
      child.once('exit', (code, signal) => record({ kind: 'workerd-exit', pid: child.pid, code, signal, stderrTail, expectedStop: fs.existsSync(path.join(directory, 'stopping')) }))
    }
    return child
  }
}
