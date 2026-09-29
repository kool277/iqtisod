import { useCallback, useEffect, useState } from 'react'

/** Milliseconds left until a deadline, refreshed twice a second while running. */
export function useCountdown(): { remaining: number; start: (ms: number) => void } {
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (until <= now) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [until, now])

  const start = useCallback((ms: number) => {
    const current = Date.now()
    setNow(current)
    setUntil(ms > 0 ? current + ms : 0)
  }, [])

  return { remaining: Math.max(0, until - now), start }
}
