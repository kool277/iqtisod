/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` builds the per-person-keys setup and upgrade (2.0 alpha); anything else leaves them out. */
  readonly VITE_V2_KEYS?: string
}

declare const __APP_VERSION__: string
declare const __BUILD_COMMIT__: string
declare const __BUILD_DATE__: string

declare module 'virtual:help/*' {
  const doc: import('./help/types').HelpDoc
  export default doc
}
