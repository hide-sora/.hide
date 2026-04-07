import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 開発時のルートは public/ を含む project root
  root: '.',
  // public/test_hide.html などを直接配信できるよう、publicDir はそのまま public
  publicDir: 'public',
  server: {
    port: 4326,
    open: '/public/test_hide.html',
    fs: {
      allow: ['.', './node_modules'],
    },
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
    rollupOptions: {
      external: [],
    },
  },
});
