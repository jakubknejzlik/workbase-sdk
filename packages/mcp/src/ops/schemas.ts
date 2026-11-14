import { z } from 'zod'

export const schemas = {
  provision_organization: z.strictObject({
    name: z.string().trim().min(1).max(200), ownerEmail: z.string().trim().email(),
  }),
  read_dev_mail: z.strictObject({
    recipient: z.string().max(254).regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/),
    limit: z.number().int().min(1).max(50).default(20),
  }),
}
export type ToolName = keyof typeof schemas
export const descriptions: Record<ToolName, string> = {
  provision_organization: 'Provision an organization for an already verified ownerEmail using the operator token. Returns owner_sign_in_required until the owner signs in. Repeating the same ownerEmail/name replays the original receipt. Does not create a session or grant a caller-selected role.',
  read_dev_mail: 'Read recent messages for one exact, case-sensitive recipient from the separately configured dev/test mailbox sidecar. Returns credential-bearing message bodies intentionally. Empty mail returns messages: []; expired or used links can remain visible and normal authentication enforces expiry and one-time use. Limit defaults to 20, maximum 50.',
}
