import { defineConfig } from 'vite'
import { consoleUI } from '@workbasehq/plugins/console/ui/vite'
export default defineConfig({ plugins: [consoleUI()] })
