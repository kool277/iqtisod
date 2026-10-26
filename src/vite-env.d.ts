/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `0` leaves the per-person-keys setup and upgrade offer out of the build; anything else keeps them. */
  readonly VITE_V2_KEYS?: string
}

declare const __APP_VERSION__: string
declare const __BUILD_COMMIT__: string
declare const __BUILD_DATE__: string

declare module 'virtual:help/*' {
  const doc: import('./help/types').HelpDoc
  export default doc
}
