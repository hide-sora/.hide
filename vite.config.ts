import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 開発時のルートは public/ を含む project root
  root: '.',
  // public/test_hide.html などを直接配信できるよう、publicDir はそのまま public
  publicDir: 'public',
  server: {
    port: 4326,
    open: '/test_hide_mini.html',
    fs: {
      allow: ['.', './node_modules'],
    },
  },
  optimizeDeps: {
    exclude: ['@napi-rs/canvas', 'pdfjs-dist'],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'HideLang',
      fileName: 'index',
      formats: ['es'],
    },
    sourcemap: true,
    minify: false,
    // tsc が先に dist/ に *.d.ts を出力するため、Vite には dist/ を空にしないよう指示する
    // (デフォルトの emptyOutDir=true だと .d.ts が消えて consumer 側の型解決が失敗する)
    emptyOutDir: false,
    rollupOptions: {
      external: [/^node:/, '@napi-rs/canvas', '@anthropic-ai/sdk', 'pdfjs-dist', 'pdfjs-dist/build/pdf.worker.mjs'],
      output: {
        // 単一ファイル出力 (dynamic import chunk を作らない)
        inlineDynamicImports: true,
      },
    },
  },
});
