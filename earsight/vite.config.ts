import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';
import { relayPlugin } from './server/relayPlugin';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// shown next to the title so it is clear which deployed build is running: package version, short commit, build date
function buildLabel(): string {
  let sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
  if (!sha) { try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { sha = 'dev'; } }
  const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
  return `v${pkg.version} · ${sha} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export default defineConfig({
  define: { __BUILD_LABEL__: JSON.stringify(buildLabel()) },
  // HTTPS (self-signed) is required so a phone browser will allow camera access; host:true exposes the dev server on the LAN
  plugins: [...(process.env.NO_HTTPS ? [] : [basicSsl()]), relayPlugin()],
  server: { host: true, port: 5173, strictPort: true },
  worker: { format: 'es' },
  // pre-bundle everything the workers import up front: a dependency discovered late triggers a re-optimise that makes
  // the worker request fail ("worker crashed: unknown error") until the page is reloaded
  optimizeDeps: { exclude: ['@huggingface/transformers'], include: ['@techstark/opencv-js', 'qrcode'] },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), phone: resolve(__dirname, 'phone.html') } },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000 },
});
