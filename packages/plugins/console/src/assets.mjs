import { fileURLToPath } from 'node:url'

/** Absolute packaged generic-console directory, separate from Instance dist/console.
 * Resolve the installed export so this also works from an SST-bundled program.
 */
export function consoleAssetsDir() {
  return fileURLToPath(new URL('../assets/', import.meta.resolve('@workbasehq/plugins/console/assets')))
}
