export const csDomain = {
  'entity.worker_one': '{{count}} pracovník',
  'entity.worker_few': '{{count}} pracovníci',
  'entity.worker_many': '{{count}} pracovníka',
  'entity.worker_other': '{{count}} pracovníků',
  'field.worker.name': 'Jméno',
  'field.worker.user': 'Přístup do aplikace',
}
export const csUi = {
  'workers.list.title': 'Pracovníci',
  'workers.create.title': 'Nový pracovník',
  'workers.detail.title': 'Pracovník',
  'workers.edit.title': 'Upravit pracovníka',
  'workers.nav.title': 'Pracovníci',
}
export const csCatalogChanges = [
  { kind: 'set_catalog_entries', language: 'cs', namespace: 'domain', entries: csDomain },
  { kind: 'set_catalog_entries', language: 'cs', namespace: 'ui', entries: csUi },
]
