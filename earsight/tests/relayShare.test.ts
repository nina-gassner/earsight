import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRelay } from '../server/relayPlugin';

const ROOM = 'abcdef0123456789abcdef01';
const OTHER = 'zzzzzzzzzzzzzzzzzzzzzzzz';
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer();
  attachRelay(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

function connect(room: string, role: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?room=${room}&role=${role}`);
  const got: { text?: string; bytes?: number }[] = [];
  ws.on('message', (d, bin) => got.push(bin ? { bytes: (d as Buffer).length } : { text: String(d) }));
  return { ws, got, open: new Promise<void>((r) => ws.on('open', () => r())) };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('share channel relay', () => {
  it('forwards the sender\'s audio data and pictures to viewers of the same room only', async () => {
    const viewer = connect(ROOM, 'viewer');
    const stranger = connect(OTHER, 'viewer');
    await Promise.all([viewer.open, stranger.open]);
    const sender = connect(ROOM, 'sender');
    await sender.open;
    sender.ws.send(JSON.stringify({ t: 'a', l: 0.2, r: 0.9, rate: 12, c: 0.7, h: 0.3 }));
    sender.ws.send(Buffer.alloc(500, 1));
    await wait(200);
    expect(viewer.got.some((m) => m.text?.includes('"t":"a"') && m.text.includes('"r":0.9'))).toBe(true);
    expect(viewer.got.some((m) => m.bytes === 500)).toBe(true);
    expect(stranger.got.some((m) => m.text?.includes('"t":"a"') || m.bytes)).toBe(false);
    // both sides learn about each other
    expect(viewer.got.some((m) => m.text?.includes('"sender":true'))).toBe(true);
    expect(sender.got.some((m) => m.text?.includes('"viewers":1'))).toBe(true);
    for (const c of [viewer, stranger, sender]) c.ws.close();
  });

  it('a viewer cannot send anything to the sender', async () => {
    const sender = connect(ROOM, 'sender');
    const viewer = connect(ROOM, 'viewer');
    await Promise.all([sender.open, viewer.open]);
    await wait(100);
    const before = sender.got.length;
    viewer.ws.send(JSON.stringify({ t: 'a', l: 1, r: 1, rate: 30, c: 1, h: 0 }));
    await wait(200);
    expect(sender.got.length).toBe(before);
    sender.ws.close(); viewer.ws.close();
  });
});
