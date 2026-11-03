import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach } from 'vitest';

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
// undici checks these limits on a coarse tick, so they fire after about one or two seconds.
const SHORT_LIMIT_MS = 100;

type Dispatcher = { destroy(): Promise<void> };
type DispatcherClass = new (
  options: Readonly<{ headersTimeout: number; bodyTimeout: number }>,
) => Dispatcher;

/**
 * Gives Node's global fetch header and body limits of a fraction of a second in place of its
 * 300 s defaults, for each test of the suite. The agent comes from the fetch Node ships, so a
 * request that names no dispatcher of its own meets these limits.
 */
export function shortenFetchLimits(): void {
  let original: unknown;
  let short: Dispatcher | undefined;
  beforeEach(async () => {
    await fetch('data:,');
    original = Reflect.get(globalThis, GLOBAL_DISPATCHER);
    const Agent = (original as { constructor: DispatcherClass }).constructor;
    short = new Agent({ headersTimeout: SHORT_LIMIT_MS, bodyTimeout: SHORT_LIMIT_MS });
    Reflect.set(globalThis, GLOBAL_DISPATCHER, short);
  });
  afterEach(async () => {
    Reflect.set(globalThis, GLOBAL_DISPATCHER, original);
    await short?.destroy();
  });
}

/**
 * Sends a plain fetch now and resolves when the global header (or body) limit has cut it: its
 * server sees the client close the connection. A request that went out earlier under the same
 * limits, and has waited at least as long, is cut no later than this one.
 */
export async function passFetchLimit(kind: 'headers' | 'body'): Promise<void> {
  let cut!: () => void;
  const connectionCut = new Promise<void>((resolve) => {
    cut = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.on('close', cut);
    if (kind === 'body') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const witness = fetch(`http://127.0.0.1:${port}/`).then(
    (response) => response.text(),
    () => undefined,
  );
  await connectionCut;
  await witness.catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
