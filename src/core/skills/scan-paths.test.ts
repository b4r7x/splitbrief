import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SKILL_SCAN_PATH_LABELS,
  GLOBAL_SKILL_SCAN_PATHS,
  PROJECT_SKILL_SCAN_PATH_LABELS,
  PROJECT_SKILL_SCAN_PATHS,
} from './scan-paths.js';

describe('skill scan path labels', () => {
  it('anchors project labels at ./ and global labels at ~/, one per scanned root', () => {
    expect(PROJECT_SKILL_SCAN_PATH_LABELS).toEqual(PROJECT_SKILL_SCAN_PATHS.map((p) => `./${p}`));
    expect(GLOBAL_SKILL_SCAN_PATH_LABELS).toEqual(GLOBAL_SKILL_SCAN_PATHS.map((p) => `~/${p}`));
  });
});
