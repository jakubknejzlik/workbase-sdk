export function realModelEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Limit credential inheritance to model authentication and Workbase fixture inputs.
  // NODE_OPTIONS preserves the documented local-network-only guard for the MCP child.
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    ['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'NODE_OPTIONS'].includes(key) || /^(WORKBASE_|OPENAI_)/.test(key),
  ))
}
