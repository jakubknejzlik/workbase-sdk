import { test, type TestInfo } from '@playwright/test'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { retainTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'

const { redact } = createRequire(import.meta.url)('./diagnostics-redact.cjs') as { redact: (value: string) => string }
function currentTest(): TestInfo | undefined { try { return test.info() } catch { return undefined } }

export function runtimeDiagnostics(directory: string, root: string, port: number) {
  const startedAt = new Date().toISOString()
  const firstTest = currentTest()
  const processes = new Map<number, { pid: number; parentPid: number; pgid: number; name: string }>()
  let child: ChildProcess | undefined
  let stoppingAt: string | undefined
  let stoppedAt: string | undefined
  let unexpected = false
  let retained = false
  let stderrTail = ''
  let outputDirectory: string | undefined
  const events = () => {
    try { return readFileSync(join(directory, 'process-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<Record<string, unknown>> }
    catch { return [] }
  }
  const sample = () => {
    if (!child?.pid) return
    try {
      // comm contains the executable, never arguments or environment.
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' })
      for (const row of rows.split('\n')) {
        const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
        if (match && Number(match[3]) === child.pid && !processes.has(Number(match[1]))) processes.set(Number(match[1]), { pid: Number(match[1]), parentPid: Number(match[2]), pgid: Number(match[3]), name: basename(match[4]) })
      }
    } catch { /* Native identities are explicitly marked unavailable below. */ }
  }
  const persist = (keep = true) => {
    if (keep) { retained = true; retainTempDir(directory) }
    const info = currentTest() ?? firstTest
    outputDirectory = info ? join(info.outputDir, `runtime-${port}-${child?.pid ?? 'startup'}`) : join(directory, 'diagnostics')
    mkdirSync(outputDirectory, { recursive: true })
    const nativeEvents = events()
    for (const event of nativeEvents) if (event.kind === 'workerd-start' && typeof event.pid === 'number') {
      processes.set(event.pid, { pid: event.pid, parentPid: Number(event.parentPid), pgid: Number(event.pgid), name: 'workerd' })
    }
    const workerd = [...processes.values()].filter(item => /^workerd(?:\.exe)?$/.test(item.name))
    const exits = workerd.map(item => ({ ...item, nativeExit: nativeEvents.find(event => event.kind === 'workerd-exit' && event.pid === item.pid) ?? { available: false, reason: 'Native parent did not deliver a child exit event; wrapper status is not a native exit status.' } }))
    writeFileSync(join(outputDirectory, 'runtime-diagnostics.json'), JSON.stringify({
      test: info ? { id: info.testId, title: info.title, status: info.status, expectedStatus: info.expectedStatus } : { unavailable: 'Not running inside a Playwright test' },
      initialTestId: firstTest?.testId, worktree: root, directory, port, inspectorPort: { requested: 0, native: nativeEvents.filter(event => event.kind === 'workerd-start').map(event => {
        const actual = nativeEvents.find(item => item.kind === 'workerd-inspector' && item.pid === event.pid)?.port ?? event.inspectorPort
        return { pid: event.pid, port: actual, unavailable: actual ? undefined : 'No inspector endpoint observed for this native child' }
      }) },
      wrapperPid: child?.pid, wranglerPids: [...new Set(nativeEvents.filter(event => event.kind === 'workerd-start').map(event => event.parentPid))], processGroup: child?.pid, processes: [...processes.values()], workerd: exits,
      nativeExitEvidence: nativeEvents.some(event => event.kind === 'workerd-exit') ? 'Native exit events below' : 'Unavailable: no native child exit event observed',
      processEvents: nativeEvents, wrapperExit: { code: child?.exitCode, signal: child?.signalCode },
      startedAt, stoppingAt, stoppedAt, unexpected, stderrTail,
    }, null, 2) + '\n')
    for (const file of [ ...(keep ? ['worker.log'] : []), 'process-events.jsonl', ...workerd.map(item => `workerd-${item.pid}-stderr.log`) ]) if (existsSync(join(directory, file))) copyFileSync(join(directory, file), join(outputDirectory, file))
  }
  const timer = setInterval(() => {
    sample()
    if (!stoppingAt && events().some(event => event.kind === 'workerd-exit' && !event.expectedStop)) { unexpected = true; persist() }
  }, 250)
  timer.unref()
  return {
    environment: { W29_DIAGNOSTICS_DIRECTORY: directory, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(resolve(import.meta.dirname, 'diagnostics-preload.cjs'))}`.trim() },
    observe(process: ChildProcess) {
      child = process
      for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream?.on('data', chunk => {
        const value = redact(chunk.toString())
        appendFileSync(join(directory, 'worker.log'), value)
        if (name === 'stderr') stderrTail = (stderrTail + value).slice(-16384)
        if (!stoppingAt && /Network connection lost|request disconnected|workerd.*(?:crash|disconnect)/i.test(value)) { unexpected = true; persist() }
      })
      child.once('exit', () => { if (!stoppingAt) { unexpected = true; persist() } })
      child.once('error', error => { stderrTail += redact(error.message); unexpected = true; persist() })
      sample()
    },
    async stopping() {
      sample()
      if (events().some(event => event.kind === 'workerd-exit' && !event.expectedStop)) unexpected = true
      stoppingAt = new Date().toISOString()
      writeFileSync(join(directory, 'stopping'), stoppingAt)
      // Let the native parent reap its own children before terminating the group.
      // Recheck ownership to avoid signalling a stale/reused PID.
      for (const item of processes.values()) if (/^workerd(?:\.exe)?$/.test(item.name)) {
        try {
          const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(item.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
          if (group === child?.pid) process.kill(item.pid, 'SIGTERM')
        } catch {}
      }
      await new Promise(done => setTimeout(done, 500))
    },
    finish(force = false) {
      clearInterval(timer)
      stoppedAt = new Date().toISOString()
      const info = currentTest()
      persist(Boolean(force || retained || unexpected || (info && info.status !== 'passed')))
      return outputDirectory
    },
  }
}
