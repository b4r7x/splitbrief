import { describe, it, expect } from 'vitest';
import {
  handleMessage,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  MCP_PROTOCOL_VERSION,
} from './handlers.js';
import type { McpResolver } from './resolver.js';
import type { McpResourceDescriptor, McpResourceContent } from './types.js';
import type { McpToolHandler } from './types.js';

const SERVER_VERSION = '1.2.3';

const stubResources: McpResourceDescriptor[] = [
  { uri: 'mcp://splitbrief/sessions', name: 'Sessions list', mimeType: 'application/json' },
];

const stubContent: McpResourceContent = {
  uri: 'mcp://splitbrief/sessions',
  mimeType: 'application/json',
  text: '[]',
};

const stubToolHandler: McpToolHandler = {
  listTools: () => [
    { name: 'report_evidence', description: 'Report evidence', inputSchema: { type: 'object' } },
  ],
  callTool: (name) => {
    if (name === 'report_evidence') return { ok: true, content: 'Evidence recorded' };
    return { ok: false, error: `Unknown tool: ${name}` };
  },
};

function makeResolver(overrides?: Partial<McpResolver>): McpResolver {
  return {
    listResources: async () => stubResources,
    readResource: async (uri: string) => (uri === stubContent.uri ? stubContent : null),
    ...overrides,
  };
}

function msg(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe('handleMessage', () => {
  it('initialize → correct capabilities, protocolVersion, serverInfo', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { resources: {} },
      serverInfo: { name: 'splitbrief', version: SERVER_VERSION },
    });
  });

  it('initialize accepts JSON-RPC id:null and echoes it in the response', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: null,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body.id).toBeNull();
    expect(result.body.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'splitbrief', version: SERVER_VERSION },
    });
  });

  it('notifications/initialized → { kind: notification } no body', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result).toEqual({ kind: 'notification' });
  });

  it('resources/list → returns resolver.listResources() wrapped in { resources }', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 2, method: 'resources/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body.result).toEqual({ resources: stubResources });
  });

  it('resources/read with valid URI → returns resolver content wrapped in { contents }', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: stubContent.uri } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as { contents: unknown[] };
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({
      uri: stubContent.uri,
      mimeType: stubContent.mimeType,
      text: stubContent.text,
    });
  });

  it('resources/read with unknown URI → resource-not-found error code -32002', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'mcp://splitbrief/unknown' },
      }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(-32002);
    expect(result.body.id).toBe(4);
  });

  it('resources/read with missing uri param → INVALID_PARAMS -32602', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: {} }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_PARAMS);
    expect(result.body.id).toBe(5);
  });

  it('tools/list → METHOD_NOT_FOUND when no handler', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 21, method: 'tools/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('tools/call → METHOD_NOT_FOUND when no handler', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'foo' } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('tools/list → returns tool definitions when handler present', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
      makeResolver(),
      SERVER_VERSION,
      stubToolHandler,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as { tools: unknown[] };
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]).toMatchObject({ name: 'report_evidence' });
  });

  it('tools/call with valid tool → success response', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'report_evidence', arguments: {} },
      }),
      makeResolver(),
      SERVER_VERSION,
      stubToolHandler,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(r.isError).toBe(false);
    expect(r.content).toEqual([{ type: 'text', text: 'Evidence recorded' }]);
  });

  it('tools/call with unknown tool → isError response', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: 'unknown', arguments: {} },
      }),
      makeResolver(),
      SERVER_VERSION,
      stubToolHandler,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as { isError: boolean };
    expect(r.isError).toBe(true);
  });

  it('tools/call without name param → INVALID_PARAMS', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: {} }),
      makeResolver(),
      SERVER_VERSION,
      stubToolHandler,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_PARAMS);
  });

  it('initialize advertises tools capability when handler present', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 25, method: 'initialize' }),
      makeResolver(),
      SERVER_VERSION,
      stubToolHandler,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as { capabilities: { tools?: object } };
    expect(r.capabilities.tools).toEqual({});
  });

  it('prompts/list → METHOD_NOT_FOUND', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 8, method: 'prompts/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('resources/subscribe → METHOD_NOT_FOUND', async () => {
    const result = await handleMessage(
      msg({
        jsonrpc: '2.0',
        id: 9,
        method: 'resources/subscribe',
        params: { uri: 'mcp://splitbrief/sessions' },
      }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('Malformed JSON body → PARSE_ERROR -32700', async () => {
    const result = await handleMessage('{ not valid json', makeResolver(), SERVER_VERSION);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(PARSE_ERROR);
    expect(result.body.id).toBeNull();
  });

  it('Missing jsonrpc field → INVALID_REQUEST -32600', async () => {
    const result = await handleMessage(
      msg({ id: 10, method: 'initialize' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
  });

  it('Missing method field with id → INVALID_REQUEST -32600', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id: 11 }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
  });

  it('Missing method field without id → INVALID_REQUEST -32600', async () => {
    const result = await handleMessage(msg({ jsonrpc: '2.0' }), makeResolver(), SERVER_VERSION);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
    expect(result.body.id).toBeNull();
  });

  it('notification without id (no id field) → kind notification, no response', async () => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', method: 'initialize', params: {} }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('notification');
  });

  it.each([
    { label: 'object id', id: { nested: true } },
    { label: 'boolean id', id: true },
    { label: 'array id', id: [] },
  ])('id present as $label → INVALID_REQUEST -32600', async ({ id }) => {
    const result = await handleMessage(
      msg({ jsonrpc: '2.0', id, method: 'initialize' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
  });
});
