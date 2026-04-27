export type McpRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
};

export type McpError = {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

export type McpResourceDescriptor = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
};
