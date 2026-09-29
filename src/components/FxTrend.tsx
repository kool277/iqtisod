import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'

export type FxTrend = 'up' | 'down' | 'flat'

export function trendOf(sign: number): FxTrend {
  return sign > 0 ? 'up' : sign < 0 ? 'down' : 'flat'
}

export const TREND_CLASSES: Record<FxTrend, { accent: string; badge: string }> = {
  up: { accent: 'border-rise/60', badge: 'bg-rise/12 text-rise' },
  down: { accent: 'border-fall/60', badge: 'bg-fall/12 text-fall' },
  flat: { accent: 'border-line', badge: 'bg-muted/12 text-muted' },
}

const ICONS = { up: TrendingUp, down: TrendingDown, flat: Minus } as const

/** Color is never the only signal: the arrow and the visually hidden label carry the direction too. */
export function TrendBadge({ trend, label, children }: { trend: FxTrend; label?: string; children?: ReactNode }) {
  const Icon = ICONS[trend]
  return (
    <span
      data-testid="fx-trend"
      data-trend={trend}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 align-middle font-medium ${TREND_CLASSES[trend].badge}`}
    >
      <Icon size={12} aria-hidden="true" className="shrink-0" />
      {label ? <span className="sr-only">{`${label} `}</span> : null}
      {children}
    </span>
  )
}
