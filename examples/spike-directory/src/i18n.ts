import i18next from 'i18next'
import { sdkEnglish } from '@workbasehq/ui-v3/messages'
import domain from '../locales/en/domain.json'
import ui from '../locales/en/ui.json'
import config from '../config'
await i18next.init({ lng: config.languages[0], fallbackLng: false, defaultNS: 'ui', keySeparator: false, resources: { en: { domain, ui, sdk: sdkEnglish } }, initImmediate: false })
export const t = (key: string, options: Record<string, unknown> = {}): string => String(i18next.t(key, options))
