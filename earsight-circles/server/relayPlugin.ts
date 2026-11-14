import os from 'node:os';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Dev-server relay for the phone camera: the phone page sends JPEG frames over a WebSocket, the laptop page receives
 * them. Frames are only forwarded between sockets that share the same random room token (shown in the QR code).
 * Nothing leaves the local network; this exists only while `npm run dev` is running.
 */

function relayInfo(_req: unknown, res: { setHeader(k: string, v: string): void; end(s: string): void }) {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  const lan = (x: string) => Number(/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(x));
  ips.sort((a, b) => lan(b) - lan(a));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ips }));
}

export function relayPlugin(): Plugin {
  return {
    name: 'earsight-relay',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
      const rooms = new Map<string, { laptops: Set<WebSocket>; phones: Set<WebSocket> }>();

      server.httpServer?.on('upgrade', (req, socket, head) => {
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
          const tell = (set: Set<WebSocket>, text: string) => { for (const s of set) if (s.readyState === 1) s.send(text); };
          if (role === 'phone') tell(r.laptops, 'phone-connected');
          else if (r.phones.size > 0) ws.send('phone-connected');
          ws.on('message', (data, isBinary) => {
            if (role !== 'phone' || !isBinary) return;
            for (const l of r.laptops) if (l.readyState === 1 && l.bufferedAmount < 2_000_000) l.send(data, { binary: true });
          });
          ws.on('close', () => {
            mine.delete(ws);
            if (role === 'phone') tell(r.laptops, r.phones.size ? 'phone-connected' : 'phone-left');
            if (r.laptops.size === 0 && r.phones.size === 0) rooms.delete(room);
          });
        });
      });

      server.middlewares.use('/relay-info', relayInfo);
    },
    // the production preview server also needs the LAN address for the "run on phone" QR code
    configurePreviewServer(server) { server.middlewares.use('/relay-info', relayInfo); },
  };
}
