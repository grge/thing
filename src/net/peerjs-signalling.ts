/**
 * PeerJS as a `Signalling` implementation — **discovery only**.
 *
 * PeerJS does two jobs: it brokers the offer/answer exchange, and it layers a
 * messaging protocol (BinaryPack or JSON, plus its own chunking at 16300 bytes)
 * over the data channel. Only the first is wanted here.
 *
 * So `conn.send()` is never called. Bytes go through `conn.dataChannel`, the
 * real RTCDataChannel underneath, which means:
 *
 *   - our framing is the only framing (§6), not one of two
 *   - `bufferedAmount` is the channel's own, not a wrapper's
 *   - chunk size is sized against SCTP, as §6 intends, rather than against a
 *     library's message cap
 *   - measurements for POC question 1 describe WebRTC rather than
 *     PeerJS-over-WebRTC
 *
 * Replacing this file with a self-hosted signal server should require no change
 * above it.
 */
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { iceServers } from './iceservers.js';
import type { LinkDiagnostics, PeerLink, Signalling } from './signalling.js';

class PeerJsLink implements PeerLink {
  private dataHandlers: ((d: ArrayBuffer | string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private errorHandlers: ((e: string) => void)[] = [];
  private wired = false;

  constructor(private conn: DataConnection) {
    conn.on('open', () => this.wire());
    conn.on('close', () => this.closeHandlers.forEach((h) => h()));
    conn.on('error', (err) => this.errorHandlers.forEach((h) => h(String(err))));
    if (conn.open) this.wire();
  }

  /**
   * Attach to the underlying RTCDataChannel, bypassing PeerJS's message layer.
   *
   * PeerJS has its own `message` listener on this channel; ours runs alongside
   * it. PeerJS will fail to parse our frames and may log about it, which is
   * harmless — but it is why nothing here uses `conn.send()`, since mixing the
   * two would give PeerJS frames we then have to distinguish from our own.
   */
  private wire(): void {
    if (this.wired) return;
    const dc = this.channel;
    if (dc === null) return;
    this.wired = true;

    dc.binaryType = 'arraybuffer';
    dc.addEventListener('message', (e: MessageEvent) => {
      this.dataHandlers.forEach((h) => h(e.data as ArrayBuffer | string));
    });
    this.openHandlers.forEach((h) => h());
  }

  private get channel(): RTCDataChannel | null {
    return (this.conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel ?? null;
  }

  get peerId(): string {
    return this.conn.peer;
  }

  get open(): boolean {
    return this.channel?.readyState === 'open';
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  send(data: ArrayBuffer | string): void {
    const dc = this.channel;
    if (dc === null || dc.readyState !== 'open') {
      throw new Error(`link to ${this.peerId} is not open`);
    }
    if (typeof data === 'string') dc.send(data);
    else dc.send(data);
  }

  close(): void {
    this.conn.close();
  }

  onData(h: (d: ArrayBuffer | string) => void): void {
    this.dataHandlers.push(h);
  }
  onOpen(h: () => void): void {
    this.openHandlers.push(h);
    if (this.open) h();
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  onError(h: (e: string) => void): void {
    this.errorHandlers.push(h);
  }

  get peerConnection(): RTCPeerConnection | null {
    return (this.conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection ?? null;
  }
}

class PeerJsDiagnostics implements LinkDiagnostics {
  constructor(private link: PeerJsLink) {}

  iceState(): string | null {
    return this.link.peerConnection?.iceConnectionState ?? null;
  }

  onIceStateChange(handler: (state: string) => void): void {
    const attach = (): void => {
      const pc = this.link.peerConnection;
      if (pc === null) {
        setTimeout(attach, 100);
        return;
      }
      pc.addEventListener('iceconnectionstatechange', () =>
        handler(pc.iceConnectionState),
      );
    };
    attach();
  }

  /** Read from live ICE stats rather than assumed — this is the Q1 number. */
  async usedRelay(): Promise<boolean | null> {
    const pc = this.link.peerConnection;
    if (pc === null) return null;
    try {
      // RTCStatsReport is a Map at runtime; the DOM lib's type omits that.
      const stats = (await pc.getStats()) as unknown as Map<string, Record<string, unknown>>;
      for (const report of stats.values()) {
        if (report['type'] === 'candidate-pair' && report['state'] === 'succeeded') {
          const local = stats.get(report['localCandidateId'] as string);
          return local?.['candidateType'] === 'relay';
        }
      }
    } catch {
      // Best effort; a missing number beats a thrown one.
    }
    return null;
  }
}

export class PeerJsSignalling implements Signalling {
  private peer: Peer | null = null;
  private peerHandlers: ((l: PeerLink) => void)[] = [];
  private errorHandlers: ((e: string) => void)[] = [];
  private links = new WeakMap<PeerLink, PeerJsLink>();

  get localId(): string | null {
    return this.peer?.id ?? null;
  }

  async start(preferredId?: string): Promise<string> {
    /*
     * Resolved before the peer exists, because PeerJS takes its ICE config at
     * construction and never re-reads it. See `iceservers.ts` for why the
     * credentials are fetched rather than bundled, and why a failed fetch
     * degrades to STUN instead of throwing.
     */
    const servers = await iceServers();

    return new Promise((resolve, reject) => {
      const options = {
        config: { iceServers: servers },
        debug: 1 as const,
      };
      const peer = preferredId != null ? new Peer(preferredId, options) : new Peer(options);
      this.peer = peer;

      let opened = false;
      peer.on('open', (id) => {
        opened = true;
        resolve(id);
      });

      // PeerJS reports connection failures on the peer object too. Once the
      // peer is open those must not reject a promise that already settled.
      peer.on('error', (err) => {
        this.errorHandlers.forEach((h) => h(String(err)));
        if (!opened) reject(err);
      });

      peer.on('connection', (conn) => {
        const link = new PeerJsLink(conn);
        this.links.set(link, link);
        this.peerHandlers.forEach((h) => h(link));
      });

      peer.on('disconnected', () =>
        this.errorHandlers.forEach((h) => h('signalling disconnected')),
      );
    });
  }

  connect(peerId: string): Promise<PeerLink> {
    return new Promise((resolve, reject) => {
      const peer = this.peer;
      if (peer === null) {
        reject(new Error('signalling not started'));
        return;
      }
      if (peerId === peer.id) {
        reject(new Error('cannot connect to self'));
        return;
      }

      /*
       * `serialization: 'raw'` — PeerJS's `SerializationType.None`, confusingly
       * spelled "raw" on the wire. This tells PeerJS not to touch the payload.
       *
       * It matters even though `conn.send()` is never called: the *receiving*
       * side constructs its connection from the serialization named in the
       * offer, so both ends must agree, and any other value makes PeerJS
       * install a parser that will choke on our frames.
       */
      const conn = peer.connect(peerId, { reliable: true, serialization: 'raw' });
      const link = new PeerJsLink(conn);
      this.links.set(link, link);

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`connection to ${peerId} timed out`));
      }, 20_000);

      link.onOpen(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(link);
      });

      conn.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  onPeer(h: (l: PeerLink) => void): void {
    this.peerHandlers.push(h);
  }

  onError(h: (e: string) => void): void {
    this.errorHandlers.push(h);
  }

  diagnostics(link: PeerLink): LinkDiagnostics | null {
    const impl = this.links.get(link);
    return impl === undefined ? null : new PeerJsDiagnostics(impl);
  }

  stop(): void {
    this.peer?.destroy();
    this.peer = null;
  }
}
