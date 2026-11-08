export interface Actor { type: 'user' | 'agent' | 'service'; id: string; tokenId?: string }
export interface Scope { organizationId: string; actor: Actor; role: string; correlationId: string }
