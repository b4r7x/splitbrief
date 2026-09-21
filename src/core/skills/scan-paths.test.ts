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

  it('project roots include .github/skills and .cursor/skills', () => {
    expect(PROJECT_SKILL_SCAN_PATHS).toContain('.github/skills');
    expect(PROJECT_SKILL_SCAN_PATHS).toContain('.cursor/skills');
    expect(PROJECT_SKILL_SCAN_PATHS).toContain('.commandcode/skills');
    expect(PROJECT_SKILL_SCAN_PATHS).toContain('.kilo/skills');
    expect(PROJECT_SKILL_SCAN_PATHS).toContain('.kilocode/skills');
  });

  it('global roots cover the command-code, kilo and cursor homes', () => {
    expect(GLOBAL_SKILL_SCAN_PATHS).toContain('.commandcode/skills');
    expect(GLOBAL_SKILL_SCAN_PATHS).toContain('.kilo/skills');
    expect(GLOBAL_SKILL_SCAN_PATHS).toContain('.config/kilo/skills');
    expect(GLOBAL_SKILL_SCAN_PATHS).toContain('.cursor/skills');
  });
});
