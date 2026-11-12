import { resolve } from 'node:path'
import { generateRouteWrappers } from '@workbasehq/ui-v3/vite'
await generateRouteWrappers(resolve(import.meta.dirname, '..'))
console.log('V3 TanStack wrappers/tree generated outside ui/')
