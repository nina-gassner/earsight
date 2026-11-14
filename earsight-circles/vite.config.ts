import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';
import { relayPlugin } from './server/relayPlugin';

export default defineConfig({
  // HTTPS (self-signed) is required so a phone browser will allow camera access; host:true exposes the dev server on the LAN
  plugins: [basicSsl(), relayPlugin()],
  server: { host: true, port: 5174, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), phone: resolve(__dirname, 'phone.html') } },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000 },
});
