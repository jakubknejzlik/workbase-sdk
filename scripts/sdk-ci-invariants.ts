import { assertCoreEnumLabels } from './check-core-enum-labels'
import { checkSdkBoundary } from './check-sdk-boundary'
import { readFileSync } from 'node:fs'
assertCoreEnumLabels(JSON.parse(readFileSync('packages/core/src/query/enum-labels.json', 'utf8')))
process.exitCode = checkSdkBoundary(process.cwd(), true)
