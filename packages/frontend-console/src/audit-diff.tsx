import { formatFieldValue, type Field } from '@workbasehq/console-generated/read'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuditEvent } from './api/workflows'
import { isCredentialShaped } from './api/redact'

function humanizeKey(key: string) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

type AuditNode = { text: string; empty?: boolean } | { entries: { label: string; value: AuditNode }[] }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function equal(before: unknown, after: unknown): boolean {
  if (before === after) return true
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) return false
  const left = Object.entries(before), right = Object.entries(after)
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(after, key) && equal(value, (after as Record<string, unknown>)[key]))
}

type LeafChange = { path: string[]; before: unknown; after: unknown }
function changedLeaves(before: unknown, after: unknown, path: string[]): LeafChange[] {
  if ((isObject(before) || before == null) && (isObject(after) || after == null) && (isObject(before) || isObject(after))) {
    if (equal(before, after)) return []
    if (path.length >= 3) return [{ path, before: isObject(before) ? '…' : before, after: isObject(after) ? '…' : after }]
    const left = isObject(before) ? before : {}, right = isObject(after) ? after : {}
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    if (keys.length) return keys.flatMap(key => equal(left[key], right[key]) ? [] : changedLeaves(left[key], right[key], [...path, key]))
  }
  return [{ path, before, after }]
}

/** Inspect original leaves before joining arrays or constructing rendered content. */
function maskValue(value: unknown, label: (key: string) => string, copy: { redacted: string; empty: string; yes: string; no: string }): AuditNode {
  if (value == null || value === '') return { text: copy.empty, empty: true }
  if (typeof value === 'string') return { text: isCredentialShaped(value) ? copy.redacted : value }
  if (typeof value === 'boolean') return { text: value ? copy.yes : copy.no }
  if (typeof value !== 'object') return { text: String(value) }
  const entries = Object.entries(value).map(([key, item]) => ({
    label: isCredentialShaped(key) ? copy.redacted : Array.isArray(value) ? `[${Number(key) + 1}]` : label(key),
    value: maskValue(item, label, copy),
  }))
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return { text: entries.map(entry => (entry.value as { text: string }).text).join(', ') || '[]' }
  return entries.length ? { entries } : { text: '{}' }
}

function AuditText({ value }: { value: { text: string; empty?: boolean } }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false), [clipped, setClipped] = useState(false)
  const ref = useRef<HTMLSpanElement>(null), id = useId()
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => { if (!expanded) setClipped(element.scrollHeight > element.clientHeight) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, value.text])
  return <><span ref={ref} id={id} className={`c5-audit-value${expanded ? '' : ' c5-audit-clamp'}${value.empty ? ' text-muted-foreground' : ''}`}>{value.text}</span>
    {(clipped || expanded) && <button type="button" className="c5-audit-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'auditLessValue' : 'auditFullValue')}</button>}
  </>
}

function AuditContent({ value, depth = 0 }: { value: AuditNode; depth?: number }) {
  if ('text' in value) return <AuditText value={value} />
  if (depth > 3) return <span>…</span>
  return <dl className="c5-audit-nested">{value.entries.map((entry, index) => <div key={index}>
    <dt>{entry.label}: </dt><dd><AuditContent value={entry.value} depth={depth + 1} /></dd>
  </div>)}</dl>
}

export function AuditDiff({ event, fieldLabel, fields, referenceLabel }: { event: AuditEvent; fields?: Record<string, Field>; referenceLabel?: (field: string, id: unknown) => string; fieldLabel?: (field: string) => string | undefined }) {
  const { t, i18n } = useTranslation()
  const changes = Object.entries(event.changes ?? {})
  const label = (field: string) => {
    if (isCredentialShaped(field)) return t('redactedValue')
    const value = fieldLabel?.(field) || t(`field_${field}`, { defaultValue: humanizeKey(field) })
    return isCredentialShaped(value) ? t('redactedValue') : value
  }
  const copy = { redacted: t('redactedValue'), empty: t('auditEmpty'), yes: t('yes'), no: t('no') }
  const operation = event.operation.split('.').at(-1)
  const create = operation === 'created' || operation === 'create'
  const remove = operation === 'deleted' || operation === 'delete'
  const leaves = changes.flatMap(([field, change]) => changedLeaves(create ? undefined : change.before, remove ? undefined : change.after, [field]))
  const content = (value: unknown, path: string[]) => {
    const masked = maskValue(value, label, copy)
    const spec = path.length === 1 ? fields?.[path[0]] : undefined
    if (!spec || value == null || value === '' || typeof value === 'object' || typeof value === 'string' && isCredentialShaped(value)) return masked
    const text = spec.type === 'ref' ? referenceLabel?.(path[0], value) ?? t('unavailableRecord') : formatFieldValue(value, spec, i18n.language, (key, options) => String(t(key, { context: event.entity, ...options })))
    return maskValue(text, label, copy)
  }
  return <>
    <summary>{changes.length ? <>{t('auditFieldCount', { count: changes.length })}: {changes.slice(0, 3).map(([field]) => label(field)).join(', ')}{changes.length > 3 ? ', …' : ''}</> : t('auditDetails')}</summary>
    {leaves.length ? <dl className="c5-audit-diff">{leaves.map(({ path, before, after }, index) => <div key={index}>
      <dt className="font-medium">{path.map(label).join(' › ')}</dt>
      <dd className="c5-audit-pair">
        {!create && <div><span className="c5-audit-value-label">{t(remove ? 'auditRemoved' : 'auditBefore')}: </span><AuditContent value={content(before, path)} /></div>}
        {!create && !remove && <span className="c5-audit-arrow" aria-hidden="true">→</span>}
        {!remove && <div><span className="c5-audit-value-label">{t(create ? 'auditSetTo' : 'auditAfter')}: </span><AuditContent value={content(after, path)} /></div>}
      </dd>
    </div>)}</dl> : <p>{t('auditNoChanges')}</p>}
  </>
}
