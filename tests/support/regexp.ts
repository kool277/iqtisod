/** `text` as a literal inside a RegExp. Node 22, which CI runs, has no `RegExp.escape`. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
