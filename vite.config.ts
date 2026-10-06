import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildDefines, buildInfo, type BuildInfo } from './tools/build-info.ts'
import { HELP_LOCALES, guidePath, imageSize, parseGuide, type HelpLocale } from './tools/help-markdown.ts'

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// frame-ancestors is ignored in a <meta> policy; src/main.tsx refuses to run inside a frame instead.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
  "require-trusted-types-for 'script'",
  'trusted-types default',
].join('; ')

function releaseMetadata(info: BuildInfo): Plugin {
  return {
    name: 'moliya-release-metadata',
    apply: 'build',
    // The policy must precede every script, and the charset must stay within the first 1024 bytes.
    transformIndexHtml(html) {
      return {
        html: html.replace(/\s*<meta charset="UTF-8" \/>/, ''),
        tags: [
          { tag: 'meta', attrs: { charset: 'UTF-8' }, injectTo: 'head-prepend' },
          { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
          { tag: 'meta', attrs: { name: 'moliya-version', content: `${info.version}+${info.commit}` }, injectTo: 'head' },
        ],
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(info, null, 2)}\n` })
    },
  }
}

/** Not-a-file navigations a GitHub Pages site answers with 404.html; `/` was already rewritten to `/index.html`. */
const SQLITE_ENTRY = /@sqlite\.org[\\/]sqlite-wasm[\\/]dist[\\/]index\.mjs$/
const SQLITE_UNUSED_WORKERS = ['sqlite3-opfs-async-proxy.js', 'sqlite3-worker1.mjs']
const SQLITE_WORKER_STUB = '(() => { throw new Error("This SQLite worker is not shipped") })()'

/** The database stays in memory on the main thread, so the OPFS proxy and the worker1 promiser are never started; without this Vite still ships both. */
function dropSqliteWorkers(): Plugin {
  return {
    name: 'jaybi-drop-sqlite-workers',
    enforce: 'pre',
    transform(code, id) {
      if (!SQLITE_ENTRY.test(id)) return null
      let out = code
      for (const file of SQLITE_UNUSED_WORKERS) {
        const reference = `new URL("${file}", import.meta.url)`
        if (!out.includes(reference)) this.error(`@sqlite.org/sqlite-wasm no longer loads ${file} as expected; review dropSqliteWorkers`)
        out = out.replaceAll(reference, SQLITE_WORKER_STUB)
      }
      return { code: out, map: null }
    },
  }
}

function isMissingPage(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers.accept ?? ''
  if (accept !== '' && !accept.includes('text/html') && !accept.includes('*/*')) return false
  const path = (req.url ?? '/').split(/[?#]/)[0]
  return !path.endsWith('.html') && !path.startsWith('/@') && !path.startsWith('/src/') && !path.startsWith('/node_modules/')
}

function sendNotFound(res: ServerResponse, html: string): void {
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

/** Serves 404.html with status 404 for unknown paths in dev and preview, the way GitHub Pages does. */
function pagesFallback(): Plugin {
  return {
    name: 'moliya-pages-fallback',
    configureServer(server) {
      const file = fileURLToPath(new URL('./404.html', import.meta.url))
      return () => {
        server.middlewares.use((req, res, next) => {
          if (!isMissingPage(req)) return next()
          readFile(file, 'utf8')
            .then((html) => server.transformIndexHtml('/404.html', html))
            .then((html) => sendNotFound(res, html), next)
        })
      }
    },
    configurePreviewServer(server) {
      const file = join(server.config.root, server.config.build.outDir, '404.html')
      return () => {
        server.middlewares.use((req, res, next) => {
          if (!isMissingPage(req)) return next()
          readFile(file, 'utf8').then((html) => sendNotFound(res, html), next)
        })
      }
    },
  }
}

const HELP_MODULE = 'virtual:help/'
const HELP_IMAGE = /^\/help\/(en|ru|uz-Latn|uz-Cyrl)\/([a-z0-9][a-z0-9-]*\.(?:webp|png))$/
const IMAGE_TYPES: Record<string, string> = { webp: 'image/webp', png: 'image/png' }

/**
 * The in-app Help: `virtual:help/<locale>` is that language's docs guide turned into data at build time, one lazy
 * chunk per language, and the guide's screenshots under docs/images/ are served as same-origin files at
 * help/<locale>/, never inlined into the JavaScript.
 */
function helpGuides(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const imagesDir = join(root, 'docs/images')
  const sizeOf = (src: string) => {
    const file = join(imagesDir, src.replace(/^help\//, ''))
    return existsSync(file) ? imageSize(readFileSync(file)) : null
  }
  return {
    name: 'jaybi-help-guides',
    resolveId(id) {
      return id.startsWith(HELP_MODULE) ? `\0${id}` : null
    },
    load(id) {
      if (!id.startsWith(`\0${HELP_MODULE}`)) return null
      const locale = id.slice(HELP_MODULE.length + 1) as HelpLocale
      if (!(HELP_LOCALES as readonly string[]).includes(locale)) this.error(`No help guide for ${locale}`)
      const path = join(root, guidePath(locale))
      this.addWatchFile(path)
      const doc = parseGuide(readFileSync(path, 'utf8'), { locale, imageSize: sizeOf })
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(doc))})`
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = HELP_IMAGE.exec((req.url ?? '').split('?')[0])
        if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return next()
        const file = join(imagesDir, match[1], match[2])
        readFile(file).then(
          (bytes) => {
            res.setHeader('Content-Type', IMAGE_TYPES[match[2].split('.').pop()!])
            res.setHeader('Cache-Control', 'no-cache')
            res.end(req.method === 'HEAD' ? undefined : bytes)
          },
          () => next(),
        )
      })
    },
    generateBundle() {
      if (!existsSync(imagesDir)) return
      for (const locale of HELP_LOCALES) {
        const dir = join(imagesDir, locale)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir).sort()) {
          if (!HELP_IMAGE.test(`/help/${locale}/${name}`)) continue
          this.emitFile({ type: 'asset', fileName: `help/${locale}/${name}`, source: readFileSync(join(dir, name)) })
        }
      }
    },
  }
}

const info = buildInfo()

const emptyModule = fileURLToPath(new URL('./src/lib/empty-module.ts', import.meta.url))

export default defineConfig({
  // Relative, so the app also runs under a sub-path (a release zip, or github.io/iqtisod/ when recovering old vaults).
  base: './',
  appType: 'mpa',
  experimental: {
    // 404.html answers for every missing path, however deep, so its URLs must start at the domain root.
    renderBuiltUrl(filename, { hostType, hostId }) {
      return hostType === 'html' && /(^|[\\/])404\.html$/.test(hostId) ? `/${filename}` : undefined
    },
  },
  define: buildDefines(info),
  plugins: [dropSqliteWorkers(), react(), tailwindcss(), releaseMetadata(info), helpGuides(), pagesFallback()],
  resolve: {
    alias: {
      html2canvas: emptyModule,
      canvg: emptyModule,
      dompurify: emptyModule,
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  // The Argon2 Worker is an ES module; public/coi-config.js approves only its built name, argon2.worker-<hash>.js.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/ },
            { name: 'charts', test: /node_modules[\\/](chart\.js|react-chartjs-2|@kurkle)[\\/]/ },
            // jsPDF and write-excel-file share fflate; without its own group it lands in export-pdf and an Excel export downloads jsPDF.
            { name: 'export-fflate', test: /node_modules[\\/]fflate[\\/]/, priority: 1 },
            { name: 'export-pdf', test: /node_modules[\\/](jspdf|jspdf-autotable|fast-png|iobuffer|pako|@babel[\\/]runtime)[\\/]/ },
            { name: 'export-xlsx', test: /node_modules[\\/]write-excel-file[\\/]/ },
            { name: 'export-zip', test: /node_modules[\\/]@zip\.js[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
})
