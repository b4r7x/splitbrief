// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { serveStaticOptions } from './serve-static-options.js';

describe('static-server environment', () => {
  it('uses the loopback defaults and accepts DNS, IPv4, and IPv6 hosts', () => {
    expect(serveStaticOptions({})).toEqual({ host: '127.0.0.1', port: 4173 });
    expect(serveStaticOptions({ HOST: 'localhost', PORT: '8080' })).toEqual({
      host: 'localhost',
      port: 8080,
    });
    expect(serveStaticOptions({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(serveStaticOptions({ HOST: '::1' }).host).toBe('::1');
  });

  it.each(['', '0', '-1', '1.5', '65536', 'not-a-port'])(
    'rejects invalid PORT=%s before binding',
    (port) => {
      expect(() => serveStaticOptions({ PORT: port })).toThrow(
        'PORT must be an integer from 1 through 65535.',
      );
    },
  );

  it.each([' http://localhost', 'http://localhost', 'host:4173', '-host', 'host-', 'bad host'])(
    'rejects invalid HOST=%s before binding',
    (host) => {
      expect(() => serveStaticOptions({ HOST: host })).toThrow(
        'HOST must be an IP address or DNS hostname without a scheme or port.',
      );
    },
  );
});
