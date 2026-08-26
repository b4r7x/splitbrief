import { describe, it, expect, afterEach } from 'vitest';
import { MCP_PROTOCOL_VERSION } from './handlers.js';
import { startMcpServer } from './server.js';
import type { McpServerHandle } from './server.js';
import type { McpResolver } from './resolver.js';

const stubResolver: McpResolver = {
  listResources: async () => [],
  readResource: async () => null,
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
    const json = (await res.json()) as Record<string, unknown>;
    expect(json['jsonrpc']).toBe('2.0');
    expect(json['id']).toBe(1);
    const result = json['result'] as Record<string, unknown>;
    expect(result).toBeDefined();
    expect((result['serverInfo'] as Record<string, unknown>)['version']).toBe(SERVER_VERSION);
  });

  it('returns 200 and preserves JSON-RPC id:null', async () => {
    const h = await startServer();
    const body = JSON.stringify({ jsonrpc: '2.0', id: null, method: 'initialize', params: {} });
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json['id']).toBeNull();
    expect(json['result']).toBeDefined();
  });

  it('returns 202 for notifications/initialized', async () => {
    const h = await startServer();
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns JSON-RPC invalid request for a no-id message without method', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: unknown; error?: { code: number } };
    expect(json.id).toBeNull();
    expect(json.error?.code).toBe(-32600);
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

  it('returns 401 for an equal-length but different token', async () => {
    const wrong = `X${TOKEN.slice(1)}`;
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${wrong}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('Routing — wrong method/path', () => {
  it('returns 405 with Allow: POST for GET /mcp', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
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
    let status: number | undefined;
    let failure: unknown;
    try {
      const res = await fetch(`${baseUrl(h.port)}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: largeBody,
      });
      status = res.status;
    } catch (err) {
      failure = err;
    }

    if (failure === undefined) {
      expect(status).toBe(413);
      return;
    }
    // The server may destroy the connection before the response is flushed;
    // only a premature close counts as the limit being enforced.
    const cause = failure instanceof Error ? failure.cause : undefined;
    expect(`${String(failure)} ${String(cause)}`).toMatch(
      /terminated|ECONNRESET|socket hang up|EPIPE/,
    );
  });
});

describe('Origin validation', () => {
  it('returns 403 when Origin header is a non-local domain', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin header is a non-local IP', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'http://192.168.1.1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin header is null', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'null',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts request without Origin for non-browser CLI clients', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts request with localhost Origin', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
  });

  it('accepts request with 127.0.0.1 Origin', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
  });

  it('returns CORS headers on successful local-origin POST', async () => {
    const h = await startServer();
    const origin = 'http://localhost:3000';
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('vary')).toBe('Origin');
  });
});

describe('OPTIONS /mcp preflight', () => {
  it('returns 204 with CORS allow headers before auth for local origins', async () => {
    const h = await startServer();
    const origin = 'http://127.0.0.1:5173';
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
  });
});

describe('MCP-Protocol-Version header', () => {
  it('response includes MCP-Protocol-Version header', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
  });

  it('keeps response header and initialize body on the current protocol version', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
    const json = (await res.json()) as { result?: { protocolVersion?: string } };
    expect(json.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('returns 400 JSON-RPC error when client sends an unknown version', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '1999-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
    const json = (await res.json()) as { id: unknown; error?: { code: number; message: string } };
    expect(json.id).toBeNull();
    expect(json.error?.code).toBe(-32600);
    expect(json.error?.message).toContain('Unsupported MCP-Protocol-Version');
  });

  it('notification response (202) also carries MCP-Protocol-Version header', async () => {
    const h = await startServer();
    const res = await fetch(`${baseUrl(h.port)}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe('Lifecycle', () => {
  it('close() resolves without hanging the process', async () => {
    const h = await startServer();
    await expect(h.close()).resolves.toBeUndefined();
    handle = null; // already closed, skip afterEach close
  });
});
