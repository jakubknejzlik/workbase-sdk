import { MigrationDiagnostic } from './diagnostics'
import type { D1Query, QueryResult } from './d1-migrations'

export function httpD1Query(account: string, database: string, token: string, fetcher = fetch): D1Query {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9-]{36}$/.test(database)) throw new MigrationDiagnostic({ code: 'invalid_cloudflare_ids' })
  return async sql => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }), signal: AbortSignal.timeout(60000),
    })
    // Never print API bodies, SQL or headers: they can contain credentials or customer data.
    if (!response.ok) throw new MigrationDiagnostic({ code: 'd1_http_status', status: response.status })
    const body = await response.json() as { success: boolean; result: QueryResult[] }
    if (!body.success || !Array.isArray(body.result)) throw new MigrationDiagnostic({ code: 'd1_api_failed' })
    return body.result
  }
}
