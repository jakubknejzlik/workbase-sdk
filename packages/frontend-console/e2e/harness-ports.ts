import { createConnection } from 'node:net'

/** A ready listener from another run must never be mistaken for this run's Worker. */
export async function assertPortsFree(ports: number[]) {
  for (const port of ports) for (const host of ['127.0.0.1', '::1']) {
    const occupied = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection({ host, port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ECONNREFUSED') resolve(false); else reject(error) })
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('harness_port_probe_timeout')) })
    })
    if (occupied) throw new Error(`harness_port_in_use:${port}`)
  }
}
