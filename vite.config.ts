import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildDefines, buildInfo, type BuildInfo } from './tools/build-info.ts'

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function releaseMetadata(info: BuildInfo): Plugin {
  return {
    name: 'moliya-release-metadata',
    apply: 'build',
    transformIndexHtml() {
      return [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
        { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'moliya-version', content: `${info.version}+${info.commit}` }, injectTo: 'head' },
      ]
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
