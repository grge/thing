/**
 * WebRTC transport.
 *
 * Produces the same two-method `Channel` the WebSocket transport does, so
 * nothing above it knows which is carrying the protocol (ARCHITECTURE.md §5.6).
 * A browser talking to a headless peer uses a socket; two browsers use this;
 * the `Session` cannot tell.
 *
 * **STUN is configured, not provided.** It answers "what does my address look
 * like from outside", which any server a peer contacts already sees, so running
 * one buys nothing. **TURN is supported and not the default**: §5.6 prefers two
 * unreachable peers syncing through a peer that holds the space, which needs no
 * relay and survives disconnection — but a relay that carries ciphertext it
 * cannot read is a genuinely different good, so the door stays open.
 */
import type { Channel } from '@thing/net';
import type { Signalling, SignalPayload } from './signalling.js';

/** Public STUN, replaceable. Nothing here depends on whose it is. */
export const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** The label both sides must agree on for the data channel. */
const CHANNEL_LABEL = 'thing';

export interface RtcConnection {
  readonly peer: string;
  readonly channel: Channel;
  onFrame(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface RtcOptions {
  readonly iceServers?: readonly RTCIceServer[];
  /** How long to wait for a data channel before giving up. */
  readonly timeoutMs?: number;
}

/**
 * A `Channel` over a data channel.
 *
 * Backpressure is the channel's own `bufferedAmount`, which is what blob
 * transfer waits on — so a large file cannot be queued faster than the
 * connection drains.
 */
function channelFor(dc: RTCDataChannel): Channel {
  return {
    send(frame: Uint8Array): void {
      // Copied into its own buffer: a Uint8Array may be a view onto a larger
      // one, and `send` would then put the whole backing buffer on the wire.
      dc.send(frame.slice().buffer as ArrayBuffer);
    },
    get bufferedAmount(): number {
      return dc.bufferedAmount;
    },
  };
}

function wire(peer: string, pc: RTCPeerConnection, dc: RTCDataChannel): RtcConnection {
  dc.binaryType = 'arraybuffer';
  const frameHandlers: ((data: Uint8Array) => void)[] = [];
  const closeHandlers: (() => void)[] = [];

  dc.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : null;
    if (bytes === null) return;
    for (const h of frameHandlers) h(bytes);
  });

  const closed = (): void => {
    for (const h of closeHandlers) h();
  };
  dc.addEventListener('close', closed);
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') closed();
  });

  return {
    peer,
    channel: channelFor(dc),
    onFrame: (h) => frameHandlers.push(h),
    onClose: (h) => closeHandlers.push(h),
    close: () => {
      dc.close();
      pc.close();
    },
  };
}

/**
 * Connect to a peer at the same rendezvous token.
 *
 * **Who offers is decided by comparing ids**, not by who arrived first: both
 * sides learn about each other, and without a rule both would offer and neither
 * would answer. Comparing ids is arbitrary and identical on both sides, which
 * is all it needs to be.
 */
export function connectVia(
  signalling: Signalling,
  peer: string,
  options: RtcOptions = {},
): Promise<RtcConnection> {
  const pc = new RTCPeerConnection({
    iceServers: [...(options.iceServers ?? DEFAULT_ICE)],
  });

  const polite = signalling.id < peer;
  let settled = false;

  return new Promise<RtcConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      pc.close();
      reject(new Error(`could not open a data channel to ${peer}`));
    }, options.timeoutMs ?? 20_000);

    const succeed = (dc: RTCDataChannel): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(wire(peer, pc, dc));
    };

    pc.addEventListener('icecandidate', (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate === null) return;
      signalling.send(peer, {
        kind: 'candidate',
        candidate: candidate.candidate,
        mid: candidate.sdpMid,
      });
    });

    signalling.onMessage((msg) => {
      if (msg.from !== peer) return;
      void handle(pc, msg.payload, signalling, peer);
    });

    if (polite) {
      // One side offers and creates the channel; the other waits for it.
      const dc = pc.createDataChannel(CHANNEL_LABEL);
      dc.addEventListener('open', () => succeed(dc), { once: true });
      void (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalling.send(peer, { kind: 'offer', sdp: offer.sdp ?? '' });
      })();
    } else {
      pc.addEventListener('datachannel', (event) => {
        const dc = (event as RTCDataChannelEvent).channel;
        if (dc.label !== CHANNEL_LABEL) return;
        if (dc.readyState === 'open') succeed(dc);
        else dc.addEventListener('open', () => succeed(dc), { once: true });
      });
    }
  });
}

/** Apply whatever the other side sent. */
async function handle(
  pc: RTCPeerConnection,
  payload: SignalPayload,
  signalling: Signalling,
  peer: string,
): Promise<void> {
  try {
    switch (payload.kind) {
      case 'offer': {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signalling.send(peer, { kind: 'answer', sdp: answer.sdp ?? '' });
        return;
      }
      case 'answer':
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        return;
      case 'candidate':
        // Candidates can arrive before the description they belong to; the
        // browser rejects those, and dropping one is not fatal because ICE
        // gathers several.
        await pc.addIceCandidate({
          candidate: payload.candidate,
          ...(payload.mid === null ? {} : { sdpMid: payload.mid }),
        });
        return;
    }
  } catch {
    // A malformed or out-of-order signal is the other peer being broken. It
    // must not throw here, where nothing is watching.
  }
}
