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

const SERVER_VERSION = '1.2.3';

const stubResources: McpResourceDescriptor[] = [
  { uri: 'mcp://diptych/sessions', name: 'Sessions list', mimeType: 'application/json' },
];

const stubContent: McpResourceContent = {
  uri: 'mcp://diptych/sessions',
  mimeType: 'application/json',
  text: '[]',
};

function makeResolver(overrides?: Partial<McpResolver>): McpResolver {
  return {
    listResources: () => stubResources,
    readResource: (uri: string) => (uri === stubContent.uri ? stubContent : null),
    ...overrides,
  };
}

function msg(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe('handleMessage', () => {
  it('initialize → correct capabilities, protocolVersion, serverInfo', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { resources: {} },
      serverInfo: { name: 'diptych', version: SERVER_VERSION },
    });
  });

  it('notifications/initialized → { kind: notification } no body', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result).toEqual({ kind: 'notification' });
  });

  it('resources/list → returns resolver.listResources() wrapped in { resources }', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 2, method: 'resources/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.body.result).toEqual({ resources: stubResources });
  });

  it('resources/read with valid URI → returns resolver content wrapped in { contents }', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: stubContent.uri } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    const r = result.body.result as { contents: unknown[] };
    expect(r.contents).toHaveLength(1);
    expect(r.contents[0]).toMatchObject({ uri: stubContent.uri, mimeType: stubContent.mimeType, text: stubContent.text });
  });

  it('resources/read with unknown URI → resource-not-found error code -32002', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'mcp://diptych/unknown' } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(-32002);
    expect(result.body.id).toBe(4);
  });

  it('resources/read with missing uri param → INVALID_PARAMS -32602', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: {} }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_PARAMS);
    expect(result.body.id).toBe(5);
  });

  it('tools/list → METHOD_NOT_FOUND -32601', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('tools/call → METHOD_NOT_FOUND', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'foo' } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('prompts/list → METHOD_NOT_FOUND', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 8, method: 'prompts/list' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('resources/subscribe → METHOD_NOT_FOUND', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 9, method: 'resources/subscribe', params: { uri: 'mcp://diptych/sessions' } }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(METHOD_NOT_FOUND);
  });

  it('Malformed JSON body → PARSE_ERROR -32700', () => {
    const result = handleMessage('{ not valid json', makeResolver(), SERVER_VERSION);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(PARSE_ERROR);
    expect(result.body.id).toBeNull();
  });

  it('Missing jsonrpc field → INVALID_REQUEST -32600', () => {
    const result = handleMessage(
      msg({ id: 10, method: 'initialize' }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
  });

  it('Missing method field → INVALID_REQUEST -32600', () => {
    const result = handleMessage(
      msg({ jsonrpc: '2.0', id: 11 }),
      makeResolver(),
      SERVER_VERSION,
    );
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.body.error.code).toBe(INVALID_REQUEST);
  });
});
