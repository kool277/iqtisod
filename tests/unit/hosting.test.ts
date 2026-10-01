import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('hosting', () => {
  it('ships a CNAME for jaybi.uz and nothing else', () => {
    expect(readFileSync(join(ROOT, 'public/CNAME'), 'utf8').trim()).toBe('jaybi.uz')
  })

  it('carries the custom domain only as dist/CNAME, never through the action input', () => {
    const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).not.toMatch(/^\s+cname:/m)
    expect(deploy).toMatch(/contents\/CNAME\?ref=gh-pages/)
  })

  it('ships a 404 page that only loads its own same-origin script, from absolute URLs', () => {
    const page = readFileSync(join(ROOT, '404.html'), 'utf8')
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.map(([, attrs]) => attrs.trim())).toEqual(['type="module" src="/src/spa-fallback.ts"'])
    expect(scripts.every(([, , body]) => body.trim() === '')).toBe(true)
    expect(page).not.toMatch(/\son\w+=/i)
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(vite).toMatch(/^\s+base: '\/',$/m)
    expect(vite).toMatch(/notFound: fileURLToPath\(new URL\('\.\/404\.html'/)
    const index = readFileSync(join(ROOT, 'index.html'), 'utf8')
    expect([...index.matchAll(/\ssrc="([^"]+)"/g)].map(([, src]) => src).every((src) => src.startsWith('/'))).toBe(true)
  })

  it('does not link to or load from the old address in anything the site serves', () => {
    const served = [...filesUnder(join(ROOT, 'src')), ...filesUnder(join(ROOT, 'public')), join(ROOT, 'index.html'), join(ROOT, '404.html')]
    const offenders = served
      .filter((path) => /https?:\/\/[\w.-]*github\.io|\/iqtisod\//.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
    expect(offenders).toEqual([])
  })
})
