import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configPath } from '../../core/config/load/document.js';
import { writeConfig } from '../../core/config/load/io.js';
import { configStore } from '../../stores/project/config.js';
import { nextEntryReviewNone } from './entry-config.js';

const SEATS = {
  planner: { kind: 'agent', command: 'test-planner' },
  implementer: { kind: 'agent', command: 'test-implementer', model: 'test-model' },
} as const;
const seated = makeConfig(SEATS);
const none = makeConfig({ ...SEATS, reviewer: 'none' });

afterEach(resetAllStores);

describe('nextEntryReviewNone', () => {
  it('is true once REVIEW moved to None in the saved config', () => {
    configStore.__testReset({ projectDir: '/project', config: none });

    expect(nextEntryReviewNone({ configOfRun: seated, prepared: seated, state: undefined })).toBe(
      true,
    );
  });

  it('is false while the saved config keeps the seat of the run', () => {
    configStore.__testReset({ projectDir: '/project', config: seated });

    expect(nextEntryReviewNone({ configOfRun: seated, prepared: seated, state: undefined })).toBe(
      false,
    );
  });

  it('is false once REVIEW moved from None back to a seat', () => {
    configStore.__testReset({ projectDir: '/project', config: seated });

    expect(nextEntryReviewNone({ configOfRun: none, prepared: none, state: undefined })).toBe(
      false,
    );
  });

  it('reads the prepared config while no seat was saved', () => {
    configStore.__testReset({ projectDir: '/project', config: seated });

    expect(nextEntryReviewNone({ configOfRun: seated, prepared: none, state: undefined })).toBe(
      true,
    );
  });

  it('leaves a hand edit that does not load to the read after the answer', () => {
    const projectDir = createTempDir('entry-config');
    onTestFinished(() => cleanupTempDir(projectDir));
    writeConfig(projectDir, seated);
    configStore.load(projectDir);
    const loaded = configStore.get().config;
    if (loaded === null) throw new Error('expected the config to load');
    writeFileSync(configPath(projectDir), 'reviewer: [\n');

    expect(nextEntryReviewNone({ configOfRun: loaded, prepared: loaded, state: undefined })).toBe(
      false,
    );
  });
});
