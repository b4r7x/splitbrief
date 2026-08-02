import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
const itUnix = process.platform === 'win32' ? it.skip : it;
import {
  createDefaultConfig,
  initConfig,
  loadConfig,
  writeConfig,
  writeConfigDocument,
} from './io.js';
import { SPLITBRIEF_DIR, TREES_DIR } from '../../paths.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';

const TMP = join(import.meta.dirname, '.tmp-config-io-safety');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config load safety', () => {
  describe('loadConfig', () => {
    itUnix('rejects initConfig when .splitbrief is a symlink', () => {
      const dir = createTempDir('config-symlink-init');
      const outside = createTempDir('config-symlink-init-outside');
      try {
        mkdirSync(join(outside, 'nested'), { recursive: true });
        symlinkSync(outside, join(dir, SPLITBRIEF_DIR));

        expect(() => initConfig(dir)).toThrow(/unsafe path|symlink/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    it('gitignores both the splitbrief dir and the worktree dir so neither leaks into git-status change detection', () => {
      const dir = createTempDir('config-init-gitignore');
      try {
        initConfig(dir);

        const ignored = readFileSync(join(dir, '.gitignore'), 'utf-8')
          .split('\n')
          .map((line) => line.trim());
        expect(ignored).toContain(`${SPLITBRIEF_DIR}/`);
        expect(ignored).toContain(`${TREES_DIR}/`);
      } finally {
        cleanupTempDir(dir);
      }
    });

    itUnix('keeps an external gitignore target unchanged when serializing config', () => {
      const dir = createTempDir('config-gitignore-serialize');
      const outside = createTempDir('config-gitignore-serialize-outside');
      const sentinel = join(outside, '.gitignore');
      try {
        writeFileSync(sentinel, 'external sentinel\n');
        symlinkSync(sentinel, join(dir, '.gitignore'));

        expect(() => writeConfig(dir, createDefaultConfig())).toThrow(
          /refusing to write through symlink/,
        );
        expect(readFileSync(sentinel, 'utf-8')).toBe('external sentinel\n');
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    it('preserves hand-edited config content while applying gitignore policy', () => {
      const dir = createTempDir('config-gitignore-document');
      const rawYaml = '# keep this note\nversion: 3\ncustom: retained\n';
      try {
        const written = writeConfigDocument(dir, rawYaml, [
          { path: ['workflow', 'mode'], value: 'quick' },
        ]);

        expect(written).toContain('# keep this note');
        expect(written).toContain('custom: retained');
        expect(written).toContain('mode: quick');
        expect(readFileSync(join(dir, SPLITBRIEF_DIR, 'config.yaml'), 'utf-8')).toBe(written);
        const ignored = readFileSync(join(dir, '.gitignore'), 'utf-8');
        expect(ignored).toContain(`${SPLITBRIEF_DIR}/`);
        expect(ignored).toContain(`${TREES_DIR}/`);
      } finally {
        cleanupTempDir(dir);
      }
    });

    itUnix(
      'keeps an external gitignore target unchanged when saving a hand-edited document',
      () => {
        const dir = createTempDir('config-gitignore-document-symlink');
        const outside = createTempDir('config-gitignore-document-symlink-outside');
        const sentinel = join(outside, '.gitignore');
        try {
          writeFileSync(sentinel, 'external sentinel\n');
          symlinkSync(sentinel, join(dir, '.gitignore'));

          expect(() => writeConfigDocument(dir, 'version: 3\n', [])).toThrow(
            /refusing to write through symlink/,
          );
          expect(readFileSync(sentinel, 'utf-8')).toBe('external sentinel\n');
        } finally {
          cleanupTempDir(outside);
          cleanupTempDir(dir);
        }
      },
    );

    itUnix('rejects writeConfig when .splitbrief is a symlink', () => {
      const dir = createTempDir('config-symlink-write');
      const outside = createTempDir('config-symlink-write-outside');
      try {
        mkdirSync(join(outside, 'nested'), { recursive: true });
        symlinkSync(outside, join(dir, SPLITBRIEF_DIR));

        expect(() => writeConfig(dir, createDefaultConfig())).toThrow(/unsafe path|symlink/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    itUnix('rejects reading config through final symlinks', () => {
      const dir = createTempDir('config-symlink-read');
      const outside = createTempDir('config-symlink-outside');
      try {
        mkdirSync(join(dir, SPLITBRIEF_DIR), { recursive: true });
        writeFileSync(join(outside, 'config.yaml'), 'version: 3\n');
        symlinkSync(join(outside, 'config.yaml'), join(dir, SPLITBRIEF_DIR, 'config.yaml'));

        expect(() => loadConfig(dir)).toThrow(/unsafe path/);
      } finally {
        cleanupTempDir(outside);
        cleanupTempDir(dir);
      }
    });

    it('throws instead of silently using defaults when an existing config cannot be read', () => {
      const dir = createTempDir('config-unreadable');
      try {
        const configDir = join(dir, SPLITBRIEF_DIR);
        mkdirSync(configDir, { recursive: true });
        mkdirSync(join(configDir, 'config.yaml'), { recursive: true });

        expect(() => loadConfig(dir)).toThrow(/could not be read/);
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('returns security warnings in the warnings array', () => {
      const dir = join(TMP, 'security-warn');
      const orig = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
      try {
        writeConfigYaml(dir, {
          planner: {
            kind: 'api',
            provider: 'anthropic',
            service: 'anthropic',
            offering: 'payg',
            api_base: 'https://api.anthropic.com/v1',
            model: 'm',
            api_key: 'sk-ant-test',
          },
        });

        const { warnings } = loadConfig(dir);
        expect(warnings.some((w) => w.includes('ANTHROPIC_API_KEY'))).toBe(true);
      } finally {
        if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = orig;
      }
    });

    it('returns no warnings when no api keys in config', () => {
      const dir = join(TMP, 'no-warn');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { model: 'codellama:13b' },
      });

      const { warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
    });

    it('throws when YAML parses to a primitive', () => {
      const dir = join(TMP, 'yaml-primitive');
      const configDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '42', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('throws when YAML parses to an array', () => {
      const dir = join(TMP, 'yaml-array');
      const configDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '- item1\n- item2', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('does not leak api-specific defaults into cli implementer (kind mismatch)', () => {
      const dir = join(TMP, 'kind-mismatch');
      writeConfigYaml(dir, {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5.4-mini',
          context_length: 32768,
          temperature: 0.3,
        },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.kind).toBe('cli');
      expect((config.implementer as Record<string, unknown>).provider).toBeUndefined();
      expect((config.implementer as Record<string, unknown>).apiBase).toBeUndefined();
    });

    it('does not leak ollama defaults into a different-provider implementer (model omitted)', () => {
      const dir = join(TMP, 'provider-mismatch');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'api', provider: 'openai' },
      });

      expect(() => loadConfig(dir)).toThrow(/implementer\.model/);
    });

    it('throws for an empty YAML file', () => {
      const dir = join(TMP, 'empty-yaml');
      const configDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), '', 'utf-8');

      expect(() => loadConfig(dir)).toThrow(/must be a YAML object/);
    });

    it('throws mentioning the missing field when shell implementer lacks command', () => {
      const dir = join(TMP, 'missing-command');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'shell', model: 'llama3' },
      });

      expect(() => loadConfig(dir)).toThrow(/implementer\.command/);
    });

    it('throws mentioning expected type when temperature is a string', () => {
      const dir = join(TMP, 'wrong-type-temperature');
      writeConfigYaml(dir, {
        version: 3,
        implementer: {
          kind: 'api',
          provider: 'ollama',
          model: 'llama3',
          api_base: 'http://localhost:11434/v1',
          temperature: 'hot',
        },
      });

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('implementer.temperature');
      expect(thrownMessage).toMatch(/number|type/i);
    });

    it('throws identifying invalid runner kind in the error message (v3 config)', () => {
      const dir = join(TMP, 'unknown-runner-kind');
      writeConfigYaml(dir, {
        version: 3,
        implementer: { kind: 'magic', model: 'llama3' },
      });

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('implementer.kind');
      expect(thrownMessage).toMatch(/invalid|expected|discriminator/i);
    });

    it('invalid YAML syntax error says "Malformed YAML" not a cryptic Zod path', () => {
      const dir = join(TMP, 'yaml-syntax-error');
      const configDir = join(dir, SPLITBRIEF_DIR);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), ':\n  bad: [unclosed', 'utf-8');

      let thrownMessage = '';
      try {
        loadConfig(dir);
      } catch (err) {
        thrownMessage = (err as Error).message;
      }
      expect(thrownMessage).toContain('Malformed YAML');
      expect(thrownMessage).not.toMatch(/path.*\..*\./);
    });
  });
});
