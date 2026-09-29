export type BuildInfo = {
  version: string
  commit: string
  builtAt: string
}

export const BUILD: BuildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev',
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  builtAt: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '',
}

export const APP_VERSION = BUILD.version
