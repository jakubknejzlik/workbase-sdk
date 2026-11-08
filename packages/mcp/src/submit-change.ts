import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { hash } from './planning.ts'
import { fail, type Change } from './schemas.ts'
import { noLink } from './storage.ts'
import type { GitHubConfiguration, CheckRun } from './github.ts'

export const promotedFilesSchema = z.array(z.strictObject({ path: z.string(), data: z.string() })).min(1)
export type PromotedFiles = z.infer<typeof promotedFilesSchema>
export const migrationPreviewSchema = z.strictObject({ sql: z.string(), configDiff: z.unknown(), revision: z.number().int() })
type Submission = {
  proposalId: string; instance: string; createdAt: string; baseRevision: number; promotedRevision?: number; migration?: string
  changes: Change[]; status: string; validation?: { fingerprint: string; planHash: string; dependencyDigest?: string }; verification?: { fingerprint: string; planHash: string; dependencyDigest?: string }
  dependencyDigest?: string; promotedFiles?: PromotedFiles; migrationPreview?: z.infer<typeof migrationPreviewSchema>; promotionHash?: string
}
export function promotionHash(p: Submission) {
  return hash({ files: p.promotedFiles, preview: p.migrationPreview, verification: p.verification, ...(p.dependencyDigest !== undefined ? { dependencyDigest: p.dependencyDigest } : {}) })
}
const changeLabels: Record<Change['kind'], string> = {
  set_label: 'Úprava popisku', set_locale: 'Úprava jazyka', add_role: 'Přidání role', remove_role: 'Odebrání role',
  set_permissions: 'Úprava oprávnění', set_organization_permissions: 'Úprava oprávnění organizace',
  add_entity: 'Přidání entity', set_policy: 'Úprava pravidla přístupu', set_display_field: 'Úprava zobrazeného názvu',
  add_field: 'Přidání pole', add_computed_field: 'Přidání vypočteného pole', set_computed_field: 'Úprava výpočtu pole',
  rename_field: 'Přejmenování pole', add_relation: 'Přidání vazby', add_user_link: 'Přidání vazby na uživatele', add_index: 'Přidání indexu',
}
function changeSummary(change: Change) {
  const details = ['entity' in change ? change.entity : '', 'field' in change ? change.field : '', 'role' in change ? change.role : '',
    'from' in change ? `${change.from} → ${change.to}` : ''].filter(Boolean).join(' / ')
  return `- ${changeLabels[change.kind]}${details ? `: ${details}` : ''}`
}
function state(checks: CheckRun[]) {
  if (!checks.length || checks.some(c => c.status !== 'completed')) return 'pending'
  return checks.every(c => ['success', 'neutral', 'skipped'].includes(c.conclusion ?? '')) ? 'success' : 'failure'
}
export async function submitChange(directory: string, p: Submission, expectedBaseSha: string, configure?: GitHubConfiguration, readDependencyDigest?: () => Promise<string | undefined>) {
  if (p.status !== 'promoted') fail('promotion_required', 'Změna musí být nejprve povýšena pomocí promote.', 409)
  if (!p.validation || !p.verification || hash(p.validation) !== hash(p.verification)) fail('verification_required', 'Chybí ověření této změny.', 409)
  if (!p.promotedFiles || !p.migrationPreview || p.promotionHash !== promotionHash(p)) fail('promotion_snapshot_required', 'Chybí platný záznam souborů povýšené změny.', 409)
  const allowed = new Set(['config.ts', 'config.indexes.json', 'config.versions.json', `config.v${p.baseRevision}.ts`, `config.v${p.promotedRevision}.ts`, `migrations/${p.migration}`])
  const paths = new Set<string>()
  for (const file of p.promotedFiles) {
    if (!allowed.has(file.path) || paths.has(file.path)) fail('file_not_allowed', 'Změna obsahuje soubor mimo povolený seznam.', 409)
    paths.add(file.path)
    try {
      await noLink(join(directory, file.path))
      if (await readFile(join(directory, file.path), 'utf8') !== file.data) fail('promoted_files_changed', 'Soubory povýšené změny byly změněny.', 409)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fail('promoted_files_changed', 'Soubory povýšené změny byly změněny.', 409)
    }
  }
  const assertDependenciesUnchanged = async () => {
    const currentDependencyDigest = await readDependencyDigest?.()
    if (currentDependencyDigest !== undefined) {
      if (!p.dependencyDigest || !p.verification?.dependencyDigest || !p.validation?.dependencyDigest) fail('dependency_snapshot_required', 'Chybí záznam ověřených závislostí. Vytvořte nový návrh a proveďte validate, apply_to_disposable a promote.', 409)
      if (p.dependencyDigest !== p.verification.dependencyDigest || p.dependencyDigest !== currentDependencyDigest) fail('dependencies_changed', 'Závislosti instance se změnily. Návrh je nutné znovu ověřit; vytvořte nový návrh a proveďte validate, apply_to_disposable a promote.', 409)
    }
  }
  await assertDependenciesUnchanged()
  const target = await configure?.(p.instance)
  await assertDependenciesUnchanged()
  if (!target) fail('github_not_configured', 'Přístup ke GitHubu není nakonfigurován. Obraťte se na provozovatele.', 503)
  // This prefix comes only from the operator; tool arguments cannot select a repository or path.
  const prefix = target.directory
  if (prefix && (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(prefix) || prefix.split('/').some(s => s === '.' || s === '..'))) fail('invalid_github_config', 'Neplatné nastavení adresáře instance.', 500)
  const github = target.github
  if (await github.ref(target.baseBranch) !== expectedBaseSha) fail('stale_base', 'Základní větev se změnila. Ověřte aktuální SHA.', 409)
  const branch = `workbase/change-${p.proposalId}`
  const base = await github.commit(expectedBaseSha)
  const entries = []
  for (const file of p.promotedFiles) {
    entries.push({ path: [prefix, file.path].filter(Boolean).join('/'), mode: '100644', type: 'blob', sha: await github.createBlob(file.data, assertDependenciesUnchanged) })
  }
  const tree = await github.createTree(base.tree.sha, entries, assertDependenciesUnchanged)
  // Verify the complete remote diff, including additions/deletions/modes outside the allowlist.
  const before = new Map((await github.tree(base.tree.sha)).filter(e => e.type !== 'tree').map(e => [e.path, e]))
  const after = new Map((await github.tree(tree)).filter(e => e.type !== 'tree').map(e => [e.path, e]))
  const written = new Map(entries.map(e => [e.path, e]))
  for (const path of new Set([...before.keys(), ...after.keys(), ...written.keys()])) {
    const expected = written.get(path) ?? before.get(path)
    const actual = after.get(path)
    if (JSON.stringify(expected && [expected.sha, expected.mode, expected.type]) !== JSON.stringify(actual && [actual.sha, actual.mode, actual.type])) fail('file_not_allowed', 'Větev obsahuje neočekávané změny souborů.', 409)
  }
  const headSha = await github.createCommit(tree, expectedBaseSha, `Workbase: změna ${p.proposalId}`, p.createdAt, assertDependenciesUnchanged)
  const existing = await github.ref(branch)
  if (existing && existing !== headSha) fail('submission_conflict', 'Větev změny již obsahuje jiný commit.', 409)
  // Recheck immediately before publishing; never advance or force-push an existing branch.
  if (await github.ref(target.baseBranch) !== expectedBaseSha) fail('stale_base', 'Základní větev se změnila. Ověřte aktuální SHA.', 409)
  if (!existing) {
    await github.createRef(branch, headSha, assertDependenciesUnchanged)
  }
  const prs = await github.findPullRequests(branch)
  if (prs.length > 1) fail('submission_conflict', 'Pro tuto změnu existuje více PR.', 409)
  const title = `Změna konfigurace instance ${p.instance}`
  const body = `## Shrnutí změny\n\nInstance ${p.instance}, revize ${p.baseRevision} → ${p.promotedRevision}.\n\n${p.changes.map(changeSummary).join('\n')}\n\nZměny konfigurace:\n\n\`\`\`json\n${JSON.stringify(p.migrationPreview.configDiff, null, 2)}\n\`\`\`\n\nSoubory změny:\n${p.promotedFiles.map(f => `- ${f.path}`).join('\n')}\n\n## Shrnutí migrace\n\nMigrace ${p.migration}:\n\n\`\`\`sql\n${p.migrationPreview.sql}\n\`\`\`\n\nPR čeká na kontrolu. Tento nástroj neslučuje PR ani nenasazuje změnu.`
  let pr = prs[0]
  if (!pr) {
    pr = await github.createPullRequest(branch, target.baseBranch, title, body, assertDependenciesUnchanged)
  }
  if (pr.head.sha !== headSha || pr.base.ref !== target.baseBranch) fail('submission_conflict', 'PR obsahuje jiný commit nebo základní větev.', 409)
  const checks = await github.checks(headSha)
  return { ok: true, prUrl: pr.html_url, prNumber: pr.number, headSha, checkState: state(checks), previewState: state(checks.filter(c => /preview/i.test(c.name))) }
}
