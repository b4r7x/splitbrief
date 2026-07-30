import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { StaticFile } from './static-file.js';

const PLAIN_TEXT_TYPE = 'text/plain; charset=utf-8';
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': PLAIN_TEXT_TYPE,
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

export function staticContentType(options: {
  readonly filePath: string;
  readonly requestPath: string;
}): string {
  const extension = extname(options.filePath).toLowerCase();
  if (extension === '' && options.requestPath.startsWith('/api/')) {
    return 'application/json; charset=utf-8';
  }

  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

function sendResponse(options: {
  readonly body: Buffer | undefined;
  readonly contentLength: number;
  readonly response: ServerResponse;
  readonly status: number;
  readonly type: string;
}): void {
  options.response.writeHead(options.status, {
    'Content-Length': options.contentLength,
    'Content-Type': options.type,
  });
  options.response.end(options.body);
}

export function sendText(options: {
  readonly headOnly: boolean;
  readonly response: ServerResponse;
  readonly status: number;
  readonly text: string;
}): void {
  const body = Buffer.from(options.text);
  sendResponse({
    body: options.headOnly ? undefined : body,
    contentLength: body.byteLength,
    response: options.response,
    status: options.status,
    type: PLAIN_TEXT_TYPE,
  });
}

export async function sendStaticFile(options: {
  readonly file: StaticFile;
  readonly headOnly: boolean;
  readonly response: ServerResponse;
  readonly status: number;
  readonly type: string;
}): Promise<void> {
  const body = options.headOnly ? undefined : await readFile(options.file.path);
  sendResponse({
    body,
    contentLength: options.file.size,
    response: options.response,
    status: options.status,
    type: options.type,
  });
}
