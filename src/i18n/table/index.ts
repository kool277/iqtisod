import { registerTableMessages } from '../index'
import { tableEn } from './en'
import { tableRu } from './ru'
import { tableUzCyrl } from './uz-Cyrl'
import { tableUzLatn } from './uz-Latn'

/** Call at module level in every module that renders `table.*` strings, so they are registered before the first render. */
export function registerTableCatalog(): void {
  registerTableMessages({ en: tableEn, ru: tableRu, 'uz-Latn': tableUzLatn, 'uz-Cyrl': tableUzCyrl })
}
