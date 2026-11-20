import { defineConfig } from '@playwright/test'
import acceptance from './playwright.list-v2.config'
export default defineConfig({ ...acceptance, testMatch: 'list-v2-http.spec.ts' })
