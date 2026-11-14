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
  /** 0..1 volume chosen on the supplier */
  vol?: number;
}

export type LinkMessage =
  | { t: 'a'; n: number; l: number; r: number; rate: number; c: number; h: number }
  | ({ t: 'cfg' } & LinkConfig)
  | { t: 'pic'; n: number; d: Uint8Array };

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

/**
 * STUN finds the direct route. TURN (a relay) is the fallback when the two devices cannot reach each other directly
 * (different networks, mobile data, strict NATs, glasses). Public relays are unreliable, so your own can be set at build
 * time: VITE_TURN_URLS (comma separated, e.g. "turn:a.example.com:3478,turns:a.example.com:443?transport=tcp"),
 * VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL (in GitHub: repository secrets/variables, passed by the Pages workflow).
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const ownTurn = (env.VITE_TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
export const HAS_OWN_TURN = ownTurn.length > 0;
const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...(HAS_OWN_TURN ? [{ urls: ownTurn, username: env.VITE_TURN_USERNAME ?? '', credential: env.VITE_TURN_CREDENTIAL ?? '' }] : []),
    ],
  },
};

export const peerIdFor = (code: string) => 'earsight-' + code;

/** never let data queue up: a late picture or beep is worthless, so when the link is behind we drop instead of buffering */
const BACKPRESSURE = 40_000;

/**
 * Diagnostics: which kinds of ICE candidates a device found (host = local address, mdns = hidden local address that the
 * other side may not be able to resolve, srflx = public address via STUN, relay = via a TURN server), and after connecting
 * which route is really used (direct or relay). Shown next to the status so a failing device can be understood.
 */
export class IceWatch {
  private seen = { host: 0, mdns: 0, srflx: 0, relay: 0 };
  route = '';
  constructor(private pc: RTCPeerConnection | undefined, private onInfo: () => void) {
    pc?.addEventListener('icecandidate', (e) => {
      const c = e.candidate?.candidate ?? '';
      const t = /typ (\w+)/.exec(c)?.[1];
      if (t === 'host') { if (/\.local/.test(c)) this.seen.mdns++; else this.seen.host++; }
      else if (t === 'srflx') this.seen.srflx++;
      else if (t === 'relay') this.seen.relay++;
      this.onInfo();
    });
  }
  summary(): string {
    const s = this.seen;
    return `ICE found: local ${s.host}, hidden-local ${s.mdns}, public ${s.srflx}, relay ${s.relay}` + (this.route ? `; route: ${this.route}` : '');
  }
  async resolveRoute() {
    try {
      const stats = await this.pc!.getStats();
      let pair: any = null;
      stats.forEach((r: any) => { if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r; });
      if (!pair) return;
      const local: any = stats.get(pair.localCandidateId), remote: any = stats.get(pair.remoteCandidateId);
      const lt = local?.candidateType, rt = remote?.candidateType;
      this.route = lt === 'relay' || rt === 'relay' ? 'RELAY (slow, via a server)' : `direct (${lt}/${rt})`;
      this.onInfo();
    } catch { /* stats not available */ }
  }
}

/** The device that shows/plays: creates the code and waits for the supplier. */
export class LinkViewer {
  code = generateCode();
  status: LinkStatus = 'connecting';
  detail = '';
  onChange: () => void = () => {};
  onMessage: (m: LinkMessage) => void = () => {};
  ice = '';
  private peer: Peer | null = null;
  private tries = 0;

  start() {
    this.open();
  }

  private set(s: LinkStatus, detail = '') { this.status = s; this.detail = detail; this.onChange(); }

  private open() {
    this.peer?.destroy();
    this.set('connecting');
    const peer = new Peer(peerIdFor(this.code), PEER_OPTIONS);
    this.peer = peer;
    peer.on('open', () => this.set('waiting'));
    peer.on('connection', (conn) => {
      const ice = new IceWatch((conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection, () => { this.ice = ice.summary(); this.onChange(); });
      conn.on('open', () => { this.set('connected'); void ice.resolveRoute(); });
      conn.on('data', (d) => this.onMessage(d as LinkMessage));
      conn.on('close', () => this.set('waiting'));
      conn.on('error', (e: { message?: string }) => this.set('waiting', 'A device found this code but the connection failed (' + (e?.message ?? 'unknown') + ').'));
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
  private seq = 0;
  private small = document.createElement('canvas');

  ice = '';
  private retried = false;

  constructor(readonly code: string) {
    this.peer = new Peer(PEER_OPTIONS);
    this.peer.on('open', () => this.connect(false));
    this.peer.on('error', (err: { type?: string; message?: string }) => this.onFail(err));
  }

  private onFail(err: { type?: string; message?: string }) {
    {
      // the first attempt is unordered (a lost packet must not hold up everything behind it: that is what makes a live
      // feed lag by seconds). If the handshake fails, try once more with a reliable channel before giving up.
      if (!this.retried && /negotiation/i.test(err.message ?? '')) { this.retried = true; this.set('connecting'); this.connect(true); return; }
      this.set('error', err.type === 'peer-unavailable' ? 'No viewer with this code. Check the code on the viewer.'
        : err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' ? 'Could not reach the introduction server (needs internet).'
        : /negotiation/i.test(err.message ?? '') ? 'The two devices could not connect directly. They are probably on different networks and no relay (TURN server) was reachable.'
        : (err.message ?? String(err.type)));
    }
  }

  private connect(reliable: boolean) {
    if (this.conn) { this.conn.removeAllListeners(); this.conn.close(); }
    const conn = this.peer.connect(peerIdFor(this.code), { reliable });
    this.conn = conn;
    const ice = new IceWatch((conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection, () => { this.ice = ice.summary(); this.onChange(); });
    conn.on('open', () => { this.set('connected'); void ice.resolveRoute(); });
    conn.on('close', () => this.set('closed'));
    conn.on('error', (e) => this.onFail(e as { type?: string; message?: string }));
  }

  private set(s: LinkStatus, detail = '') { this.status = s; this.detail = detail; this.onChange(); }

  private ready() {
    const c = this.conn as unknown as { dataChannel?: RTCDataChannel; bufferSize?: number } | null;
    return this.conn?.open === true && (c?.dataChannel?.bufferedAmount ?? 0) < BACKPRESSURE && (c?.bufferSize ?? 0) === 0;
  }

  private send(m: LinkMessage) { if (this.ready()) this.conn!.send(m); }

  sendAudio(l: number, r: number, rate: number, c: number, h: number) {
    const q = (x: number) => Math.round(x * 1000) / 1000;
    this.send({ t: 'a', n: ++this.seq, l: q(l), r: q(r), rate: q(rate), c: q(c), h: q(h) });
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
        try { if (blob) this.send({ t: 'pic', n: ++this.seq, d: new Uint8Array(await blob.arrayBuffer()) }); } finally { this.encoding = false; }
      }, 'image/jpeg', 0.5);
    }, 125));
  }

  close() { this.timers.forEach(clearInterval); this.timers = []; this.peer.destroy(); }
}
