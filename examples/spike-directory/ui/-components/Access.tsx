import { t } from '../../src/i18n'
export function AccessBadge({ user }: { user: unknown }) { return <span className="badge">{t(user ? 'workers.access.active' : 'workers.access.none')}</span> }
export function Access({ user, allowInvite, allowRevoke }: { user: unknown; allowInvite: boolean; allowRevoke: boolean; field: 'user' }) {
  return <aside className="card access" data-testid="access-slot"><span className="eyebrow">{t('workers.access.slot')}</span><h2>{t('workers.access.title')}</h2><AccessBadge user={user} /><p>{t('workers.access.placeholder')}</p><div className="stack">{allowInvite && <button disabled title={t('workers.access.unavailable')}>{t('workers.access.invite')}</button>}{allowRevoke && <button disabled title={t('workers.access.unavailable')}>{t('workers.access.revoke')}</button>}</div><small>{t('workers.access.unavailable')}</small></aside>
}
export function Invite({ user: _user }: { user: unknown }) { return <div className="card"><label><input type="checkbox" disabled /> {t('workers.access.inviteNow')}</label><p>{t('workers.access.placeholder')}</p></div> }
