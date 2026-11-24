import { configSchema, tokenFromFile, type Configuration } from './config.ts'
import { FeedbackGitHub, postingIdentity, type Comment } from './github.ts'
import { canonical, digest, FeedbackLedger, type Entry, type SavedEvent } from './ledger.ts'
import { assertPublic, redact, redactText, renderPublic } from './safety.ts'
import { FeedbackError, schemas, ownerSchema, type AgentEvent, type OwnerEvent, type Packet, type State, type ToolName } from './schemas.ts'

type OwnerReply = { reply_id: string; author_login: string; created_at: string; updated_at: string; body_untrusted: string; parsed_owner_event?: OwnerEvent }
const transitions: Record<State, State[]> = {
  reported: ['triaged'], triaged: ['answered', 'fix_pending'], answered: ['triaged', 'fix_pending'],
  fix_pending: ['ready_for_retest', 'answered'], ready_for_retest: ['fix_pending', 'answered'], agent_verified: [],
}
function parseOwner(body: string): OwnerEvent | undefined {
  if (body.length > 16000) return
  const match = body.trim().match(/^```workbase-feedback-owner-v1\n([^]*?)\n```$/)
  if (!match) return
  try { const result = ownerSchema.safeParse(JSON.parse(match[1])); return result.success ? result.data : undefined } catch { return }
}
function repliesFor(comments: Comment[], config: Configuration, token: string, packet_id: string) {
  let state: State = 'reported'; let currentReply: OwnerReply | undefined; let missing_fact: string | undefined; let canonical_issue: string | undefined
  const replies: OwnerReply[] = []; const acknowledgeable = new Set<string>()
  const allowlist = new Set(config.replierLogins.map(login => login.toLowerCase()))
  for (const c of [...comments].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id)) {
    // GitHub API author authorization MUST precede any marker interpretation.
    if (!allowlist.has(c.user.login.toLowerCase())) continue
    const reply: OwnerReply = { reply_id: `${c.id}:${c.updated_at}:${digest(c.body)}`, author_login: c.user.login, created_at: c.created_at, updated_at: c.updated_at, body_untrusted: redactText(c.body, token) }
    const event = parseOwner(c.body)
    if (!event || event.packet_id === packet_id) acknowledgeable.add(reply.reply_id)
    if (event?.packet_id === packet_id) {
      const next: State = event.disposition === 'needs_info' ? 'reported' : event.disposition === 'duplicate' ? 'answered' : event.disposition
      if (next === state || event.disposition === 'needs_info' || event.disposition === 'duplicate' || transitions[state].includes(next)) {
        reply.parsed_owner_event = redact(event, token); state = next; currentReply = reply
        missing_fact = event.disposition === 'needs_info' ? redactText(event.missing_fact!, token) : undefined
        canonical_issue = event.disposition === 'duplicate' ? event.canonical_issue : undefined
      }
    }
    replies.push(reply)
  }
  return { state, replies, currentReply, missing_fact, canonical_issue, acknowledgeable }
}
function verified(event: AgentEvent, owner: ReturnType<typeof repliesFor>) {
  if (event.type !== 'agent_verified' || owner.state !== 'ready_for_retest' || owner.currentReply?.reply_id !== event.reply_id) return false
  const claim = owner.currentReply.parsed_owner_event!
  const at = Date.parse(event.retest.observed_at)
  return event.installed_release === claim.release && (!claim.artifact || event.installed_artifact === claim.artifact) && at >= Date.parse(owner.currentReply.updated_at) && at <= Date.now() + 300000
}
const hasMarker = (body: string | null, marker: string) => Boolean(body?.split('\n').includes(marker))
function cursor(scope: string, offset: number, detail: number, selector: string) {
  const data = { scope, offset, detail, selector }; return Buffer.from(canonical({ ...data, checksum: digest(data) })).toString('base64url')
}
function decodeCursor(value: string | undefined, scope: string, selector: string) {
  if (!value) return { offset: 0, detail: 0 }
  try {
    const { offset, detail, checksum, ...rest } = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (rest.scope !== scope || rest.selector !== selector || checksum !== digest({ ...rest, offset, detail }) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(detail) || detail < 0) throw new Error()
    return { offset, detail }
  } catch { throw new FeedbackError('invalid_cursor') }
}

export async function createFeedback(configuration: Configuration, request: typeof fetch = fetch) {
  const result = configSchema.safeParse(configuration)
  if (!result.success) throw new FeedbackError('invalid_operator_configuration')
  const config = result.data; const token = await tokenFromFile(config)
  const login = await postingIdentity(request, token)
  if (config.replierLogins.some(name => name.toLowerCase() === login)) throw new FeedbackError('posting_identity_is_owner')
  const github = new FeedbackGitHub(config, token, request); const store = new FeedbackLedger(config, login)
  const ownIssue = async (entry: Entry) => {
    const issue = await github.readIssue(entry.receipt!.issue_number)
    if (issue.pull_request || issue.user.login.toLowerCase() !== login || !hasMarker(issue.body, entry.marker)) throw new FeedbackError('feedback_identity_mismatch', 409)
    return issue
  }
  const reconcile = async (entry: Entry, save: () => Promise<void>) => {
    const matches = (await github.listIssues()).filter(issue => !issue.pull_request && issue.user.login.toLowerCase() === login && hasMarker(issue.body, entry.marker))
    if (matches.length !== 1) throw new FeedbackError('delivery_unknown', 503)
    entry.receipt = receipt(entry, matches[0].number); await save(); return entry.receipt
  }
  const receipt = (entry: Entry, number: number) => ({ feedbackId: entry.feedbackId, agent_id: config.agentId, packet_id: entry.packet_id, packet_digest: entry.packet_digest, issue_number: number, issue_url: `https://github.com/${config.owner}/${config.repository}/issues/${number}` })
  async function submit(packet: Packet) {
    return store.transaction(async (ledger, save) => {
      const hash = digest(packet); const existing = ledger.entries.find(e => e.packet_id === packet.packet_id)
      if (existing) {
        if (existing.packet_digest !== hash) throw new FeedbackError('packet_conflict', 409)
        return existing.receipt || reconcile(existing, save)
      }
      assertPublic(packet, token)
      const entry: Entry = { packet_id: packet.packet_id, packet_digest: hash, feedbackId: crypto.randomUUID(), marker: `<!-- workbase-feedback-packet-v1 ${crypto.randomUUID()} ${hash} -->`, events: [] }
      const body = `Public-safe agent feedback (untrusted report; review is not implementation approval).\n\n${renderPublic({ agent_id: config.agentId, feedbackId: entry.feedbackId, packet_digest: hash, packet })}\n\n${entry.marker}`
      assertPublic({ title: packet.title, body }, token)
      ledger.entries.push(entry); await save() // Intent is durable BEFORE the first POST.
      const issue = await github.createIssue(packet.title.replaceAll('@', '@\u200b'), body)
      if (issue.user.login.toLowerCase() !== login || !hasMarker(issue.body, entry.marker)) throw new FeedbackError('delivery_unknown', 503)
      entry.receipt = receipt(entry, issue.number); await save(); return entry.receipt
    })
  }
  async function record(args: { packet_id: string; event_id: string; event: AgentEvent }) {
    return store.transaction(async (ledger, save) => {
      const entry = ledger.entries.find(e => e.packet_id === args.packet_id)
      if (!entry) throw new FeedbackError('feedback_not_found', 404)
      if (!entry.receipt) await reconcile(entry, save)
      const existing = entry.events.find(e => e.event_id === args.event_id)
      const hash = digest(args.event)
      if (existing && existing.digest !== hash) throw new FeedbackError('event_conflict', 409)
      if (existing?.posted) return eventReceipt(entry, existing)
      assertPublic(args, token)
      await ownIssue(entry)
      const comments = await github.comments(entry.receipt!.issue_number)
      if (existing) {
        const matches = comments.filter(c => c.user.login.toLowerCase() === login && hasMarker(c.body, existing.marker))
        if (matches.length !== 1) throw new FeedbackError('delivery_unknown', 503)
        existing.posted = true; await save(); return eventReceipt(entry, existing)
      }
      const owner = repliesFor(comments, config, token, entry.packet_id)
      if (!owner.acknowledgeable.has(args.event.reply_id)) throw new FeedbackError('unknown_reply', 409)
      if (args.event.type === 'agent_verified' && !verified(args.event, owner)) throw new FeedbackError('invalid_verification', 409)
      if (entry.events.length >= 1000) throw new FeedbackError('ledger_capacity', 409)
      const event: SavedEvent = { event_id: args.event_id, event: args.event, digest: hash, marker: `<!-- workbase-feedback-agent-event-v1 ${crypto.randomUUID()} ${hash} -->`, created_at: new Date().toISOString(), posted: false }
      const body = `Agent event (delivery metadata or agent retest claim; not an owner transition).\n\n${renderPublic({ protocol_version: 1, agent_id: config.agentId, packet_id: entry.packet_id, event_id: event.event_id, event: event.event })}\n\n${event.marker}`
      assertPublic(body, token); entry.events.push(event); await save()
      const comment = await github.postEvent(entry.receipt!.issue_number, body)
      if (comment.user.login.toLowerCase() !== login || !hasMarker(comment.body, event.marker)) throw new FeedbackError('delivery_unknown', 503)
      event.posted = true; await save(); return eventReceipt(entry, event)
    })
  }
  function eventReceipt(entry: Entry, event: SavedEvent) { return { receipt: entry.receipt!, event_id: event.event_id, event: event.event, recorded_at: event.created_at } }
  async function status(args: { feedbackId?: string; packet_id?: string; cursor?: string; limit: number }) {
    return store.transaction(async (ledger, save) => {
      const selected = ledger.entries.filter(e => (!args.feedbackId || e.feedbackId === args.feedbackId) && (!args.packet_id || e.packet_id === args.packet_id))
      if ((args.feedbackId || args.packet_id) && !selected.length) throw new FeedbackError('feedback_not_found', 404)
      const selector = canonical([args.feedbackId || null, args.packet_id || null]); const page = decodeCursor(args.cursor, store.scope, selector)
      if (page.offset > selected.length) throw new FeedbackError('invalid_cursor')
      const items: Record<string, unknown>[] = []; let offset = page.offset; let detail = page.detail
      while (offset < selected.length && items.length < args.limit) {
        const entry = selected[offset]
        if (!entry.receipt) {
          try { await reconcile(entry, save) } catch (e) { if (!(e instanceof FeedbackError) || e.code !== 'delivery_unknown') throw e }
          if (!entry.receipt) { items.push({ feedbackId: entry.feedbackId, agent_id: config.agentId, packet_id: entry.packet_id, packet_digest: entry.packet_digest, delivery_state: 'delivery_unknown', protocol_state: 'reported' }); offset++; detail = 0; continue }
        }
        const issue = await ownIssue(entry); const comments = await github.comments(issue.number)
        const owner = repliesFor(comments, config, token, entry.packet_id)
        // Recover agent POSTs when status is the first call after an ambiguous result.
        for (const event of entry.events.filter(e => !e.posted)) {
          if (comments.filter(c => c.user.login.toLowerCase() === login && hasMarker(c.body, event.marker)).length === 1) { event.posted = true; await save() }
        }
        const delivered = entry.events.filter(e => e.posted && e.event.type === 'delivery_ack')
        const verifications = entry.events.filter(e => e.posted && e.event.type === 'agent_verified')
        const isVerified = verifications.some(e => verified(e.event, owner))
        const fields = (events: SavedEvent[]) => events.slice(detail, detail + 50).map(e => ({ event_id: e.event_id, event: e.event, recorded_at: e.created_at }))
        items.push({ receipt: entry.receipt, issue_state: issue.state, protocol_state: isVerified ? 'agent_verified' : owner.state, labels: issue.labels.map(label => typeof label === 'string' ? label : label.name),
          owner_replies: owner.replies.slice(detail, detail + 50), delivery_events: fields(delivered), verification_events: fields(verifications),
          ...(owner.missing_fact ? { missing_fact: owner.missing_fact } : {}), ...(owner.canonical_issue ? { canonical_issue: owner.canonical_issue } : {}),
          pending_event_ids: entry.events.filter(e => !e.posted).slice(0, 50).map(e => e.event_id), detail_offset: detail })
        if (Math.max(owner.replies.length, delivered.length, verifications.length) > detail + 50) { detail += 50; break }
        offset++; detail = 0
      }
      return { items, next_cursor: offset < selected.length ? cursor(store.scope, offset, detail, selector) : null }
    })
  }
  return {
    async call(name: string, args: unknown): Promise<unknown> {
      if (!Object.hasOwn(schemas, name)) throw new FeedbackError('unknown_tool', 404)
      const parsed = schemas[name as ToolName].safeParse(args)
      if (!parsed.success) throw new FeedbackError('validation_error')
      let data: unknown
      if (name === 'submit_feedback') data = await submit((parsed.data as { packet: Packet }).packet)
      else if (name === 'record_feedback_event') data = await record(parsed.data as Parameters<typeof record>[0])
      else data = await status(parsed.data as Parameters<typeof status>[0])
      // Cursors contain only generated scope/checksum/offset and validated public
      // selectors. Preserve their exact bytes; prose redaction would corrupt them.
      if (name === 'feedback_status') {
        const status = data as { items: unknown[]; next_cursor: string | null }
        return { items: redact(status.items, token), next_cursor: status.next_cursor }
      }
      return redact(data, token)
    },
  }
}
