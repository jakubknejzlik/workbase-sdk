import { test, expect } from '@playwright/test'
import { observePreview500, assertNoPreview500 } from './list-v2-http'

test('HTTP 500 on an auxiliary page fails the acceptance observer and retains its body', async ({ context }, info) => {
  observePreview500(context)
  const other = await context.newPage()
  await other.route('http://diagnostic.invalid/proxy', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'diagnostic connection loss' }))
  await other.goto('http://diagnostic.invalid/proxy')
  await expect(assertNoPreview500(context, info)).rejects.toThrow('Real preview HTTP 500: acceptance failed')
  const attachment = info.attachments.find(attachment => attachment.name === 'preview-http-500.json')!
  expect(JSON.parse(attachment.body!.toString('utf8'))).toEqual([expect.objectContaining({ status: 500, body: 'diagnostic connection loss', url: 'http://diagnostic.invalid/proxy' })])
  await other.close()
})
