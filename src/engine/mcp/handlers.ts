import { z } from 'zod';
import type { McpResponse, McpError } from './types.js';
import type { McpResolver } from './resolver.js';
import type { McpToolHandler } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

// Current Streamable HTTP MCP version.
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION]);

export type HandleResult =
  | { kind: 'response'; body: McpResponse }
  | { kind: 'error'; body: McpError }
  | { kind: 'notification' };

const JsonRpcRecordSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .nullable()
  .transform((value) => value ?? {});

function jsonRpcError(code: number, message: string, id: string | number | null): McpError {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMessage(
  rawBody: string,
  resolver: McpResolver,
  serverVersion: string,
  toolHandler?: McpToolHandler,
): Promise<HandleResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { kind: 'error', body: jsonRpcError(PARSE_ERROR, 'Parse error', null) };
  }

  if (!isRecord(parsed)) {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  const msg = parsed;

  if (msg['jsonrpc'] !== '2.0') {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  if (typeof msg['method'] !== 'string') {
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  // Distinguish notifications (no id), valid requests (string/number id), and invalid ids.
  const hasId = 'id' in msg;
  const rawId = msg['id'];

  if (!hasId) {
    // JSON-RPC notification: server MUST NOT reply.
    return { kind: 'notification' };
  }

  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    // id present but invalid type (object, array, boolean, etc.).
    return { kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) };
  }

  const id = rawId;
  const method = msg['method'];
  const paramsResult = JsonRpcRecordSchema.safeParse(msg['params']);
  if (!paramsResult.success) {
    return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Invalid params', id) };
  }
  const params = paramsResult.data;

  if (method === 'initialize') {
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            resources: {},
            ...(toolHandler ? { tools: {} } : {}),
          },
          serverInfo: { name: 'diptych', version: serverVersion },
        },
      },
    };
  }

  if (method === 'resources/list') {
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
        result: { resources: await resolver.listResources() },
      },
    };
  }

  if (method === 'resources/read') {
    const uri = params['uri'];
    if (typeof uri !== 'string') {
      return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Missing uri', id) };
    }
    const content = await resolver.readResource(uri);
    if (content === null) {
      return { kind: 'error', body: jsonRpcError(-32002, 'Resource not found', id) };
    }
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
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

  if (method === 'tools/list') {
    if (!toolHandler) {
      return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Tools not available', id) };
    }
    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
        result: { tools: toolHandler.listTools() },
      },
    };
  }

  if (method === 'tools/call') {
    if (!toolHandler) {
      return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Tools not available', id) };
    }
    const name = params['name'];
    if (typeof name !== 'string') {
      return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Missing tool name', id) };
    }
    const toolArgsResult = JsonRpcRecordSchema.safeParse(params['arguments']);
    if (!toolArgsResult.success) {
      return { kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Invalid tool arguments', id) };
    }
    const toolArgs = toolArgsResult.data;

    const result = toolHandler.callTool(name, toolArgs);

    if (result.ok) {
      return {
        kind: 'response',
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: result.content }],
            isError: false,
          },
        },
      };
    }

    return {
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: result.error }],
          isError: true,
        },
      },
    };
  }

  return { kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Method not found', id) };
}
