import { defineConfig } from 'vite';

// Static GitHub Pages build served from a repo subpath.
export default defineConfig({
  base: '/f1-isometric-tracker/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
  },
});
