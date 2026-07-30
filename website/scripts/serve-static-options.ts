import { isIP } from 'node:net';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const HOSTNAME_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

type ServeStaticEnvironment = {
  readonly HOST?: string;
  readonly PORT?: string;
};

function validHost(value: string): boolean {
  if (value === '' || value !== value.trim()) {
    return false;
  }
  if (isIP(value) !== 0) {
    return true;
  }

  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split('.').every((label) => HOSTNAME_LABEL.test(label))
  );
}

export function serveStaticOptions(environment: ServeStaticEnvironment = process.env): {
  readonly host: string;
  readonly port: number;
} {
  const host = environment.HOST ?? DEFAULT_HOST;
  if (!validHost(host)) {
    throw new Error('HOST must be an IP address or DNS hostname without a scheme or port.');
  }

  const rawPort = environment.PORT ?? String(DEFAULT_PORT);
  if (!/^[1-9]\d*$/.test(rawPort)) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }

  return { host, port };
}
