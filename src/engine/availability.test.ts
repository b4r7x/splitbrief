import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCommandExistsAvailability } from './availability.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let dir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  dir = createTempDir('availability');
});

afterEach(() => {
  cleanupTempDir(dir);
});

describe('createCommandExistsAvailability', () => {
  itUnix('reports available for an executable script without running it', async () => {
    const marker = join(dir, 'ran.txt');
    const script = join(dir, 'planner.sh');
    writeFileSync(script, `#!/bin/bash\ntouch '${marker}'\n`, 'utf8');
    chmodSync(script, 0o755);

    const availability = createCommandExistsAvailability(script);

    expect(await availability.isAvailable()).toBe(true);
    expect(await availability.getVersion()).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  itUnix('reports unavailable for a non-executable file', async () => {
    const script = join(dir, 'planner.sh');
    writeFileSync(script, '#!/bin/bash\n', 'utf8');
    chmodSync(script, 0o644);

    const availability = createCommandExistsAvailability(script);

    expect(await availability.isAvailable()).toBe(false);
  });

  it('reports unavailable for a missing command path', async () => {
    const availability = createCommandExistsAvailability(join(dir, 'does-not-exist.sh'));

    expect(await availability.isAvailable()).toBe(false);
  });

  it('reports unavailable when no command is configured', async () => {
    const availability = createCommandExistsAvailability(undefined);

    expect(await availability.isAvailable()).toBe(false);
    expect(await availability.getVersion()).toBeNull();
  });

  itUnix('resolves a bare command name via PATH', async () => {
    const script = join(dir, 'mybin');
    writeFileSync(script, '#!/bin/bash\n', 'utf8');
    chmodSync(script, 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${dir}:${originalPath ?? ''}`;
    try {
      const availability = createCommandExistsAvailability('mybin');
      expect(await availability.isAvailable()).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });
});
