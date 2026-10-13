import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const engineTarget = process.env.VITE_ENGINE_URL || 'http://127.0.0.1:9000';
const wsTarget = process.env.VITE_WS_URL || engineTarget.replace(/^http/, 'ws');
const serverHost = process.env.VITE_HOST || '127.0.0.1';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: serverHost,
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': engineTarget,
      '/company-demo-state': engineTarget,
      '/audit-chain': engineTarget,
      '/intercept': engineTarget,
      '/decision': engineTarget,
      '/pending': engineTarget,
      '/sessions': engineTarget,
      '/session': engineTarget,
      '/inspect': engineTarget,
      '/ollama': engineTarget,
      '/ws': { target: wsTarget, ws: true },
    },
  },
});
