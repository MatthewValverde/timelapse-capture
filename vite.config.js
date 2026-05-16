import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // expose on LAN so phones can connect via local IP
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
