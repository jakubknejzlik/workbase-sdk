import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'

export interface ActionContext {
  readonly signal: AbortSignal
  assertCurrent(): void
  run<T>(effect: () => T): T
}
export type RunAction = <T>(action: (ctx: ActionContext) => Promise<T>) => Promise<T>
export function actionContext(signal: AbortSignal, check: () => void = () => {}): ActionContext {
  const assertCurrent = () => { check(); signal.throwIfAborted() }
  return { signal, assertCurrent, run<T>(effect: () => T): T {
    assertCurrent()
    const result = effect()
    if (result instanceof Promise) return result.then(value => { assertCurrent(); return value }, error => { assertCurrent(); throw error }) as T
    assertCurrent(); return result
  } }
}
const Actions = createContext<RunAction | undefined>(undefined)
/** The host binds generated action continuations to its authority generation. */
export function GeneratedActionProvider({ run, children }: { run: RunAction; children: ReactNode }) {
  return <Actions.Provider value={run}>{children}</Actions.Provider>
}
export function useGeneratedAction(): RunAction {
  const host = useContext(Actions)
  // Standalone generated components own their mounted lifetime. An authority
  // host supplies the stricter scope lifetime through GeneratedActionProvider.
  const lifetime = useMemo(() => ({ controller: new AbortController() }), [])
  useEffect(() => {
    lifetime.controller = new AbortController()
    return () => lifetime.controller.abort()
  }, [lifetime])
  return host ?? (async action => {
    const ctx = actionContext(lifetime.controller.signal)
    return ctx.run(() => action(ctx))
  })
}
export interface ActionMutationOptions<T, V, E> {
  mutationFn: (ctx: ActionContext, variables: V) => Promise<T>
  onSuccess?: (ctx: ActionContext, result: T, variables: V) => unknown
  onError?: (ctx: ActionContext, error: E) => unknown
  mutationKey?: readonly unknown[]
  gcTime?: number
  retry?: false
}
/** Completion and error callbacks are part of the originating action. */
export function useContextMutation<T, V = void, E = Error>(run: RunAction, options: ActionMutationOptions<T, V, E>) {
  return useMutation<T, E, V>({ mutationKey: options.mutationKey, gcTime: options.gcTime, retry: options.retry, mutationFn: variables => run(async ctx => {
    try {
      const result = await ctx.run(() => options.mutationFn(ctx, variables))
      if (options.onSuccess) await ctx.run(() => options.onSuccess!(ctx, result, variables))
      return result
    } catch (error) {
      ctx.assertCurrent()
      if (options.onError) await ctx.run(() => options.onError!(ctx, error as E))
      throw error
    }
  }) })
}
export function useGeneratedMutation<T, V = void, E = Error>(options: ActionMutationOptions<T, V, E>) {
  return useContextMutation(useGeneratedAction(), options)
}
