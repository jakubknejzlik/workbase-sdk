import type { ElementHandle, Locator, Page, TestInfo } from '@playwright/test'

// All controls and their clipping ancestors are read synchronously in one frame.
// Waiting observes production transitions; it never cancels or disables them.
export async function layoutDiagnostics(controls: Locator, settle = false) {
  const elements = await controls.elementHandles() as ElementHandle<Element>[]
  try {
    return await controls.page().evaluate(async ({ elements, settle }) => {
      if (settle) {
        await document.fonts.ready
        const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        await frame(); await frame()
        const stableBoxes = async () => {
          let previous = ''
          let stable = 0
          const deadline = performance.now() + 5000
          while (stable < 3) {
            await frame()
            const boxes = JSON.stringify(elements.map(element => element.getBoundingClientRect().toJSON()))
            const animating = document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)
            stable = !animating && boxes === previous ? stable + 1 : 0
            previous = boxes
            if (performance.now() > deadline) throw new Error('Pagination layout did not settle within 5 seconds')
          }
        }
        await stableBoxes()
        // Text enlargement can move the footer after an earlier scroll. Bring
        // the settled group into view, then observe stable boxes again.
        elements[0]?.closest('[data-list-paging]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        await stableBoxes()
      }
      return {
        sampledAt: performance.now(),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentClientWidth: document.documentElement.clientWidth,
        // This is the live layout viewport (320 during the boundary fallback),
        // rather than the scenario's original 1110px label.
        effectiveLayoutWidth: document.documentElement.clientWidth,
        visualViewport: window.visualViewport ? { width: visualViewport!.width, height: visualViewport!.height, scale: visualViewport!.scale } : null,
        devicePixelRatio: window.devicePixelRatio,
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        fonts: { status: document.fonts.status, faces: Array.from(document.fonts).map(face => ({ family: face.family, style: face.style, weight: face.weight, status: face.status })) },
        controls: elements.map(element => {
          const box = element.getBoundingClientRect().toJSON()
          const style = getComputedStyle(element)
          const clipAncestors = []
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX)
            const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY)
            if (!clipsX && !clipsY) continue
            const rect = parent.getBoundingClientRect()
            clipAncestors.push({ tag: parent.tagName, className: parent.className, overflowX: style.overflowX, overflowY: style.overflowY, clipsX, clipsY,
              box: rect.toJSON(), clientWidth: parent.clientWidth, scrollWidth: parent.scrollWidth, scrollLeft: parent.scrollLeft,
              clip: { left: rect.left + parseFloat(style.borderLeftWidth), right: rect.right - parseFloat(style.borderRightWidth), top: rect.top + parseFloat(style.borderTopWidth), bottom: rect.bottom - parseFloat(style.borderBottomWidth) } })
          }
          return { name: element.getAttribute('aria-label') ?? element.textContent, disabled: element.matches(':disabled'), box,
            font: { family: style.fontFamily, size: style.fontSize }, clipAncestors,
            clip: { left: Math.max(0, ...clipAncestors.filter(clip => clip.clipsX).map(clip => clip.clip.left)), right: Math.min(innerWidth, document.documentElement.clientWidth, ...clipAncestors.filter(clip => clip.clipsX).map(clip => clip.clip.right)),
              top: Math.max(0, ...clipAncestors.filter(clip => clip.clipsY).map(clip => clip.clip.top)), bottom: Math.min(innerHeight, ...clipAncestors.filter(clip => clip.clipsY).map(clip => clip.clip.bottom)) },
            hitAtCenter: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }
        }),
      }
    }, { elements, settle })
  } finally {
    await Promise.all(elements.map(element => element.dispose()))
  }
}

export async function attachLayoutDiagnostics(page: Page, info: TestInfo, name: string, diagnostic: unknown) {
  await info.attach(`${name}.json`, { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' })
  // Capture before the geometry assertion, including on the failing CI path.
  await info.attach(`${name}.png`, { body: await page.screenshot(), contentType: 'image/png' })
}
