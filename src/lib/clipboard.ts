let timer: number | null = null
let pending = false

function clearWhenFocused(): void {
  if (!pending) return
  if (!document.hasFocus()) {
    window.addEventListener('focus', clearWhenFocused, { once: true })
    return
  }
  pending = false
  void navigator.clipboard?.writeText('').catch(() => undefined)
}

export async function copySecret(text: string, seconds: number): Promise<void> {
  if (!navigator.clipboard) throw new Error('clipboard')
  await navigator.clipboard.writeText(text)
  pending = true
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    clearWhenFocused()
  }, seconds * 1000)
}

export function clearCopiedSecret(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  clearWhenFocused()
}
