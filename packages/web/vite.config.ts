import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PLANESTRO_API points the dev proxy at another server, e.g. `planestro sample` on :4310
const api = process.env.PLANESTRO_API ?? 'http://127.0.0.1:4300';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/attachments': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
