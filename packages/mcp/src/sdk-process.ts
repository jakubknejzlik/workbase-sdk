import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export type CommandResult = { rc: number; stdout: string; stderr: string; timedOut: boolean }
export type CommandOptions = {
  env?: NodeJS.ProcessEnv; timeoutMs?: number; killGraceMs?: number; signal?: AbortSignal; maxOutputBytes?: number
  /** Stream binary stdout without retaining/decoding it (e.g. archive hashing). */
  onStdout?: (chunk: Buffer) => void
  /** Stream binary stderr under the same per-stream byte bound. */
  onStderr?: (chunk: Buffer) => void
}

/** Own a POSIX process group until it is gone, including descendants whose
 * launcher has already exited or which have closed their inherited pipes. */
export async function execute(command: string[], cwd: string, options: CommandOptions = {}): Promise<CommandResult> {
  if (options.signal?.aborted) return { rc: 124, stdout: '', stderr: '', timedOut: true }
  const limit = options.maxOutputBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid command output bound')
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env: options.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let outBytes = 0, errBytes = 0, timedOut = false, stopping = false, failure: Error | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error }
    }
    const stop = () => {
      timedOut = true
      if (stopping) return
      stopping = true
      kill('SIGTERM')
      escalation = setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 500)
    }
    const timer = setTimeout(stop, options.timeoutMs ?? 1200000)
    process.once('SIGTERM', stop); process.once('SIGINT', stop)
    options.signal?.addEventListener('abort', stop, { once: true })
    // Abort can race with listener registration.
    if (options.signal?.aborted) stop()
    const receive = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (failure) return
      const previous = stream === 'stdout' ? outBytes : errBytes
      const size = previous + chunk.length
      if (stream === 'stdout') outBytes = size
      else errBytes = size
      const accepted = chunk.subarray(0, Math.max(0, limit - previous))
      // Record overflow before calling user code, and never expose excess bytes.
      if (size > limit) failure = new Error(`Command ${stream} output exceeds ${limit} bytes`)
      try {
        const callback = stream === 'stdout' ? options.onStdout : options.onStderr
        if (accepted.length) {
          if (callback) callback(accepted)
          else (stream === 'stdout' ? stdout : stderr).push(accepted)
        }
      } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)) }
      if (failure) stop()
    }
    child.stdout.on('data', chunk => receive(chunk, 'stdout'))
    child.stderr.on('data', chunk => receive(chunk, 'stderr'))
    child.once('error', error => { failure = error })
    child.once('close', async code => {
      clearTimeout(timer)
      try {
        // Do not cancel escalation on launcher close: it may have left a
        // resistant descendant behind. SIGKILL now also handles normal exits.
        kill('SIGKILL')
        const deadline = Date.now() + 5000
        while (child.pid) {
          try { process.kill(-child.pid, 0) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
            // Darwin can report EPERM while launchd reaps killed orphans.
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
          }
          if (Date.now() >= deadline) throw new Error('Command process group did not exit after SIGKILL')
          await delay(10)
        }
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
      finally {
        clearTimeout(timer); clearTimeout(escalation)
        process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
        options.signal?.removeEventListener('abort', stop)
      }
      if (failure) reject(failure)
      else resolve({ rc: timedOut ? 124 : code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    })
  })
}
