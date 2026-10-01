import { fallbackTarget } from './lib/spa-fallback'

// At `/` this page would only replace the address with itself.
const target = window.location.pathname === '/' ? null : fallbackTarget(window.location)
if (target) window.location.replace(target)
