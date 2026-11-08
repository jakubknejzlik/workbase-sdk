import { Generator, getConfig } from '@tanstack/router-generator'
const config = getConfig({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts', quoteStyle: 'single' }, import.meta.dirname)
await new Generator({ config, root: import.meta.dirname }).run()
