import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TREND_CLASSES, TrendBadge, trendOf } from '../../src/components/FxTrend'
import { changePercent, type FxQuote } from '../../src/domain/fx'

const quote = {
  base: 'USD',
  quote: 'UZS',
  rate: '11806.97',
  previous: { rate: '11825.87', date: '2026-09-26' },
} as unknown as FxQuote

describe('exchange-rate trend', () => {
  it('maps the sign of a change to up, down, or flat', () => {
    expect(trendOf(1)).toBe('up')
    expect(trendOf(-1)).toBe('down')
    expect(trendOf(0)).toBe('flat')
  })

  it('colors rises green, falls red, and no change neutral', () => {
    expect(TREND_CLASSES.up).toEqual({ accent: 'border-rise/60', badge: 'bg-rise/12 text-rise' })
    expect(TREND_CLASSES.down).toEqual({ accent: 'border-fall/60', badge: 'bg-fall/12 text-fall' })
    expect(TREND_CLASSES.flat).toEqual({ accent: 'border-line', badge: 'bg-muted/12 text-muted' })
  })

  it('follows the displayed direction, so a pair and its inverse get opposite colors', () => {
    expect(trendOf(changePercent(quote, false)!.sign())).toBe('down')
    expect(trendOf(changePercent(quote, true)!.sign())).toBe('up')
    expect(trendOf(changePercent({ ...quote, previous: { rate: quote.rate, date: '2026-09-26' } }, false)!.sign())).toBe('flat')
  })

  it('pairs the color with an arrow and a hidden label', () => {
    const up = renderToStaticMarkup(createElement(TrendBadge, { trend: 'up', label: 'Up' }, '+0.16%'))
    expect(up).toContain('data-trend="up"')
    expect(up).toContain('text-rise')
    expect(up).toContain('lucide-trending-up')
    expect(up).toContain('<span class="sr-only">Up </span>+0.16%')

    const down = renderToStaticMarkup(createElement(TrendBadge, { trend: 'down', label: 'Down' }, '-0.16%'))
    expect(down).toContain('text-fall')
    expect(down).toContain('lucide-trending-down')
    expect(down).toContain('<span class="sr-only">Down </span>')

    const flat = renderToStaticMarkup(createElement(TrendBadge, { trend: 'flat' }))
    expect(flat).toContain('text-muted')
    expect(flat).not.toContain('sr-only')
    expect(flat).not.toMatch(/text-(rise|fall)/)
  })
})
