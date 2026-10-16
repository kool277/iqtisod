import { describe, expect, it } from 'vitest'
import { fill } from '../../src/components/table/model'
import { fillTemplate } from '../../src/lib/template'

describe('fillTemplate', () => {
  it('fills the names it is given, numbers included, and leaves the rest', () => {
    expect(fillTemplate('{count} of {limit} places, {missing}', { count: 3, limit: '256' })).toBe('3 of 256 places, {missing}')
    expect(fillTemplate('{a}{a} {b}', { a: 'x', b: 0 })).toBe('xx 0')
  })

  it('never fills a name only inherited from Object.prototype', () => {
    expect(fillTemplate('{constructor} {toString} {count}', { count: 1 })).toBe('{constructor} {toString} 1')
  })

  it('is the one the tables use', () => {
    expect(fill).toBe(fillTemplate)
  })
})
