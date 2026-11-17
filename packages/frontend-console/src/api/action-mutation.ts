import { useContextMutation, type ActionMutationOptions } from '../../../console-generated/src/action-context'
import { useAuthorityAction } from './authority'

/** All callbacks, including completion and errors, share the starting authority. */
export function useActionMutation<T, V = void>(org: string | undefined, options: ActionMutationOptions<T, V, Error>) {
  return useContextMutation(useAuthorityAction(org), options)
}
