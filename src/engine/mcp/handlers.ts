import type { McpResponse, McpError } from './types.js';
import type { McpResolver } from './resolver.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export type HandleResult =
  | { kind: 'response'; body: McpResponse }
  | { kind: 'error'; body: McpError }
  | { kind: 'notification' };

function jsonRpcError(code: number, message: string, id: string | number | null): McpError {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleMessage(rawBody: string, resolver: McpResolver, serverVersion: string): HandleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: 'error', body: jsonRpcError(PARSE_ERROR, 'Parse error', null) };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  const msg = parsed as Record<string, unknown>;

  if (msg['jsonrpc'] !== '2.0') {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  const id = (typeof msg['id'] === 'string' || typeof msg['id'] === 'number') ? msg['id'] : null;

  if (typeof msg['method'] !== 'string') {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', id) };
  }

  const method = msg['method'];
  const params = (msg['params'] !== undefined && msg['params'] !== null && typeof msg['params'] === 'object')
    ? msg['params'] as Record<string, unknown>
    : {};

  if (method === 'initialize') {
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id: id as string | number,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { resources: {} },
          serverInfo: { name: 'diptych', version: serverVersion },
        },
      },
    };
  }

  if (method === 'notifications/initialized') {
    return { kind: 'notification' };
  }

  if (method === 'resources/list') {
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id: id as string | number,
        result: { resources: resolver.listResources() },
      },
    };
  }

  if (method === 'resources/read') {
    const uri = params['uri'];
    if (typeof uri !== 'string') {
      return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Missing uri', id) };
    }
    const content = resolver.readResource(uri);
    if (content === null) {
      return { kind: 'error', body: jsonRpcError(-32002, 'Resource not found', id) };
    }
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id: id as string | number,
        result: {
          contents: [
            {
              uri: content.uri,
              mimeType: content.mimeType,
              ...(content.text !== undefined ? { text: content.text } : {}),
              ...(content.blob !== undefined ? { blob: content.blob } : {}),
            },
          ],
        },
      },
    };
  }

  return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Method not found', id) };
}
