import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildDefines, buildInfo, type BuildInfo } from './tools/build-info.ts'

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
  plugins: [react(), tailwindcss(), releaseMetadata(info), pagesFallback()],
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
