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

  it('does not link to or load from the old address in anything the site serves', () => {
    const served = [...filesUnder(join(ROOT, 'src')), ...filesUnder(join(ROOT, 'public')), join(ROOT, 'index.html')]
    const offenders = served
      .filter((path) => /https?:\/\/[\w.-]*github\.io|\/iqtisod\//.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
    expect(offenders).toEqual([])
  })
})
