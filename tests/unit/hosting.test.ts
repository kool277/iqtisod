import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { UserConfig } from 'vite'
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

  it('ships a 404 page that only loads its own same-origin script, built with root-absolute URLs', async () => {
    const page = readFileSync(join(ROOT, '404.html'), 'utf8')
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.map(([, attrs]) => attrs.trim())).toEqual(['type="module" src="/src/spa-fallback.ts"'])
    expect(scripts.every(([, , body]) => body.trim() === '')).toBe(true)
    expect(page).not.toMatch(/\son\w+=/i)
    const config = (await import('../../vite.config')).default as UserConfig
    expect(config.base).toBe('./')
    const input = config.build?.rolldownOptions?.input as Record<string, string>
    expect(Object.values(input).map((path) => relative(ROOT, path)).sort()).toEqual(['404.html', 'index.html'])
    const url = config.experimental?.renderBuiltUrl as (file: string, context: { hostType: string; hostId: string }) => unknown
    expect(url('assets/notFound-x.js', { hostType: 'html', hostId: join(ROOT, '404.html') })).toBe('/assets/notFound-x.js')
    expect(url('assets/index-x.js', { hostType: 'html', hostId: join(ROOT, 'index.html') })).toBeUndefined()
    expect(url('assets/font.woff2', { hostType: 'css', hostId: 'assets/index.css' })).toBeUndefined()
  })

  it('does not link to or load from the old address in anything the site serves', () => {
    const served = [...filesUnder(join(ROOT, 'src')), ...filesUnder(join(ROOT, 'public')), join(ROOT, 'index.html'), join(ROOT, '404.html')]
    const offenders = served
      .filter((path) => /https?:\/\/[\w.-]*github\.io|\/iqtisod\//.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
    expect(offenders).toEqual([])
  })
})
