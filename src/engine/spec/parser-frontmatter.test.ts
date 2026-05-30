import { describe, it, expect } from 'vitest';
import { stripFileFrontmatter } from './parser.js';

describe('stripFileFrontmatter', () => {
  it('strips frontmatter containing generated_by', () => {
    const input = `---
generated_by: diptych v0.1.0
planner: claude-code
mode: standard
created_at: 2025-01-01T00:00:00.000Z
---
# Remaining content`;

    const result = stripFileFrontmatter(input);
    expect(result).toBe('# Remaining content');
  });

  it('returns original string when no frontmatter', () => {
    const input = '# Just a heading\nSome content';
    expect(stripFileFrontmatter(input)).toBe(input);
  });

  it('returns original string when frontmatter has no generated_by (task frontmatter)', () => {
    const input = `---
id: T001
title: "Create something"
action: create
file: src/index.ts
---

### Description
Do stuff.`;

    expect(stripFileFrontmatter(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(stripFileFrontmatter('')).toBe('');
  });

  it('strips frontmatter with Windows line endings', () => {
    const content = '---\r\ngenerated_by: diptych v0.1.0\r\n---\r\nactual content';
    expect(stripFileFrontmatter(content)).toBe('actual content');
  });
});
