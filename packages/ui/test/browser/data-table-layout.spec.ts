import { expect, test } from '@playwright/test'
import en from '../../../frontend-console/src/locales/en.json' with { type: 'json' }
import cs from '../../../frontend-console/src/locales/cs.json' with { type: 'json' }

for (const width of [1440, 390]) {
  for (const language of ['en', 'cs'] as const) {
    for (const enlarged of [false, true]) {
      for (const size of [10, 20, 30, 50, 100]) {
        test(`${language} ${size} rows at ${width}px, ${enlarged ? '200%' : '100%'} text`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 })
          await page.goto(`/?language=${language}&size=${size}&enlarged=${enlarged}`)
          const copy = language === 'cs' ? cs : en
          const trigger = page.getByRole('combobox', { name: copy.rowsPerPage })
          const value = trigger.locator('[data-slot="select-value"]')
          await expect(value).toHaveText(copy.paginationSize.replace('{{count}}', String(size)))
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')
          await page.evaluate(() => document.fonts.ready)

          const geometry = await value.evaluate(element => {
            const trigger = element.parentElement!
            // The two switcher wrappers are direct children of the real footer.
            const footer = trigger.parentElement!.parentElement!.parentElement!
            const box = (node: Element) => {
              const { left, right, top, bottom, width } = node.getBoundingClientRect()
              return { left, right, top, bottom, width }
            }
            const range = document.createRange()
            range.selectNodeContents(element)
            const text = range.getBoundingClientRect()
            return {
              value: { ...box(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth },
              text: { left: text.left, right: text.right },
              trigger: box(trigger), footer: box(footer),
              footerClientWidth: footer.clientWidth, footerScrollWidth: footer.scrollWidth,
              controls: Array.from(footer.querySelectorAll('button')).map(box),
              documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
            }
          })
          await testInfo.attach('geometry', { body: JSON.stringify({ width, language, enlarged, size, ...geometry }, null, 2), contentType: 'application/json' })

          expect(geometry.value.clientWidth).toBeGreaterThan(0)
          expect(geometry.value.scrollWidth).toBeLessThanOrEqual(geometry.value.clientWidth)
          expect(geometry.text.left).toBeGreaterThanOrEqual(geometry.value.left - 1)
          expect(geometry.text.right).toBeLessThanOrEqual(geometry.value.right + 1)
          expect(geometry.trigger.left).toBeGreaterThanOrEqual(geometry.footer.left)
          expect(geometry.trigger.right).toBeLessThanOrEqual(geometry.footer.right)
          expect(geometry.footerScrollWidth).toBeLessThanOrEqual(geometry.footerClientWidth)
          expect(geometry.documentWidth).toBeLessThanOrEqual(width)
          for (const control of geometry.controls.filter(control => control.width > 0)) {
            expect(control.left).toBeGreaterThanOrEqual(geometry.footer.left)
            expect(control.right).toBeLessThanOrEqual(geometry.footer.right)
          }
          // With enlarged text, mobile controls must move to another row.
          if (width === 390 && enlarged) {
            expect(geometry.trigger.top).toBeGreaterThanOrEqual(geometry.controls[0].bottom)
          }
        })
      }
    }
  }
}
