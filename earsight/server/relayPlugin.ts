import fs from 'node:fs';
import os from 'node:os';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import QRCode from 'qrcode';

/**
 * Dev-server relay for the phone camera: the phone page sends JPEG frames over a WebSocket, the laptop page receives
 * them. Frames are only forwarded between sockets that share the same random room token (shown in the QR code).
 * Nothing leaves the local network; this exists only while `npm run dev` is running.
 */


const VIRTUAL_RE = /vethernet|wsl|hyper-v|vmware|virtualbox|vbox|docker|loopback|tailscale|zerotier|bluetooth/i;
const LAN_RE = /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/;
/** non-internal IPv4 addresses, home/office LAN ranges first. Node < 18.4 reports family as the number 4. */
export function lanIps(): { ips: string[]; all: string[] } {
  const ips: string[] = [], all: string[] = [];
  const virtual = new Set<string>();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      const fam = (i as { family: string | number }).family;
      all.push(`${name}:${i.address}${i.internal ? '(internal)' : ''}`);
      if ((fam === 'IPv4' || fam === 4) && !i.internal) { ips.push(i.address); if (VIRTUAL_RE.test(name)) virtual.add(i.address); }
    }
  }
  // real Wi-Fi/Ethernet first; WSL / Hyper-V / VMware / VirtualBox / Docker adapters are not reachable from a phone
  const score = (x: string) => Number(LAN_RE.test(x)) - (virtual.has(x) ? 2 : 0);
  ips.sort((a, b) => score(b) - score(a));
  return { ips, all };
}

function relayInfo(_req: unknown, res: { setHeader(k: string, v: string): void; end(s: string): void }) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(lanIps()));
}

function printTerminalQr(httpServer: import('node:http').Server | import('node:https').Server | import('node:http2').Http2Server | null | undefined, isHttps: () => boolean) {
  httpServer?.once('listening', async () => {
    try {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 5173;
      const { ips, all } = lanIps();
      if (!ips.length) { console.log('\n  No LAN IPv4 address found, so no phone QR can be shown. Interfaces seen: ' + (all.join(', ') || 'none') + '\n'); return; }
      const url = `${isHttps() ? 'https' : 'http'}://${ips[0]}:${port}/`;
      const qr = await QRCode.toString(url, { type: 'terminal', small: true });
      setTimeout(() => console.log(`\n  Open the whole app on your phone (same Wi-Fi), scan:\n\n${qr}\n  ${url}\n`), 300);
    } catch { /* optional nicety */ }
  });
}

type AnyHttpServer = import('node:http').Server | import('node:https').Server | import('node:http2').Http2Server | null | undefined;

/** WebSocket relay on /relay: phone -> laptop, only between sockets sharing the same room token. Used by dev AND preview servers. */
function attachRelay(httpServer: AnyHttpServer) {
  if (!httpServer) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const rooms = new Map<string, { laptops: Set<WebSocket>; phones: Set<WebSocket> }>();
  httpServer.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '', 'http://localhost');
    if (u.pathname !== '/relay') return; // leave Vite's own HMR socket alone
    const room = u.searchParams.get('room') ?? '';
    const role = u.searchParams.get('role');
    if (!/^[a-z0-9]{12,64}$/i.test(room) || (role !== 'phone' && role !== 'laptop')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const r = rooms.get(room) ?? { laptops: new Set(), phones: new Set() };
      rooms.set(room, r);
      const mine = role === 'phone' ? r.phones : r.laptops;
      mine.add(ws);
      const tell = (set: Set<WebSocket>, text: string) => { for (const x of set) if (x.readyState === 1) x.send(text); };
      console.log(`  [relay] ${role} connected (room ${room.slice(0, 6)}…)`);
      if (role === 'phone') { tell(r.laptops, 'phone-connected'); ws.send(r.laptops.size ? 'laptop-listening' : 'no-laptop'); }
      else { tell(r.phones, 'laptop-listening'); if (r.phones.size > 0) ws.send('phone-connected'); }
      let frames = 0;
      let lastWarn = 0;
      ws.on('message', (data, isBinary) => {
        if (role !== 'phone' || !isBinary) return;
        if (++frames === 1) console.log(`  [relay] first frame from phone (${(data as Buffer).length} bytes), ${r.laptops.size} laptop page(s) listening`);
        if (r.laptops.size === 0 && Date.now() - lastWarn > 2000) { lastWarn = Date.now(); ws.send('no-laptop'); }
        for (const l of r.laptops) if (l.readyState === 1 && l.bufferedAmount < 2_000_000) l.send(data, { binary: true });
      });
      ws.on('close', () => {
        console.log(`  [relay] ${role} disconnected`);
        mine.delete(ws);
        if (role === 'phone') tell(r.laptops, r.phones.size ? 'phone-connected' : 'phone-left');
        if (r.laptops.size === 0 && r.phones.size === 0) rooms.delete(room);
      });
    });
  });
}

export function relayPlugin(): Plugin {
  const https = (plugins: readonly { name: string }[]) => () => plugins.some((pl) => pl.name.includes('basic-ssl'));
  return {
    name: 'earsight-relay',
    configureServer(server) {
      attachRelay(server.httpServer);
      server.middlewares.use('/relay-info', relayInfo);
      // dev-only: the evaluation renderer saves rendered frames here (test-results/eval/<name>)
      server.middlewares.use('/eval-save', (req, res) => {
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '').replace(/[^a-zA-Z0-9_.-]/g, '');
        if (req.method !== 'POST' || !name) { res.statusCode = 400; res.end('bad request'); return; }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync('test-results/eval', { recursive: true });
          fs.writeFileSync('test-results/eval/' + name, Buffer.concat(chunks));
          res.end('ok');
        });
      });
      printTerminalQr(server.httpServer, https(server.config.plugins));
    },
    // `npm run phone` serves the production build with vite preview: it needs the relay, the address lookup and the QR as well
    configurePreviewServer(server) {
      attachRelay(server.httpServer);
      server.middlewares.use('/relay-info', relayInfo);
      printTerminalQr(server.httpServer, https(server.config.plugins));
    },
  };
}
