/**
 * Supplier <-> viewer link (peer to peer, WebRTC data channel via PeerJS).
 *
 * The VIEWER (e.g. the Meta glasses) opens the site, chooses "Viewer" and gets a short code. The SUPPLIER (e.g. the
 * phone) opens the same site, chooses "Supplier" and types the code. The supplier then sends
 *   - the audio data (left/right level, loudness, beeps per second, pitch) as small numbers,
 *   - the picture of the chosen view (camera for "peripheral", depth brightness for "light") as small JPEGs,
 * and the viewer plays the beeps and draws the picture. Neither side needs the other to be on the same Wi-Fi or on a
 * server of ours: PeerJS's free public broker (0.peerjs.com) is only used to introduce the two devices to each other
 * (it sees the code and the connection details, not the audio or the pictures, which go directly between the devices).
 */
import Peer, { type DataConnection } from 'peerjs';

export type ViewKind = 'peripheral' | 'light';

export interface LinkConfig {
  mode: ViewKind;
  mirror: boolean;
  pan: number;
}

export type LinkMessage =
  | { t: 'a'; l: number; r: number; rate: number; c: number; h: number }
  | ({ t: 'cfg' } & LinkConfig)
  | { t: 'pic'; d: Uint8Array };

export type LinkStatus = 'connecting' | 'waiting' | 'connected' | 'closed' | 'error';

/** characters without look-alikes (no 0/O, 1/I/L), easy to read out and to type on a phone */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateCode(random: (n: number) => number = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n): string {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return c;
}

/** uppercases, drops spaces/dashes and maps the usual look-alikes (0->O is not in the alphabet, so 0 is rejected) */
export function normalizeCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

export const peerIdFor = (code: string) => 'earsight-' + code;

const BACKPRESSURE = 300_000;

/** The device that shows/plays: creates the code and waits for the supplier. */
export class LinkViewer {
  code = generateCode();
  status: LinkStatus = 'connecting';
  detail = '';
  onChange: () => void = () => {};
  onMessage: (m: LinkMessage) => void = () => {};
  private peer: Peer | null = null;
  private tries = 0;

  start() {
    this.open();
  }

  private set(s: LinkStatus, detail = '') { this.status = s; this.detail = detail; this.onChange(); }

  private open() {
    this.peer?.destroy();
    this.set('connecting');
    const peer = new Peer(peerIdFor(this.code));
    this.peer = peer;
    peer.on('open', () => this.set('waiting'));
    peer.on('connection', (conn) => {
      conn.on('open', () => this.set('connected'));
      conn.on('data', (d) => this.onMessage(d as LinkMessage));
      conn.on('close', () => this.set('waiting'));
      conn.on('error', () => this.set('waiting'));
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* destroyed */ } });
    peer.on('error', (err: { type?: string; message?: string }) => {
      if (err.type === 'unavailable-id' && this.tries++ < 5) { this.code = generateCode(); this.open(); return; } // code already taken: pick another
      this.set('error', err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error'
        ? 'Could not reach the introduction server (needs internet).' : (err.message ?? String(err.type)));
    });
  }

  close() { this.peer?.destroy(); this.peer = null; }
}

/** The device with the camera: connects to the viewer by its code and sends audio data + pictures. */
export class LinkSupplier {
  status: LinkStatus = 'connecting';
  detail = '';
  onChange: () => void = () => {};
  private peer: Peer;
  private conn: DataConnection | null = null;
  private timers: number[] = [];
  private encoding = false;
  private small = document.createElement('canvas');

  constructor(readonly code: string) {
    this.peer = new Peer();
    this.peer.on('open', () => {
      const conn = this.peer.connect(peerIdFor(code), { reliable: true });
      this.conn = conn;
      conn.on('open', () => this.set('connected'));
      conn.on('close', () => this.set('closed'));
      conn.on('error', (e) => this.set('error', String(e)));
    });
    this.peer.on('error', (err: { type?: string; message?: string }) => {
      this.set('error', err.type === 'peer-unavailable' ? 'No viewer with this code. Check the code on the viewer.'
        : err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' ? 'Could not reach the introduction server (needs internet).'
        : (err.message ?? String(err.type)));
    });
  }

  private set(s: LinkStatus, detail = '') { this.status = s; this.detail = detail; this.onChange(); }

  private ready() {
    const dc = (this.conn as unknown as { dataChannel?: RTCDataChannel } | null)?.dataChannel;
    return this.conn?.open === true && (dc?.bufferedAmount ?? 0) < BACKPRESSURE;
  }

  private send(m: LinkMessage) { if (this.ready()) this.conn!.send(m); }

  sendAudio(l: number, r: number, rate: number, c: number, h: number) {
    const q = (x: number) => Math.round(x * 1000) / 1000;
    this.send({ t: 'a', l: q(l), r: q(r), rate: q(rate), c: q(c), h: q(h) });
  }

  /** starts the periodic settings + picture updates (about 8 pictures per second) */
  startStreaming(getConfig: () => LinkConfig, getPicture: () => HTMLCanvasElement | null) {
    this.timers.push(window.setInterval(() => this.send({ t: 'cfg', ...getConfig() }), 1000));
    this.timers.push(window.setInterval(() => {
      const src = getPicture();
      if (!src || !(src.width > 0) || this.encoding || !this.ready()) return;
      this.encoding = true;
      const w = Math.min(320, src.width), h = Math.max(1, Math.round((w * src.height) / src.width));
      if (this.small.width !== w || this.small.height !== h) { this.small.width = w; this.small.height = h; }
      this.small.getContext('2d')!.drawImage(src, 0, 0, w, h);
      this.small.toBlob(async (blob) => {
        try { if (blob) this.send({ t: 'pic', d: new Uint8Array(await blob.arrayBuffer()) }); } finally { this.encoding = false; }
      }, 'image/jpeg', 0.6);
    }, 120));
  }

  close() { this.timers.forEach(clearInterval); this.timers = []; this.peer.destroy(); }
}
