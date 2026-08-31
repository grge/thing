import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';

describe('connection records', () => {
  it('records accepted connections, not only dialled ones', () => {
    // A mode 2 writer only ever accepts. Recording dials alone would leave the
    // writer's own tab — the one someone debugging is watching — empty.
    const m = new Metrics();
    m.beginConnection('peer-a');
    m.beginConnection('peer-b', 'accepted');
    expect(m.connections.map((c) => c.direction)).toEqual(['dialled', 'accepted']);
  });

  it('latestFor returns the most recent attempt, so a redial does not update a stale record', () => {
    const m = new Metrics();
    const first = m.beginConnection('peer-a');
    first.failedAt = Date.now();
    const second = m.beginConnection('peer-a');
    expect(m.latestFor('peer-a')).toBe(second);
    expect(m.latestFor('nobody')).toBeUndefined();
  });

  it('counts relayed and direct separately — the question 1 number is the split', () => {
    const m = new Metrics();
    const relayed = m.beginConnection('a');
    relayed.connectedAt = relayed.startedAt + 100;
    relayed.usedRelay = true;

    const direct = m.beginConnection('b');
    direct.connectedAt = direct.startedAt + 50;
    direct.usedRelay = false;

    // Unknown relay status must count as neither, rather than silently as direct.
    const unknown = m.beginConnection('c');
    unknown.connectedAt = unknown.startedAt + 10;

    const failed = m.beginConnection('d');
    failed.failedAt = failed.startedAt + 20;
    failed.error = 'negotiation failed';

    const s = m.summary();
    expect(s).toMatchObject({ attempts: 4, connected: 3, failed: 1, relayed: 1, direct: 1 });
    expect(s.failureRate).toBeCloseTo(0.25);
  });

  it('carries the negotiation detail and byte counts through toJSON', () => {
    const m = new Metrics();
    const c = m.beginConnection('a', 'accepted');
    c.connectedAt = c.startedAt + 5;
    c.iceStates.push('checking', 'connected');
    c.pair = { local: 'relay', remote: 'srflx', protocol: 'udp', relayProtocol: 'tls' };
    c.bytesSent = 2048;
    c.bytesReceived = 4096;

    const parsed = JSON.parse(m.toJSON()) as { connections: unknown[] };
    expect(parsed.connections[0]).toMatchObject({
      direction: 'accepted',
      iceStates: ['checking', 'connected'],
      pair: { local: 'relay', relayProtocol: 'tls' },
      bytesSent: 2048,
      bytesReceived: 4096,
    });
  });
});
