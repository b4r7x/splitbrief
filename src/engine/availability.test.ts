import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCommandAvailability, createCommandExistsAvailability } from './availability.js';
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

  itUnix('uses a later executable alias when the primary alias is absent', async () => {
    const fallback = join(dir, 'fallback-cli');
    writeFileSync(fallback, '#!/bin/bash\n', 'utf8');
    chmodSync(fallback, 0o755);

    const availability = createCommandExistsAvailability([join(dir, 'primary-cli'), fallback]);

    expect(await availability.isAvailable()).toBe(true);
  });

  it('reports unavailable when no executable alias resolves', async () => {
    const availability = createCommandExistsAvailability([
      join(dir, 'primary-cli'),
      join(dir, 'fallback-cli'),
    ]);

    expect(await availability.isAvailable()).toBe(false);
  });
});

describe('createCommandAvailability', () => {
  itUnix('probe timeout and probe failure produce diagnostic reasons', async () => {
    const timeoutScript = join(dir, 'slow.sh');
    writeFileSync(timeoutScript, '#!/bin/bash\nsleep 5\n', 'utf8');
    chmodSync(timeoutScript, 0o755);
    const timeoutAvailability = createCommandAvailability(timeoutScript, { timeout: 100 });
    expect(await timeoutAvailability.isAvailable()).toBe(false);
    expect(timeoutAvailability.unavailabilityReason()).toMatch(/^probe timed out after \d+s$/);

    const failingScript = join(dir, 'failing.sh');
    writeFileSync(failingScript, '#!/bin/bash\necho boom >&2\nexit 3\n', 'utf8');
    chmodSync(failingScript, 0o755);
    const failingAvailability = createCommandAvailability(failingScript);
    expect(await failingAvailability.isAvailable()).toBe(false);
    expect(failingAvailability.unavailabilityReason()).toBe('probe failed: boom');
  });

  it('unavailabilityReason exposes the probe reason after isAvailable resolves', async () => {
    const availability = createCommandAvailability('nonexistent-command-that-does-not-exist-xyz');

    expect(availability.unavailabilityReason()).toBeUndefined();
    expect(await availability.isAvailable()).toBe(false);
    expect(availability.unavailabilityReason()).toBe('not installed');
  });

  itUnix('prefers the primary alias when more than one responds to --version', async () => {
    const primary = join(dir, 'primary-cli');
    const fallback = join(dir, 'fallback-cli');
    writeFileSync(primary, '#!/bin/bash\necho primary-cli 1.2.3\n', 'utf8');
    writeFileSync(fallback, '#!/bin/bash\necho fallback-cli 4.5.6\n', 'utf8');
    chmodSync(primary, 0o755);
    chmodSync(fallback, 0o755);

    const availability = createCommandAvailability([primary, fallback]);

    expect(await availability.isAvailable()).toBe(true);
    expect(await availability.getVersion()).toBe('1.2.3');
  });

  itUnix('uses a fallback alias only after the primary alias is absent', async () => {
    const fallback = join(dir, 'fallback-cli');
    writeFileSync(fallback, '#!/bin/bash\necho fallback-cli 4.5.6\n', 'utf8');
    chmodSync(fallback, 0o755);

    const availability = createCommandAvailability([join(dir, 'primary-cli'), fallback]);

    expect(await availability.isAvailable()).toBe(true);
    expect(await availability.getVersion()).toBe('4.5.6');
  });

  itUnix('does not switch aliases after the primary version probe fails', async () => {
    const primary = join(dir, 'primary-cli');
    const fallback = join(dir, 'fallback-cli');
    const fallbackMarker = join(dir, 'fallback-ran.txt');
    writeFileSync(primary, '#!/bin/bash\necho broken >&2\nexit 9\n', 'utf8');
    writeFileSync(
      fallback,
      `#!/bin/bash\ntouch '${fallbackMarker}'\necho fallback-cli 4.5.6\n`,
      'utf8',
    );
    chmodSync(primary, 0o755);
    chmodSync(fallback, 0o755);

    const availability = createCommandAvailability([primary, fallback]);

    expect(await availability.isAvailable()).toBe(false);
    expect(availability.unavailabilityReason()).toBe('probe failed: broken');
    expect(existsSync(fallbackMarker)).toBe(false);
  });

  it('reports the all-absent alias set as not installed', async () => {
    const availability = createCommandAvailability([
      join(dir, 'primary-cli'),
      join(dir, 'fallback-cli'),
    ]);

    expect(await availability.isAvailable()).toBe(false);
    expect(availability.unavailabilityReason()).toBe('not installed');
  });
});
