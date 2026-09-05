/**
 * Introduction (ARCHITECTURE.md §5.6).
 *
 * Two browsers cannot dial each other, so something has to carry their offer,
 * answer and ICE candidates until a data channel opens. That is all this does:
 * one round trip, then it is out of the path entirely.
 *
 * **Rendezvous is opaque.** Peers agree on a token — a share link carries one —
 * and the server matches whoever presents the same token. It is never told
 * which *space* they are meeting about, because a server that could be asked
 * "connect me to anyone serving space K" would learn which spaces exist and who
 * wants them. That is the enumeration disclosure the design avoids elsewhere
 * (§5.7), and the question of what a peer may ask about a space it names
 * belongs with resolution (§5.3).
 *
 * **Deliberately narrow.** Signalling is not transport: the moment a connection
 * is open this interface stops being involved. A library that bundled the two
 * would put its own framing and chunking underneath the protocol, and any
 * measurement would then describe the library rather than the connection.
 */

/** What one peer sends another to establish a connection. */
export type SignalPayload =
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | { readonly kind: 'candidate'; readonly candidate: string; readonly mid: string | null };

export interface SignalMessage {
  /** Who it is from, as the signalling server sees them. Not an identity. */
  readonly from: string;
  readonly payload: SignalPayload;
}

/**
 * A way to be introduced.
 *
 * Implementations are interchangeable: this one speaks to a headless peer's
 * signalling endpoint, but a third-party broker could satisfy the same
 * interface without knowing anything about spaces.
 */
export interface Signalling {
  /** This peer's id at the server, for the duration of the session. */
  readonly id: string;
  /** Wait at a token, so anyone else presenting it can be introduced. */
  join(token: string): Promise<void>;
  /** Send to one peer at the same token. */
  send(to: string, payload: SignalPayload): void;
  onMessage(handler: (msg: SignalMessage) => void): void;
  /** A peer arrived at the same token; the caller decides who offers. */
  onPeer(handler: (peer: string) => void): void;
  close(): void;
}

/* ── the wire, between a browser and a signalling endpoint ──────────────── */

export type SignalWire =
  | { readonly type: 'HELLO'; readonly id: string }
  | { readonly type: 'JOIN'; readonly token: string }
  | { readonly type: 'PEER'; readonly peer: string }
  | { readonly type: 'SIGNAL'; readonly to?: string; readonly from?: string; readonly payload: SignalPayload };

/** Signalling over a WebSocket, which is what a headless peer offers. */
export class WebSocketSignalling implements Signalling {
  private socket: WebSocket | null = null;
  private assigned = '';
  private readonly messageHandlers: ((msg: SignalMessage) => void)[] = [];
  private readonly peerHandlers: ((peer: string) => void)[] = [];

  constructor(private readonly url: string) {}

  get id(): string {
    return this.assigned;
  }

  async join(token: string): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`no signalling at ${this.url}`)), {
        once: true,
      });
    });

    socket.addEventListener('message', (event) => {
      let msg: SignalWire;
      try {
        msg = JSON.parse(String(event.data)) as SignalWire;
      } catch {
        // A malformed frame is the server being broken; it must not be able to
        // stop this peer.
        return;
      }

      switch (msg.type) {
        case 'HELLO':
          this.assigned = msg.id;
          return;
        case 'PEER':
          for (const h of this.peerHandlers) h(msg.peer);
          return;
        case 'SIGNAL':
          if (msg.from === undefined) return;
          for (const h of this.messageHandlers) h({ from: msg.from, payload: msg.payload });
          return;
        default:
          return;
      }
    });

    this.say({ type: 'JOIN', token });
  }

  send(to: string, payload: SignalPayload): void {
    this.say({ type: 'SIGNAL', to, payload });
  }

  onMessage(handler: (msg: SignalMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onPeer(handler: (peer: string) => void): void {
    this.peerHandlers.push(handler);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private say(msg: SignalWire): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}
