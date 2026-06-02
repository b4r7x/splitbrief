import { describe, it, expect, afterEach } from 'vitest';
import { MCP_PROTOCOL_VERSION } from './handlers.js';
import { normalizeHeader, startMcpServer } from './server.js';
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
    expect(wrong.length).toBe(TOKEN.length);
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
    expect(res.headers.get('allow')).toBe('POST');
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

describe('normalizeHeader', () => {
  it('returns undefined for undefined', () => {
    expect(normalizeHeader(undefined)).toBeUndefined();
  });

  it('returns the string for a string value', () => {
    expect(normalizeHeader('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('returns the first element for an array value', () => {
    expect(normalizeHeader(['http://localhost:3000', 'http://evil.com'])).toBe(
      'http://localhost:3000',
    );
  });

  it('returns undefined for an empty array', () => {
    expect(normalizeHeader([])).toBeUndefined();
  });
});

describe('Lifecycle', () => {
  it('close() resolves without hanging the process', async () => {
    const h = await startServer();
    await expect(h.close()).resolves.toBeUndefined();
    handle = null; // already closed, skip afterEach close
  });
});
