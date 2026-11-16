import { expect, it } from 'vitest'
import { invitationMailbox } from './helpers/invitation-mailbox'

function invitationUrl() {
  const url = new URL('/invitations/accept', 'https://identity.example.test')
  url.searchParams.set('token', ['a'.repeat(32), 'b'.repeat(64)].join('.'))
  return url
}

it('preserves extra query parameters so the only-token assertion rejects them', async () => {
  const mailbox = invitationMailbox()
  const delivered = invitationUrl()
  delivered.searchParams.set('redirect', '/after-accept')
  await mailbox.delivery.EMAIL.send({ text: delivered.href } as EmailMessageBuilder)

  const link = mailbox.acceptUrl()
  // Compare credentials only as booleans so a failure cannot print the URL.
  expect(link.href === delivered.href).toBe(true)
  expect(link.origin).toBe(delivered.origin)
  expect(link.pathname).toBe('/invitations/accept')
  expect([...link.searchParams.keys()]).toEqual(['token', 'redirect'])
  expect(() => expect([...link.searchParams.keys()]).toEqual(['token'])).toThrow()
})

it.each([
  ['space', ' '], ['newline', '\n'], ['double quote', '"'],
  ['single quote', "'"], ['opening angle bracket', '<'], ['closing angle bracket', '>'],
  ['end of message', ''],
])('stops the complete URL at %s', async (_, delimiter) => {
  const mailbox = invitationMailbox()
  const delivered = invitationUrl()
  await mailbox.delivery.EMAIL.send({
    text: `${delivered.href}${delimiter}${delimiter ? 'trailing-content' : ''}`,
  } as EmailMessageBuilder)

  expect(mailbox.acceptUrl().href === delivered.href).toBe(true)
})

it('selects the latest invitation and skips later non-invitation messages', async () => {
  const mailbox = invitationMailbox()
  const earlier = invitationUrl()
  const latest = invitationUrl()
  latest.searchParams.set('redirect', '/latest')
  for (const text of [earlier.href, latest.href, new URL('/auth/sign-in', latest.origin).href]) {
    await mailbox.delivery.EMAIL.send({ text } as EmailMessageBuilder)
  }

  expect(mailbox.acceptUrl().href === latest.href).toBe(true)
})

it('reports a credential-free error when no invitation has been delivered', async () => {
  const mailbox = invitationMailbox()
  expect(() => mailbox.acceptUrl()).toThrowError(/^No delivered invitation accept URL$/)

  await mailbox.delivery.EMAIL.send({ text: new URL('/auth/sign-in', invitationUrl().origin).href } as EmailMessageBuilder)
  expect(() => mailbox.acceptUrl()).toThrowError(/^No delivered invitation accept URL$/)
})
