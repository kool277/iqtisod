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

const info = buildInfo()

const emptyModule = fileURLToPath(new URL('./src/lib/empty-module.ts', import.meta.url))

export default defineConfig({
  base: './',
  define: buildDefines(info),
  plugins: [react(), tailwindcss(), releaseMetadata(info)],
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
