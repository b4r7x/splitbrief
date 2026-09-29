import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTargetWriteFixtures, startActor } from './target-write-fixtures.js';

/**
 * The named-options contract of the fixture actor. `startActor` used to take the
 * executable script and the diagnostic label as two interchangeable positional
 * strings (docs/CODE-STANDARD.md:111); these cases call it the only way the
 * process-lifecycle helper accepts its two responsibilities now.
 */
describe('startActor', () => {
  afterEach(() => {
    cleanupTargetWriteFixtures();
  });

  it('runs a named script through its ready and done contract', async () => {
    const actor = startActor({
      script: "process.stdout.write('fixture-actor-ready\\n');",
      label: 'named script actor',
    });

    await actor.ready;
    await expect(actor.done()).resolves.toBeUndefined();
  });

  it('fails through its label when the named script exits non-zero', async () => {
    const actor = startActor({
      script: "process.stdout.write('fixture-actor-ready\\n'); process.exit(3);",
      label: 'failing script actor',
    });

    await actor.ready;
    await expect(actor.done()).rejects.toThrow('failing script actor exited code=3');
  });
});
