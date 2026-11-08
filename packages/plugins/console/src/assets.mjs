import { fileURLToPath } from 'node:url'

/** Absolute prebuilt console directory, suitable for provision({ assetsDir }).
 * Resolve the installed export so this also works from an SST-bundled program.
 */
export function consoleAssetsDir() {
  return fileURLToPath(new URL('../assets/', import.meta.resolve('@workbasehq/plugins/console/assets')))
}
