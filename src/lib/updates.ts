import { useEffect, useState } from 'react'
import { BUILD, type BuildInfo } from './version'

const CHECK_INTERVAL_MS = 30 * 60 * 1000

export function isNewerBuild(remote: Partial<BuildInfo> | null, current: BuildInfo = BUILD): boolean {
  if (!remote || typeof remote.commit !== 'string' || typeof remote.version !== 'string') return false
  return remote.commit !== current.commit || remote.version !== current.version
}

async function fetchRemoteBuild(): Promise<Partial<BuildInfo> | null> {
  try {
    const response = await fetch(new URL('version.json', document.baseURI), { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as Partial<BuildInfo>
  } catch {
    return null
  }
}

export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (import.meta.env.DEV || available) return
    let cancelled = false
    const check = async () => {
      const remote = await fetchRemoteBuild()
      if (!cancelled && isNewerBuild(remote)) setAvailable(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check()
    }
    void check()
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [available])
  return available
}
