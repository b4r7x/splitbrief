import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMessage } from './handlers.js';
import { INVALID_REQUEST, SUPPORTED_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION } from './handlers.js';
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

// Local origins allowed for browser-initiated requests; missing = non-browser CLI client.
const LOCAL_ORIGIN_PREFIXES = [
  'http://localhost', 'https://localhost',
  'http://127.0.0.1', 'https://127.0.0.1',
];

function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  return LOCAL_ORIGIN_PREFIXES.some(p => origin === p || origin.startsWith(`${p}:`));
}

function negotiateProtocolVersion(clientHeader: string | string[] | undefined): string | null {
  if (clientHeader === undefined) return MCP_PROTOCOL_VERSION;
  if (typeof clientHeader === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(clientHeader)) {
    return clientHeader;
  }
  return null;
}

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

function send403(res: ServerResponse): void {
  res.writeHead(403);
  res.end();
}

function send405(res: ServerResponse): void {
  res.writeHead(405, { Allow: 'POST' });
  res.end();
}

function send500(res: ServerResponse): void {
  res.writeHead(500);
  res.end();
}

function sendProtocolVersionError(res: ServerResponse): void {
  res.writeHead(400, {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: INVALID_REQUEST,
      message: `Unsupported MCP-Protocol-Version. Supported versions: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(', ')}`,
    },
  }));
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

      // Origin validation: reject non-local browser origins
      const origin = req.headers['origin'] as string | undefined;
      if (!isLocalOrigin(origin)) {
        send403(res);
        return;
      }

      // Auth check for all other routes
      if (!isAuthorized(req, token)) {
        send401(res);
        return;
      }

      // GET /mcp — SSE not implemented; return 405 per Streamable HTTP spec
      if (req.method === 'GET' && req.url === '/mcp') {
        send405(res);
        return;
      }

      // POST /mcp
      if (req.method === 'POST' && req.url === '/mcp') {
        const clientVersion = req.headers['mcp-protocol-version'];
        const negotiatedVersion = negotiateProtocolVersion(clientVersion);
        if (negotiatedVersion === null) {
          sendProtocolVersionError(res);
          return;
        }

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
          // Accepted: server received the notification; no response body per JSON-RPC
          res.writeHead(202, { 'MCP-Protocol-Version': negotiatedVersion });
          res.end();
          return;
        }

        // kind === 'response' | 'error'
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': negotiatedVersion,
        });
        res.end(JSON.stringify(result.body));
        return;
      }

      res.writeHead(404);
      res.end();
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
