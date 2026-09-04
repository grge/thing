/**
 * Discovery and signalling, as an interface.
 *
 * The only thing a transport needs from discovery is: register me under an id,
 * tell me when a peer connects, and let me dial one. How that happens — a
 * public broker, a self-hosted signal server, a QR code, a copied URL — is
 * behind this interface and nothing above it should care.
 *
 * PeerJS implements this (peerjs-signalling.ts). It is deliberately not the
 * only thing that could: §9's pinning peer should be "just another peer", and a
 * hard dependency on one broker would make that harder than it needs to be.
 */

import type { PairDetail } from './metrics.js';

/**
 * A live bidirectional link to one peer.
 *
 * This is the raw byte pipe. Framing, chunking, and message semantics are the
 * transport's business (§6), not discovery's — that separation is the whole
 * point of this interface.
 */
export interface PeerLink {
  readonly peerId: string;
  /** True once the link can carry bytes. */
  readonly open: boolean;
  /** Bytes queued but not yet sent — the backpressure signal (§6). */
  readonly bufferedAmount: number;

  send(data: ArrayBuffer | string): void;
  close(): void;

  onData(handler: (data: ArrayBuffer | string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: string) => void): void;
}

/** Whether a link needed a TURN relay — the headline number for question 1. */
export interface LinkDiagnostics {
  usedRelay(): Promise<boolean | null>;
  /**
   * How the succeeding candidate pair was formed. Read from live ICE stats, so
   * it says what actually happened rather than what was configured.
   */
  pairDetail(): Promise<PairDetail | null>;
  iceState(): string | null;
  onIceStateChange(handler: (state: string) => void): void;
}

export interface Signalling {
  /** Register and return the id other peers dial. */
  start(preferredId?: string): Promise<string>;
  readonly localId: string | null;

  /** Dial a peer. Resolves when the link can carry bytes. */
  connect(peerId: string): Promise<PeerLink>;

  /** Inbound links, from peers that dialled us. */
  onPeer(handler: (link: PeerLink) => void): void;
  onError(handler: (err: string) => void): void;

  /** Diagnostics for a link, if the implementation can provide them. */
  diagnostics(link: PeerLink): LinkDiagnostics | null;

  stop(): void;
}
