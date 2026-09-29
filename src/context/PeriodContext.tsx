import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { DateRange } from '../domain/types'
import { rangeForPreset, type PeriodPreset } from '../lib/dates'

type PeriodApi = {
  preset: PeriodPreset
  setPreset: (preset: PeriodPreset) => void
  customStart: string
  customEnd: string
  setCustomStart: (value: string) => void
  setCustomEnd: (value: string) => void
  range: DateRange
}

const PeriodContext = createContext<PeriodApi | null>(null)

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [preset, setPreset] = useState<PeriodPreset>('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const range = useMemo(
    () => rangeForPreset(preset, new Date(), { start: customStart, end: customEnd }),
    [preset, customStart, customEnd],
  )
  const value = useMemo(
    () => ({ preset, setPreset, customStart, customEnd, setCustomStart, setCustomEnd, range }),
    [preset, customStart, customEnd, range],
  )
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>
}

export function usePeriod(): PeriodApi {
  const value = useContext(PeriodContext)
  if (!value) throw new Error('Period provider is missing')
  return value
}
