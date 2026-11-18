import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) for (const variant of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
  test(`${theme} ${variant}: readable disabled state, cursor, hover and native submission guards`, async ({ page }, testInfo) => {
    await page.goto(`/button-disabled.html?theme=${theme}&variant=${variant}`)
    const button = page.getByRole('button', { name: 'Confirm', exact: true })
    await expect(button).toBeDisabled()
    await expect(button).toHaveCSS('opacity', '1')
    await expect(button).toHaveCSS('pointer-events', 'auto')
    await expect(button).toHaveCSS('cursor', 'not-allowed')
    const appearance = () => button.evaluate(element => {
      const style = getComputedStyle(element)
      const rgb = (color: string) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = color; context.fillRect(0, 0, 1, 1)
        return Array.from(context.getImageData(0, 0, 1, 1).data)
      }
      const luminance = (color: number[]) => color.slice(0, 3).map(value => {
        const s = value / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const foreground = rgb(style.color), background = rgb(style.backgroundColor)
      const a = luminance(foreground), b = luminance(background)
      return { foreground, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), shadow: style.getPropertyValue('--tw-shadow').trim(), decoration: style.textDecorationLine }
    })
    const before = await appearance()
    expect(before.background[3]).toBe(255)
    expect(before.contrast).toBeGreaterThanOrEqual(4.5)
    expect(before.shadow).toBe('0 0 #0000')
    await button.hover()
    await expect.poll(appearance).toEqual(before)
    const box = (await button.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await button.focus()
    await expect(button).not.toBeFocused()
    await page.getByRole('textbox', { name: 'Value' }).press('Enter')
    await expect(page.getByLabel('Submissions')).toHaveText('0')
    await testInfo.attach('disabled-appearance', { body: JSON.stringify({ theme, variant, ...before }), contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath('disabled.png') })
    await page.getByLabel('Disable', { exact: true }).uncheck()
    await expect(button).toBeEnabled()
    if (variant === 'default') await expect.poll(async () => (await appearance()).background).not.toEqual(before.background)
    await button.click()
    await expect(page.getByLabel('Submissions')).toHaveText('1')
    await button.focus(); await page.keyboard.press('Space')
    await expect(page.getByLabel('Submissions')).toHaveText('2')
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Submissions')).toHaveText('3')
    const enabled = page.getByRole('button', { name: 'Enabled', exact: true })
    const colors = (element: Element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, foreground: style.color, decoration: style.textDecorationLine }
    }
    await enabled.hover()
    // Finish transitions before comparing native and slotted hover treatments.
    await enabled.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
    const enabledHover = await enabled.evaluate(colors)
    const link = page.getByRole('link', { name: 'Back' })
    await link.hover()
    await expect.poll(() => link.evaluate(colors)).toEqual(enabledHover)
    await link.focus(); await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#destination$/)
  })
}
