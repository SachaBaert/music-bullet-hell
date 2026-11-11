import { defineConfig } from 'vite';

// GitHub Pages serves the site from /music-bullet-hell/
export default defineConfig({
  base: '/music-bullet-hell/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
