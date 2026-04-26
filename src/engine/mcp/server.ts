import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMessage } from './handlers.js';
import type { McpResolver } from './resolver.js';

export type McpServerConfig = {
  port: number;
  /** The host address to bind to. Host enforcement (e.g. 127.0.0.1 vs 0.0.0.0) is the caller's responsibility. */
  host: string;
  token: string;
  resolver: McpResolver;
  serverVersion: string;
};

export type McpServerHandle = {
  /** The actual bound port (useful when config.port was 0). */
  port: number;
  close(): Promise<void>;
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      totalSize += chunk.byteLength;
      if (totalSize > MAX_BODY_BYTES) {
        done = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', () => {
      if (done) return;
      done = true;
      resolve(null);
    });
  });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (!header) return false;
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  if (provided.length === 0) return false;
  return provided === token;
}

function send401(res: ServerResponse): void {
  res.writeHead(401);
  res.end();
}

function send404(res: ServerResponse): void {
  res.writeHead(404);
  res.end();
}

function send500(res: ServerResponse): void {
  res.writeHead(500);
  res.end();
}

export function startMcpServer(config: McpServerConfig): Promise<McpServerHandle> {
  const { port, host, token, resolver, serverVersion } = config;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Health check — no auth required
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      // Auth check for all other routes
      if (!isAuthorized(req, token)) {
        send401(res);
        return;
      }

      // POST /mcp
      if (req.method === 'POST' && req.url === '/mcp') {
        const body = await readBody(req, res);
        if (body === null) return; // 413 or error already sent

        let result: ReturnType<typeof handleMessage>;
        try {
          result = handleMessage(body, resolver, serverVersion);
        } catch {
          send500(res);
          return;
        }

        if (result.kind === 'notification') {
          res.writeHead(204);
          res.end();
          return;
        }

        // kind === 'response' | 'error'
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }

      send404(res);
    });

    server.on('error', reject);

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = addr !== null && typeof addr === 'object' ? addr.port : port;

      const handle: McpServerHandle = {
        port: actualPort,
        close(): Promise<void> {
          return new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          });
        },
      };

      resolve(handle);
    });
  });
}
