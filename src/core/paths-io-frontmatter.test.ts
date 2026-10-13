import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeSpecFile,
  readSpecFile,
  buildSpecFrontmatter,
  getSplitbriefVersion,
  type SpecMetadata,
} from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { formatSeatIdentity } from './crew/identity.js';
import { specMetadataOf } from './providers/seat-identity.js';
import { extractFrontmatter } from '../utils/frontmatter.js';

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
    planner: { tool: 'claude-code', model: 'opus-4' },
    implementer: { tool: 'ollama', model: 'qwen3:32b' },
  };

  it('matches the configured seat identities and keeps OpenCode routes distinct', () => {
    const routes = ['deepseek/deepseek-flash', 'opencode-go/deepseek-v4.1-flash'];
    const identities = routes.map((model) => {
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
        implementer: { kind: 'cli', tool: 'opencode', model, variant: 'high' },
      });
      const fm = buildSpecFrontmatter(specMetadataOf(config));
      const planner = formatSeatIdentity({ seat: config.planner });
      const implementer = formatSeatIdentity({
        seat: config.implementer,
        displayName: 'DeepSeek V4.1 Flash',
      });
      expect(fm.split('\n')).toContain(`planner: ${planner}`);
      expect(fm.split('\n')).toContain(`implementer: ${implementer}`);
      expect(extractFrontmatter(fm).frontmatter).toMatchObject({ planner, implementer });
      return implementer;
    });
    expect(new Set(identities).size).toBe(routes.length);
  });

  it('includes all fields when provided', () => {
    const fm = buildSpecFrontmatter(fullMeta);
    expect(fm).toContain('generated_by: splitbrief v');
    expect(fm).toContain('planner: Claude Code CLI · Opus 4');
    expect(fm).toContain('implementer: Ollama · Qwen3 32B');
    expect(fm).not.toContain('mode:');
    expect(fm).toContain('created_at: ');
  });

  it('keeps YAML punctuation in custom seat identities readable', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'team: planner',
        model: 'model #1',
        apiBase: 'http://localhost:11434/v1',
      },
      implementer: { kind: 'shell', command: 'worker', model: 'model #2' },
    });
    const fm = buildSpecFrontmatter(specMetadataOf(config));
    expect(extractFrontmatter(fm).frontmatter).toMatchObject({
      planner: formatSeatIdentity({ seat: config.planner }),
      implementer: formatSeatIdentity({ seat: config.implementer }),
    });
  });

  it('uses the automatic model word when no model is configured', () => {
    const fm = buildSpecFrontmatter({
      planner: { tool: 'claude-code' },
      implementer: { tool: 'ollama' },
    });
    expect(fm.split('\n')).toContain('planner: Claude Code CLI · auto');
    expect(fm.split('\n')).toContain('implementer: Ollama · auto');
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

describe('getSplitbriefVersion', () => {
  it('returns the version from the real package.json, not the 0.0.0 fallback', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    ) as { version: string };
    expect(getSplitbriefVersion()).toBe(pkg.version);
    expect(getSplitbriefVersion()).not.toBe('0.0.0');
  });
});

describe('writeSpecFile with metadata', () => {
  const meta: SpecMetadata = {
    planner: { tool: 'claude-code' },
    implementer: { tool: 'ollama' },
  };

  it('prepends frontmatter to spec files when metadata is passed', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', '# My Spec', meta);
    const content = readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md');
    if (content === null) throw new Error('expected spec file to be present');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('generated_by: splitbrief v');
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
    const existing = '---\ngenerated_by: splitbrief v0.1.0\n---\n# Spec with clarifications';
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
