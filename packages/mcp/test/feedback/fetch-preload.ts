// Test-only bridge: production configuration has no endpoint override.
const nativeFetch = globalThis.fetch
const endpoint = process.env.SYNTHETIC_FEEDBACK_HTTP
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('invalid_test_endpoint')
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.origin !== 'https://api.github.com') throw new Error('unexpected_test_origin')
  return nativeFetch(endpoint + url.pathname + url.search, init)
}) as typeof fetch
