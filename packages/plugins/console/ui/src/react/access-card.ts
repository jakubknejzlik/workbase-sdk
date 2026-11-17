import { createElement as h, useId, useState } from 'react'
import { ApiFailure } from '../client'
import type { Translate } from '../i18n'
import { reasonKey } from './index'
export type AccessState = {
  state: 'no_account' | 'invited' | 'expired' | 'linked'
  account: { id: string; display_name: string; email: string } | null
  invitation: { id: string; email: string; expires_at: string } | null
}
export type Member = { user_id: string; email: string }
export type AccessBinding = {
  state: AccessState
  actions: Record<string, { enabled: boolean; reason?: string }>
  run(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>
  candidates?: () => Promise<Member[]>
}
const clipboard = globalThis as typeof globalThis & { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
/** A declared slot consumer: no entity names, record IDs, client or copied server state. */
export function AccessCard({ access, t: translate }: { account?: unknown; access?: AccessBinding; t: Translate }) {
  const id = useId()
  const [email, setEmail] = useState(''), [selected, setSelected] = useState(''), [members, setMembers] = useState<Member[] | null>(null)
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<unknown>(), [outbox, setOutbox] = useState<string>()
  if (!access) return null
  const { state, actions } = access
  async function run(name: string) {
    if (!access || pending || !Object.hasOwn(actions, name) || !actions[name].enabled) return
    setFailure(undefined)
    if (name === 'invite' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFailure(new ApiFailure(400, 'validation_error')); return }
    setPending(true)
    try {
      if (name === 'link_account' && members === null) {
        if (access.candidates) setMembers(await access.candidates())
        return
      }
      if (name === 'link_account' && !selected) { setFailure(new ApiFailure(400, 'validation_error')); return }
      setOutbox(undefined)
      const result = await access.run(name, name === 'invite' ? { email: email.trim() } : name === 'link_account' ? { user_id: selected } : {})
      if (name === 'invite' && typeof result.accept_url === 'string') setOutbox(result.accept_url)
    } catch (error) { setFailure(error) }
    finally { setPending(false) }
  }
  async function copy() {
    try { if (outbox) await clipboard.navigator?.clipboard?.writeText(outbox) }
    catch (error) { setFailure(error) }
  }
  return h('section', { 'aria-label': translate('sdk:card.title') },
    h('h2', null, translate('sdk:card.title')),
    h('p', null, translate('sdk:card.' + state.state)),
    state.account && h('p', null, state.account.display_name + ' · ' + state.account.email),
    state.invitation && h('p', null, state.invitation.email + ' · ' + state.invitation.expires_at),
    h('p', null, translate('sdk:card.membershipStays')),
    ...['invite', 'cancel_invite', 'link_account', 'unlink_account'].filter(name => Object.hasOwn(actions, name)).map(name => {
      const action = actions[name], reason = !action.enabled && action.reason
      return h('div', { key: name },
        name === 'invite' && action.enabled && h('label', null, translate('sdk:card.email'), h('input', { type: 'email', value: email, disabled: pending, onChange: (event: { target: { value: string } }) => setEmail(event.target.value) })),
        name === 'link_account' && members !== null && access.candidates && h('div', null, h('label', { htmlFor: id + '-account' }, translate('sdk:card.account')), h('select', { id: id + '-account', value: selected, disabled: pending, onChange: (event: { target: { value: string } }) => setSelected(event.target.value) }, h('option', { value: '' }, translate('sdk:card.choose')), ...members.map(member => h('option', { key: member.user_id, value: member.user_id }, member.email)))),
        h('button', { type: 'button', disabled: pending || !action.enabled || name === 'link_account' && !access.candidates, 'aria-describedby': reason ? id + '-' + name : undefined, onClick: () => { void run(name) } }, translate('sdk:card.' + name)),
        name === 'link_account' && action.enabled && !access.candidates && h('span', null, translate('sdk:card.candidatesUnavailable')),
        reason && h('span', { id: id + '-' + name }, translate(reasonKey(reason))))
    }),
    !!failure && h('p', { role: 'alert' }, translate(failure instanceof ApiFailure && failure.reason ? reasonKey(failure.reason) : failure instanceof ApiFailure && failure.status === 400 ? 'sdk:validation' : 'sdk:network')),
    outbox && h('div', null, h('label', null, translate('sdk:card.outbox'), h('input', { readOnly: true, value: outbox, onFocus: (event: { target: { select(): void } }) => event.target.select() })), h('button', { type: 'button', onClick: () => { void copy() } }, translate('sdk:card.copy'))))
}
