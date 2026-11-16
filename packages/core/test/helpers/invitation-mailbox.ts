/** Capture the delivered mailbox proof, following invitation-mailbox-proof.test.ts. */
export function invitationMailbox() {
  const messages: EmailMessageBuilder[] = []
  return {
    messages,
    delivery: {
      EMAIL_FROM: ['noreply', 'example.test'].join('@'),
      EMAIL: { send: async (message: EmailMessage | EmailMessageBuilder) => {
        messages.push(message as EmailMessageBuilder)
        return { messageId: 'synthetic' }
      } },
    },
    acceptUrl(): URL {
      for (const message of [...messages].reverse()) {
        const link = message.text?.match(/https?:\/\/[^\s"'<>]+\/invitations\/accept\?[^\s"'<>]+/)?.[0]
        if (link) return new URL(link)
      }
      // Never include captured mail or credentials in assertion output.
      throw new Error('No delivered invitation accept URL')
    },
  }
}
