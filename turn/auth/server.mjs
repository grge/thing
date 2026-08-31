/**
 * The same credential service as worker.js, as a dependency-free Node server.
 *
 * Use this if you would rather not add Cloudflare to the stack — it is the
 * identical HMAC scheme, and either can sit in front of the same coturn.
 *
 *   TURN_SECRET=... TURN_URLS=turn:turn.example.com:3478 node server.mjs
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.TURN_SECRET;
const URLS = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const TTL = Number(process.env.TTL_SECONDS ?? 3600);
const PORT = Number(process.env.PORT ?? 8787);

if (!SECRET) {
  console.error('TURN_SECRET must be set');
  process.exit(1);
}

const cors = {
  'access-control-allow-origin': ALLOW_ORIGIN,
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, cors).end('method not allowed');
    return;
  }

  const expiry = Math.floor(Date.now() / 1000) + TTL;
  const username = `${expiry}:${randomUUID().slice(0, 8)}`;
  const credential = createHmac('sha1', SECRET).update(username).digest('base64');

  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...cors,
  });
  res.end(
    JSON.stringify({
      username,
      credential,
      urls: URLS,
      iceServers: [{ urls: URLS, username, credential }],
      ttl: TTL,
      expiresAt: expiry,
    }),
  );
}).listen(PORT, () => console.error(`turn-auth listening on :${PORT}`));
