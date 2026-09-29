import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type BuildInfo = {
  version: string
  commit: string
  builtAt: string
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function packageVersion(): string {
  const path = fileURLToPath(new URL('../package.json', import.meta.url))
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

export function buildInfo(): BuildInfo {
  const sha = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD'])
  const epoch = process.env.SOURCE_DATE_EPOCH
  const commitDate = git(['log', '-1', '--format=%cI'])
  const builtAt = epoch
    ? new Date(Number(epoch) * 1000).toISOString()
    : new Date(commitDate ?? Date.now()).toISOString()
  return {
    version: packageVersion(),
    commit: sha ? sha.slice(0, 12) : 'unknown',
    builtAt,
  }
}

export function buildDefines(info: BuildInfo): Record<string, string> {
  return {
    __APP_VERSION__: JSON.stringify(info.version),
    __BUILD_COMMIT__: JSON.stringify(info.commit),
    __BUILD_DATE__: JSON.stringify(info.builtAt),
  }
}
