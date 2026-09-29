import { validateCard } from './cards'
import { ValidationError } from './errors'
import { SAFE_LIMITS, normalizeText, type ItemFields, type SecureItemInput } from './safes'
import { validateSubscription } from './subscriptions'

export function validateItemInput(input: SecureItemInput): ItemFields & { title: string } {
  const title = normalizeText(input.title, SAFE_LIMITS.title, { required: true })
  switch (input.kind) {
    case 'CARD':
      return { kind: 'CARD', title, ...validateCard(input) }
    case 'SUBSCRIPTION':
      return { kind: 'SUBSCRIPTION', title, ...validateSubscription(input) }
    case 'NOTE':
      return { kind: 'NOTE', title, body: normalizeText(input.body, SAFE_LIMITS.noteBody, { multiline: true }) }
    default:
      throw new ValidationError('REQUIRED')
  }
}
