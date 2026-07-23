import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeSpecFile,
  readSpecFile,
  buildSpecFrontmatter,
  getDiptychVersion,
  type SpecMetadata,
} from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

function makeTmp(): string {
  tmp = createTempDir('paths-io-frontmatter-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('buildSpecFrontmatter', () => {
  const fullMeta: SpecMetadata = {
    plannerTool: 'claude-code',
    plannerModel: 'opus-4',
    implementerTool: 'ollama',
    implementerModel: 'qwen3:32b',
    mode: 'standard',
  };

  it('includes all fields when provided', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    expect(fm).toContain('generated_by: diptych v');
    expect(fm).toContain('planner: claude-code (opus-4)');
    expect(fm).toContain('implementer: ollama (qwen3:32b)');
    expect(fm).toContain('mode: standard');
    expect(fm).toContain('created_at: ');
  });

  it('omits optional model fields when undefined', () => {
    const fm = buildSpecFrontmatter({
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      mode: 'quick',
    });
    expect(fm).toContain('planner: claude-code');
    expect(fm).not.toContain('planner: claude-code (');
    expect(fm).toContain('implementer: ollama');
    expect(fm).not.toContain('implementer: ollama (');
    expect(fm).toContain('mode: quick');
  });

  it('starts with --- and ends with ---', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm).toMatch(/\n---\n$/);
  });

  it('emits created_at as a valid ISO 8601 timestamp', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    const value = fm.match(/created_at: (.+)/)?.[1] ?? '';
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(value).toISOString()).toBe(value);
  });
});

describe('getDiptychVersion', () => {
  it('returns the version from the real package.json, not the 0.0.0 fallback', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    ) as { version: string };
    expect(getDiptychVersion()).toBe(pkg.version);
    expect(getDiptychVersion()).not.toBe('0.0.0');
  });
});

describe('writeSpecFile with metadata', () => {
  const meta: SpecMetadata = {
    plannerTool: 'claude-code',
    implementerTool: 'ollama',
    mode: 'standard',
  };

  it('prepends frontmatter to spec files when metadata is passed', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', '# My Spec', meta);
    const content = readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md');
    if (content === null) throw new Error('expected spec file to be present');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('generated_by: diptych v');
    expect(content).toContain('# My Spec');
  });

  it('does not prepend frontmatter to non-spec files', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'research.md', '# Research', meta);
    expect(readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'research.md')).toBe(
      '# Research',
    );
  });

  it('does not double-prepend when content already has frontmatter', () => {
    const dir = makeTmp();
    const existing = '---\ngenerated_by: diptych v0.1.0\n---\n# Spec with clarifications';
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', existing, meta);
    const content = readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md');
    if (content === null) throw new Error('expected spec file to be present');
    const fmCount = (content.match(/generated_by:/g) ?? []).length;
    expect(fmCount).toBe(1);
  });

  it('does not prepend when metadata is not passed', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', '# Plain Spec');
    expect(readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md')).toBe(
      '# Plain Spec',
    );
  });
});
