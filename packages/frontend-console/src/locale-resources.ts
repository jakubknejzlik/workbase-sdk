import listLabels from '../../core/src/query/enum-labels.json'
import en from './locales/en.json'
import cs from './locales/cs.json'

/** Generic console copy only. Instance localization arrives through console-model. */
// Identity controls use role_* keys; the shared catalog also serves enum values.
const roleLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).map(([key, label]) => [key.replace(/^value_/, 'role_'), label]))
export const localeResources = { en: { translation: { ...en, ...listLabels.en, ...roleLabels(listLabels.en) } }, cs: { translation: { ...cs, ...listLabels.cs, ...roleLabels(listLabels.cs) } } }
