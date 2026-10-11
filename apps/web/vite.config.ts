import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const apiPort = process.env.API_PORT ?? '4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Consume @aviator/shared from TypeScript source during development and bundling.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
