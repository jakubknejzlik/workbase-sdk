import { spawnSync } from 'node:child_process'
import { verifyRelease } from './release-guard'
import { deploymentTarget, DeploymentTargetError } from './ci-config'

// CI wrapper only. Local operators use the explicit deploy/remove package scripts.
try {
  const { stage } = deploymentTarget()
  const command = process.argv[2]
  if (command !== 'deploy' && command !== 'remove') throw new DeploymentTargetError('Usage: deploy.ts deploy|remove [--generate-only]')
  if (command === 'remove' && process.env.WORKBASE_TARGET !== 'preview') throw new DeploymentTargetError('CI cleanup is limited to previews')
  if (stage === 'production') {
    try { await verifyRelease() }
    catch (error) { throw new DeploymentTargetError(`Ověření vydání selhalo: ${(error as Error).message}`) }
  }
  if (process.argv.includes('--generate-only')) console.log(JSON.stringify({ command, stage }))
  else {
    const result = spawnSync('sst', [command, '--stage', stage], { stdio: 'inherit' })
    if (result.error) throw Error('SST could not start')
    process.exitCode = result.status ?? 1
  }
} catch (error) {
  if (!(error instanceof DeploymentTargetError)) throw error
  console.error(`error ${error.code}: ${error.message}`)
  process.exitCode = 1
}
