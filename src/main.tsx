import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { detectLocale, translate } from './i18n'
import './index.css'

declare global {
  interface Window {
    __moliyaFramed?: boolean
  }
}

function isFramed(): boolean {
  if (typeof window.__moliyaFramed === 'boolean') return window.__moliyaFramed
  try {
    return window.top !== window.self
  } catch {
    return true
  }
}

/** A page that another site frames could be overlaid to trick clicks, so the app only offers a way out. */
function renderFramed(root: HTMLElement): void {
  const locale = detectLocale()
  const box = document.createElement('main')
  box.className = 'mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center'
  const title = document.createElement('p')
  title.className = 'text-base font-semibold text-ink'
  title.textContent = translate(locale, 'framed.title')
  const link = document.createElement('a')
  link.className = 'rounded-lg bg-pine px-4 py-2 text-sm font-medium text-on-pine'
  link.href = `${window.location.origin}${window.location.pathname}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = translate(locale, 'framed.open')
  box.append(title, link)
  root.replaceChildren(box)
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing root element')

if (isFramed()) {
  renderFramed(root)
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
