/**
 * Replaces each `{name}` in `template` with `values[name]`. Names the values do not have themselves (inherited ones
 * such as `{constructor}` included) are left as they are.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : match))
}
