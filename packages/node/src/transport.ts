/**
 * WebSocket transport, both halves.
 *
 * A peer needs to be dialled *or* to dial, and which it does is about
 * reachability rather than about being headless (ARCHITECTURE.md §5.6). A peer
 * at a stable address accepts connections; one behind NAT opens them outward.
 * Both wrap a socket in the same two-method `Channel` and hand it to the same
 * `Session`, so nothing above this file knows which happened.
 */
import type { Channel } from '@thing/net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

/**
 * Anything with the WebSocket shape this needs.
 *
 * Node's global `WebSocket` and `ws`'s server-side socket both satisfy it, so
 * one adapter covers dialling out and being dialled.
 */
interface SocketLike {
  send(data: Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
  addEventListener?(type: string, handler: (event: unknown) => void): void;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * A `Channel` over a WebSocket.
 *
 * Backpressure comes from the socket's own `bufferedAmount`, which is what
 * `sendBlob` waits on — so a large transfer cannot queue faster than the
 * connection drains.
 */
export function channelFor(socket: SocketLike): Channel {
  return {
    send(frame: Uint8Array): void {
      socket.send(frame);
    },
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
  };
}

/** What a transport hands back for each connection. */
export interface Connection {
  /** A stable identifier for this connection, for attributing ephemeral messages. */
  readonly peer: string;
  readonly channel: Channel;
  /** Deliver an incoming frame. */
  onFrame(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Normalise the two event styles — `ws` uses Node's emitter, the global uses DOM. */
function wire(socket: SocketLike, peer: string): Connection {
  const frameHandlers: ((data: Uint8Array) => void)[] = [];
  const closeHandlers: (() => void)[] = [];

  const deliver = (data: unknown): void => {
    const bytes = toBytes(data);
    if (bytes === null) return;
    for (const h of frameHandlers) h(bytes);
  };

  if (typeof socket.on === 'function') {
    socket.on('message', (data) => deliver(data));
    socket.on('close', () => {
      for (const h of closeHandlers) h();
    });
  } else if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', (event) => {
      deliver((event as { data: unknown }).data);
    });
    socket.addEventListener('close', () => {
      for (const h of closeHandlers) h();
    });
  }

  return {
    peer,
    channel: channelFor(socket),
    onFrame: (h) => frameHandlers.push(h),
    onClose: (h) => closeHandlers.push(h),
    close: () => socket.close(),
  };
}

/**
 * Whatever a WebSocket delivered, as bytes.
 *
 * The two implementations disagree about the type — Node's global gives a Blob
 * or ArrayBuffer, `ws` gives a Buffer — so this normalises rather than making
 * every caller care.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    // `ws` may deliver a fragmented message as an array of buffers.
    const parts = data.filter((d): d is Uint8Array => d instanceof Uint8Array);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return null;
}

/* ── being dialled ──────────────────────────────────────────────────────── */

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
}

/**
 * Accept connections.
 *
 * What makes a peer reachable, and therefore what makes it able to introduce
 * others or hold a space they can both sync with (§5.6). It grants no
 * authority — a peer here is an ordinary participant that happens to have an
 * address.
 */
export class PeerServer {
  private readonly wss: WebSocketServer;
  private readonly handlers: ((conn: Connection) => void)[] = [];
  private nextId = 0;

  constructor(options: ServerOptions) {
    this.wss = new WebSocketServer({
      port: options.port,
      ...(options.host === undefined ? {} : { host: options.host }),
    });
    this.wss.on('connection', (socket: WsSocket) => {
      // Frames are binary; a text frame would arrive as a string and fail to
      // decode, which the protocol treats as a malformed frame either way.
      socket.binaryType = 'nodebuffer';
      this.nextId += 1;
      const conn = wire(socket as unknown as SocketLike, `in:${this.nextId}`);
      for (const h of this.handlers) h(conn);
    });
  }

  onConnection(handler: (conn: Connection) => void): void {
    this.handlers.push(handler);
  }

  /** The port actually bound, which matters when 0 was requested. */
  get port(): number {
    const address = this.wss.address();
    if (address === null || typeof address === 'string') return 0;
    return address.port;
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

/* ── dialling out ───────────────────────────────────────────────────────── */

/**
 * Open a connection to a peer at a known address.
 *
 * This is how an unreachable peer participates: it cannot be dialled, so it
 * dials. Once open the connection is symmetric — the protocol does not care who
 * initiated it.
 */
export function dial(url: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    const onOpen = (): void => {
      cleanup();
      resolve(wire(socket as unknown as SocketLike, `out:${url}`));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`could not reach ${url}`));
    };
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}
