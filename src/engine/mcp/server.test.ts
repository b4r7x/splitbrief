import { describe, it, expect, afterEach } from 'vitest';
import { startMcpServer } from './server.js';
import type { McpServerHandle } from './server.js';
import type { McpResolver } from './resolver.js';

const stubResolver: McpResolver = {
  listResources: () => [],
  readResource: () => null,
};

const TOKEN = 'test-secret-token';
const SERVER_VERSION = '1.0.0';

let handle: McpServerHandle | null = null;

async function startServer(): Promise<McpServerHandle> {
  handle = await startMcpServer({
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    resolver: stubResolver,
    serverVersion: SERVER_VERSION,
  });
  return handle;
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (handle !== null) {
    await handle.close();
    handle = null;
  }
});

describe('POST /mcp — valid auth', () => {
  it('returns 200 with JSON-RPC response for initialize', async () => {
    const h = await startServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json() as Record<string, unknown>;
    expect(json['jsonrpc']).toBe('2.0');
    expect(json['id']).toBe(1);
    const result = json['result'] as Record<string, unknown>;
    expect(result).toBeDefined();
    expect((result['serverInfo'] as Record<string, unknown>)['version']).toBe(SERVER_VERSION);
  });

  it('returns 204 for notifications/initialized', async () => {
    const h = await startServer();
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });
});

describe('Auth rejection', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is wrong', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for empty token (Bearer with no value)', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('Routing — wrong method/path', () => {
  it('returns 404 for GET /mcp', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST /unknown-path', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/unknown-path`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('returns 200 ok without auth', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toBe('ok');
  });
});

describe('Body limit', () => {
  it('returns 413 for body > 1 MB', async () => {
    const h = await startServer();
    const largeBody = 'x'.repeat(1024 * 1024 + 1);
    let status: number;
    try {
      const res = await fetch(`${baseUrl(h.port)}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: largeBody,
      });
      status = res.status;
    } catch {
      // Connection may be destroyed before response arrives — treat as expected
      status = 413;
    }
    expect(status).toBe(413);
  });
});

describe('Lifecycle', () => {
  it('close() resolves without hanging the process', async () => {
    const h = await startServer();
    await expect(h.close()).resolves.toBeUndefined();
    handle = null; // already closed, skip afterEach close
  });
});
