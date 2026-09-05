/**
 * A signalling endpoint (ARCHITECTURE.md §5.6).
 *
 * Two browsers cannot dial each other, so something has to carry their offer,
 * answer and ICE candidates until a data channel opens. A peer with a stable
 * address already has the server that needs — so it introduces peers as well as
 * serving spaces, on a separate path of the same process.
 *
 * **It learns nothing about spaces.** Peers meet at an opaque token, which a
 * share link carries; this matches whoever presents the same one. A server that
 * could be asked "connect me to anyone serving space K" would learn which
 * spaces exist and who wants them, and that is the enumeration disclosure the
 * design avoids elsewhere (§5.7).
 *
 * **It is out of the path the moment a connection opens.** Nothing here relays
 * data, and there is no fallback that does: two peers who cannot reach each
 * other sync through a peer that holds the space instead (§5.6), which needs no
 * relay code and survives disconnection.
 */
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

interface Waiting {
  readonly id: string;
  readonly socket: WsSocket;
  token: string | null;
}

export interface SignalServerOptions {
  readonly port: number;
  readonly host?: string;
  /**
   * How many peers may wait at one token.
   *
   * A bound rather than a policy: without one, a token is somewhere to
   * accumulate connections at no cost to whoever opened them.
   */
  readonly maxPerToken?: number;
}

export class SignalServer {
  private readonly wss: WebSocketServer;
  private readonly peers = new Map<string, Waiting>();
  private readonly tokens = new Map<string, Set<string>>();
  private readonly max: number;

  constructor(options: SignalServerOptions) {
    this.max = options.maxPerToken ?? 32;
    this.wss = new WebSocketServer({
      port: options.port,
      ...(options.host === undefined ? {} : { host: options.host }),
    });

    this.wss.on('connection', (socket: WsSocket) => {
      const id = randomUUID().slice(0, 8);
      const waiting: Waiting = { id, socket, token: null };
      this.peers.set(id, waiting);
      this.say(socket, { type: 'HELLO', id });

      socket.on('message', (data: unknown) => this.onMessage(waiting, data));
      socket.on('close', () => this.forget(waiting));
    });
  }

  private onMessage(from: Waiting, data: unknown): void {
    let msg: { type?: string; token?: string; to?: string; payload?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // a broken peer must not be able to stop this one
    }

    if (msg.type === 'JOIN' && typeof msg.token === 'string') {
      this.joinToken(from, msg.token);
      return;
    }

    if (msg.type === 'SIGNAL' && typeof msg.to === 'string') {
      const target = this.peers.get(msg.to);
      // Only between peers at the same token: a peer cannot use this to reach
      // someone it was not introduced to.
      if (target === undefined || target.token === null || target.token !== from.token) return;
      this.say(target.socket, { type: 'SIGNAL', from: from.id, payload: msg.payload });
    }
  }

  private joinToken(waiting: Waiting, token: string): void {
    this.leaveToken(waiting);

    let members = this.tokens.get(token);
    if (members === undefined) {
      members = new Set();
      this.tokens.set(token, members);
    }
    if (members.size >= this.max) return;

    // Everyone already here learns of the newcomer, and the newcomer learns of
    // them. Who offers is decided by the peers, not here.
    for (const other of members) {
      const peer = this.peers.get(other);
      if (peer === undefined) continue;
      this.say(peer.socket, { type: 'PEER', peer: waiting.id });
      this.say(waiting.socket, { type: 'PEER', peer: other });
    }

    members.add(waiting.id);
    waiting.token = token;
  }

  private leaveToken(waiting: Waiting): void {
    if (waiting.token === null) return;
    const members = this.tokens.get(waiting.token);
    members?.delete(waiting.id);
    if (members?.size === 0) this.tokens.delete(waiting.token);
    waiting.token = null;
  }

  private forget(waiting: Waiting): void {
    this.leaveToken(waiting);
    this.peers.delete(waiting.id);
  }

  private say(socket: WsSocket, msg: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  get port(): number {
    const address = this.wss.address();
    if (address === null || typeof address === 'string') return 0;
    return address.port;
  }

  /** How many peers are waiting, for an operator watching a terminal. */
  get waiting(): number {
    return this.peers.size;
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss.address() !== null) return resolve();
      this.wss.once('listening', () => resolve());
      this.wss.once('error', reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
  }
}
