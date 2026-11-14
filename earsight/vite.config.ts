import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';
import { relayPlugin } from './server/relayPlugin';

export default defineConfig({
  // HTTPS (self-signed) is required so a phone browser will allow camera access; host:true exposes the dev server on the LAN
  plugins: [...(process.env.NO_HTTPS ? [] : [basicSsl()]), relayPlugin()],
  server: { host: true, port: 5173, strictPort: true },
  worker: { format: 'es' },
  // pre-bundle everything the workers import up front: a dependency discovered late triggers a re-optimise that makes
  // the worker request fail ("worker crashed: unknown error") until the page is reloaded
  optimizeDeps: { exclude: ['@huggingface/transformers'], include: ['@techstark/opencv-js', 'qrcode'] },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), phone: resolve(__dirname, 'phone.html'), view: resolve(__dirname, 'view.html') } },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000 },
});
