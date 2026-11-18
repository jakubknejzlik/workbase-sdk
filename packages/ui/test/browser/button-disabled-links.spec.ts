import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) for (const mode of ['disabled', 'aria', 'both', 'child-aria']) {
  test(`${theme} ${mode}: disabled links have no destination and re-enabled links open normally`, async ({ page, context }, testInfo) => {
    await page.goto(`/button-disabled-links.html?theme=${theme}&mode=${mode}`)
    const originalURL = page.url()
    const link = page.getByText('Destination', { exact: true })
    await expect(link).toHaveAttribute('aria-disabled', 'true')
    await expect(link).not.toHaveAttribute('href')
    await expect(link).toHaveAttribute('tabindex', '-1')
    expect(await link.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))).toBe(true)
    // Observe cancellation after React capture guards without relying on bubble
    // handlers, which a disabled link must never reach.
    await page.evaluate(() => {
      const events: { type: string; prevented: boolean }[] = []
      Object.assign(window, { auxiliaryEvents: events })
      for (const type of ['mousedown', 'auxclick']) window.addEventListener(type, event => {
        if ((event as MouseEvent).button !== 1) return
        setTimeout(() => events.push({ type, prevented: event.defaultPrevented }), 0)
      }, true)
    })
    // Physical input bypasses Playwright's disabled-element actionability guard.
    const middleClick = async () => {
      const box = (await link.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' })
    }
    await middleClick()
    const events = () => page.evaluate(() => (window as unknown as { auxiliaryEvents: { type: string; prevented: boolean }[] }).auxiliaryEvents)
    await expect.poll(events).toHaveLength(2)
    // The disabled anchor has no native destination. The enabled control below
    // must actually open a new tab.
    await page.waitForTimeout(200)
    const disabled = { events: await events(), pages: context.pages().map(tab => tab.url()), handlers: await page.getByLabel('Handlers').textContent() }
    await testInfo.attach('disabled-auxclick', { body: JSON.stringify(disabled), contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath('disabled-link.png'), fullPage: true })
    expect(disabled.pages).toEqual([originalURL])
    expect(disabled.events).toEqual([{ type: 'mousedown', prevented: false }, { type: 'auxclick', prevented: true }])
    expect(disabled.handlers).toBe(JSON.stringify(['child-mousedown-capture', 'button-mousedown-capture', 'child-mousedown', 'button-mousedown']))

    await page.getByLabel('Disable', { exact: true }).uncheck()
    await expect(link).toHaveAttribute('href', '/button-disabled-links.html?destination=1')
    const popupPromise = context.waitForEvent('page')
    await middleClick()
    const popup = await popupPromise
    await expect(popup).toHaveURL(/button-disabled-links\.html\?destination=1$/)
    await expect(page).toHaveURL(originalURL)
    await expect.poll(events).toHaveLength(4)
    expect((await events()).slice(2)).toEqual([{ type: 'mousedown', prevented: false }, { type: 'auxclick', prevented: false }])
    const handlers = ['child-mousedown-capture', 'button-mousedown-capture', 'child-mousedown', 'button-mousedown', 'child-auxclick-capture', 'button-auxclick-capture', 'child-auxclick', 'button-auxclick']
    await expect(page.getByLabel('Handlers')).toHaveText(JSON.stringify(handlers))
    await testInfo.attach('enabled-auxclick', { body: JSON.stringify({ events: await events(), popup: popup.url(), handlers }), contentType: 'application/json' })

    await popup.close()
    await page.getByLabel('Disable', { exact: true }).check()
    await page.evaluate(() => {
      const next = document.createElement('button')
      next.textContent = 'Next'
      document.querySelector('[data-slot="button"]')!.after(next)
    })
    await link.focus()
    await expect(link).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused()
  })
}
