export class DeploymentTargetError extends Error {
  readonly code = 'invalid_deployment_target'
}
/** Validate CI intent before SST can read state or mutate resources. */
export function deploymentTarget(env: NodeJS.ProcessEnv = process.env) {
  const ref = env.GITHUB_REF ?? ''
  const pr = env.PR_NUMBER
  const pull = /^refs\/pull\/([1-9][0-9]*)\/(?:merge|head)$/.exec(ref)
  if (env.WORKBASE_TARGET === 'staging' && ref === 'refs/heads/main' && !pr) return { stage: 'staging' }
  // The deploy wrapper also verifies ancestry, exact checkout and green Staging evidence.
  if (env.WORKBASE_TARGET === 'production' && /^refs\/tags\/v[^\s]+$/.test(ref) && !pr) return { stage: 'production' }
  const prefix = env.WORKBASE_STAGE_PREFIX ?? ''
  if (env.WORKBASE_TARGET === 'preview' && /^[1-9][0-9]*$/.test(pr ?? '') &&
      (pull ? pull[1] === pr : ref === 'refs/heads/main') && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(prefix)) {
    const stage = `${prefix}-pr-${pr}`
    if (stage.length <= 32) return { stage }
  }
  throw new DeploymentTargetError('Staging requires main without PR_NUMBER; Production requires a verified v* tag without PR_NUMBER; preview requires a matching PR/main ref, PR_NUMBER and WORKBASE_STAGE_PREFIX (stage <=32 characters)')
}
