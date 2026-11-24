import { expect, test } from '@playwright/test'

const cases = [
  ...['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'].map(variant => ({ mode: 'disabled', variant })),
  ...['aria', 'aria-boolean', 'both', 'child-aria', 'child-disabled'].map(mode => ({ mode, variant: 'default' })),
]
for (const theme of ['light', 'dark']) for (const kind of ['anchor', 'router']) for (const { mode, variant } of cases) {
  test(`${theme} ${kind} ${mode} ${variant}: plain disabled text and native enabled navigation`, async ({ page, context }, testInfo) => {
    await page.goto(`/button-disabled-links.html?theme=${theme}&kind=${kind}&mode=${mode}&variant=${variant}`)
    const originalURL = page.url()
    const text = page.locator('[data-slot="button"]')
    await expect(text).toBeVisible()
    await expect(text).toHaveText('Destination')
    expect(await text.evaluate(element => element.tagName)).toBe('SPAN')
    await expect(page.locator('a, [href]')).toHaveCount(0)
    await expect(text).toHaveAttribute('aria-disabled', 'true')
    await expect(text).not.toHaveAttribute('tabindex')
    await expect(text).toHaveCSS('cursor', 'not-allowed')
    await expect(text).toHaveCSS('opacity', '1')
    const appearance = () => text.evaluate(element => {
      const style = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')!
      const luminance = (color: string) => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
        const rgba = [...ctx.getImageData(0, 0, 1, 1).data]
        const value = rgba.slice(0, 3).map(v => {
          const s = v / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
        return { value, alpha: rgba[3] }
      }
      const fg = luminance(style.color), bg = luminance(style.backgroundColor)
      return { color: style.color, background: style.backgroundColor, alpha: bg.alpha,
        contrast: (Math.max(fg.value, bg.value) + 0.05) / (Math.min(fg.value, bg.value) + 0.05),
        shadow: style.getPropertyValue('--tw-shadow').trim(), decoration: style.textDecorationLine }
    })
    const before = await appearance()
    expect(before.contrast).toBeGreaterThanOrEqual(4.5)
    expect(before.alpha).toBe(255)
    expect(before.shadow).toBe('0 0 #0000')
    await text.hover()
    await expect.poll(appearance).toEqual(before)
    const click = async (button: 'left' | 'middle' | 'right') => {
      const box = (await text.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button })
    }
    for (const button of ['left', 'middle', 'right'] as const) await click(button)
    await page.keyboard.press('Escape')
    expect(await text.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))).toBe(true)
    await text.evaluate(element => (element as HTMLElement).focus())
    await expect(text).not.toBeFocused()
    // Restore the real tab-order assertion weakened in fix3.
    await page.getByLabel('Disable', { exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused()
    await page.waitForTimeout(200)
    expect(context.pages().map(tab => tab.url())).toEqual([originalURL])
    await expect(page).toHaveURL(originalURL)
    // Disabled mousedown must not run either child's or Button's handlers.
    await expect(page.getByLabel('Handlers')).toHaveText('[]')
    await testInfo.attach('disabled-proof', { body: JSON.stringify({ theme, kind, mode, variant, ...before, html: await text.evaluate(element => element.outerHTML), handlers: [] }), contentType: 'application/json' })
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await page.screenshot({ path: testInfo.outputPath('disabled-link.png'), fullPage: true })

    await page.getByLabel('Disable', { exact: true }).uncheck()
    const link = page.getByRole('link', { name: 'Destination', exact: true })
    await expect(link).toHaveAttribute('href', '/button-disabled-links.html?destination=1')
    const popupPromise = context.waitForEvent('page')
    await click('middle')
    const popup = await popupPromise
    await expect(popup).toHaveURL(/button-disabled-links\.html\?destination=1$/)
    await expect(page).toHaveURL(originalURL)
    const handlers = ['child-mousedown-capture', 'button-mousedown-capture', 'child-mousedown', 'button-mousedown', 'child-auxclick-capture', 'button-auxclick-capture', 'child-auxclick', 'button-auxclick']
    await expect(page.getByLabel('Handlers')).toHaveText(JSON.stringify(handlers))
    await popup.close()
    expect(await link.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))).toBe(true)
    await click('right')
    await page.keyboard.press('Escape')
    await expect(link).toHaveAttribute('href', '/button-disabled-links.html?destination=1')
    await testInfo.attach('enabled-proof', { body: JSON.stringify({ href: await link.getAttribute('href'), middleClickOpenedTab: true, contextMenuUncancelled: true }), contentType: 'application/json' })
    await link.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/button-disabled-links\.html\?destination=1$/)
    await page.goto(originalURL)
    await page.getByLabel('Disable', { exact: true }).uncheck()
    await page.getByRole('link', { name: 'Destination', exact: true }).click()
    await expect(page).toHaveURL(/button-disabled-links\.html\?destination=1$/)
  })
}

for (const kind of ['anchor', 'router']) for (const mode of ['disabled', 'aria', 'both']) {
  for (const action of ['left', 'middle'] as const) {
    test(`redesign2 ${kind} ${mode} nested handler ${action} is inert`, async ({ page, context }, testInfo) => {
      await page.goto(`/button-disabled-links.html?kind=${kind}&mode=${mode}&nested=handler`)
      const text = page.locator('[data-slot="button"]')
      await expect(text).toHaveText('Destination')
      const originalURL = page.url()
      // Click the retained label itself on old implementations, using physical input.
      const target = await text.locator('span').count() ? text.locator('span') : text
      const box = (await target.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: action })
      await expect(page.getByLabel('Handlers')).toHaveText('[]')
      await expect(page).toHaveURL(originalURL)
      expect(context.pages().map(tab => tab.url())).toEqual([originalURL])
      await expect(text.locator('*')).toHaveCount(0)
      await expect(page.locator('a, [href]')).toHaveCount(0)
      await expect(text).toHaveCSS('cursor', 'not-allowed')
      await page.screenshot({ path: testInfo.outputPath('nested-handler.png') })
    })
  }
  test(`redesign2 ${kind} ${mode} nested interactive descendants become text`, async ({ page }, testInfo) => {
    await page.goto(`/button-disabled-links.html?kind=${kind}&mode=${mode}&nested=interactive`)
    const text = page.locator('[data-slot="button"]')
    await expect(text).toHaveText('Nested link Nested button')
    const originalURL = page.url()
    await expect(text.locator('*')).toHaveCount(0)
    await expect(page.locator('a, [href]')).toHaveCount(0)
    await text.evaluate(element => (element as HTMLElement).focus())
    await expect(text).not.toBeFocused()
    await page.getByLabel('Disable', { exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused()
    await text.click()
    await text.click({ button: 'middle' })
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(originalURL)
    await expect(page.getByLabel('Handlers')).toHaveText('[]')
    await page.screenshot({ path: testInfo.outputPath('nested-interactive.png') })
  })
}
