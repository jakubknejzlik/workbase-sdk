import { defineConfig } from 'vite'
import { uiV3 } from '@workbasehq/ui-v3/vite'
export default defineConfig({ plugins: [uiV3()], build: { outDir: 'dist' } })
