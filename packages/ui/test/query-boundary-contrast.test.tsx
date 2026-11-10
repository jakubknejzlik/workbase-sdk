import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryBoundary } from '../src/query-boundary'

type RGB = [number, number, number]
const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
const declarations = (block: string) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value]))
const root = declarations(css.match(/:root\s*\{([^}]+)\}/)![1])
const dark = declarations(css.match(/\.dark\s*\{([^}]+)\}/)![1])
const colors = declarations(css.match(/@theme inline\s*\{([^}]+)\}/)![1])

// Convert the actual theme's OKLCH tokens to sRGB, clipping out-of-gamut channels.
function rgb(value: string): RGB {
  const match = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/)
  if (!match) throw new Error(`Unsupported theme color: ${value}`)
  const [, lightness, chroma, hue] = match.map(Number)
  const a = chroma * Math.cos(hue * Math.PI / 180), b = chroma * Math.sin(hue * Math.PI / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(channel => {
    const linear = Math.min(1, Math.max(0, channel))
    return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
  }) as RGB
}
function luminance(color: RGB) {
  return color.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
}
function contrast(foreground: RGB, background: RGB) {
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
function colorUtility(element: Element, prefix: 'text' | 'bg', tokens: Record<string, string>) {
  for (const name of element.classList) {
    const match = name.match(new RegExp(`^${prefix}-([\\w-]+)(?:/(\\d+))?$`))
    if (!match || !colors[`--color-${match[1]}`]) continue
    const token = colors[`--color-${match[1]}`].match(/^var\((--[\w-]+)\)$/)![1]
    return { color: rgb(tokens[token]), alpha: match[2] ? Number(match[2]) / 100 : 1 }
  }
  throw new Error(`Missing ${prefix} theme color on ${element.outerHTML}`)
}

it('calculates WCAG contrast including sRGB linearization', () => {
  expect(contrast(rgb('oklch(0 0 0)'), rgb('oklch(1 0 0)'))).toBeCloseTo(21, 5)
  expect(contrast([0.5, 0.5, 0.5], [1, 1, 1])).toBeCloseTo(3.97665, 5)
})

// QueryBoundary appears on pages, cards and dialog/popover surfaces.
it.each(['light', 'dark'].flatMap(theme => ['background', 'card', 'popover'].map(surface => ({ theme, surface }))))
('QueryBoundary error text meets 4.5:1 in $theme on $surface', ({ theme, surface }) => {
  const tokens = theme === 'dark' ? { ...root, ...dark } : root
  render(<QueryBoundary pending={false} error={new Error('Request failed')}>Ready</QueryBoundary>)
  const alert = screen.getByRole('alert'), text = screen.getByText('Request failed')
  const foreground = colorUtility(text, 'text', tokens)
  const tint = colorUtility(alert, 'bg', tokens)
  expect(foreground.alpha).toBe(1)
  const background = rgb(tokens[`--${surface}`])
  const blended = tint.color.map((channel, index) => channel * tint.alpha + background[index] * (1 - tint.alpha)) as RGB
  const ratio = contrast(foreground.color, blended)
  console.log(`QueryBoundary ${theme}/${surface}: ${ratio.toFixed(3)}:1 (required 4.5:1)`)
  expect(ratio, `${theme}/${surface}`).toBeGreaterThanOrEqual(4.5)
})
