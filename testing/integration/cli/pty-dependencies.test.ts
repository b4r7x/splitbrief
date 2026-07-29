import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, '../../..');

describe('PTY dependency boundary', () => {
  it('keeps both entrypoint graphs inside CLI integration and production source', () => {
    const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, 'tsconfig.test.json');
    if (!configPath) throw new Error('tsconfig.test.json is unavailable');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error)
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectDir);
    const roots = [resolve(testDir, 'pty/child.ts'), resolve(testDir, 'pty/cli.ts')];
    const program = ts.createProgram({ rootNames: roots, options: parsed.options });
    const sources = program
      .getSourceFiles()
      .filter((source) => !source.isDeclarationFile)
      .map((source) => relative(projectDir, source.fileName).split(sep));
    const forbidden = sources.filter((parts) => {
      const testingIndex = parts.indexOf('testing');
      return testingIndex >= 0 && parts[testingIndex + 1] === 'visual';
    });

    expect(forbidden).toEqual([]);
    expect(
      sources.some((parts) => parts.join('/') === 'testing/integration/cli/pty/child.ts'),
    ).toBe(true);
    expect(
      sources.some((parts) => parts.join('/') === 'testing/integration/cli/pty/editor-child.ts'),
    ).toBe(true);
  });
});
