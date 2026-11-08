// Workaround for better-auth#10315 (https://github.com/better-auth/better-auth/issues/10315):
// on Cloudflare Workers, @better-auth/core lazily initializes its AsyncLocalStorage instances via
// a dynamic `import("node:async_hooks")` created inside the first request that touches it. If that
// request is client-aborted before the import settles, workerd never resolves the promise, and
// since it's cached at module scope every later request in the same isolate awaits it forever —
// the isolate is permanently poisoned until Cloudflare evicts it.
//
// @better-auth/core's ensureAsyncStorage() helpers (request-state.ts, transaction.ts,
// endpoint-context.ts) all check `if (existing) return existing` on this global slot before ever
// awaiting the dynamic import. Pre-seeding the slots synchronously at isolate startup means that
// branch is never taken, so there's nothing for an abort to poison. This must run before any
// better-auth import so the global is populated before better-auth's own module-scope promise is
// even created.
import { AsyncLocalStorage } from "node:async_hooks";

const globalSymbol = Symbol.for("better-auth:global");
const betterAuthGlobal = ((globalThis as any)[globalSymbol] ??= {
  version: "",
  epoch: 1,
  context: {} as Record<string, AsyncLocalStorage<unknown>>,
});

betterAuthGlobal.context.adapterAsyncStorage ??= new AsyncLocalStorage();
betterAuthGlobal.context.requestStateAsyncStorage ??= new AsyncLocalStorage();
betterAuthGlobal.context.endpointContextAsyncStorage ??= new AsyncLocalStorage();
