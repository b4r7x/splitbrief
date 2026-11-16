import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admittedCustomRunner,
  customRunner,
  invokeCustomRunner,
} from '#testing/helpers/custom-command-based.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

describe('custom command runner admission', () => {
  it('uses the exact receipt path with literal argv, stdin-only prompt, and an isolated environment', async () => {
    await withTempDir('splitbrief custom helper path', async (projectDir) => {
      const helperPath = join(projectDir, 'custom helper with spaces.js');
      writeFileSync(
        helperPath,
        [
          'const chunks = [];',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => chunks.push(chunk));',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(JSON.stringify({',
          '    argv: process.argv.slice(2),',
          '    prompt: chunks.join(""),',
          '    declared: process.env.CUSTOM_PUBLIC_VALUE,',
          '    ambient: process.env.UNDECLARED_AMBIENT,',
          '    path: process.env.PATH,',
          '    home: process.env.HOME,',
          '    loader: process.env.NODE_OPTIONS,',
          '  }) + "\\n");',
          '});',
        ].join('\n'),
      );
      const literalArg = 'literal argument; $(not-evaluated) & [brackets]';
      const prompt = 'stdin-only prompt; $(also-not-evaluated)';
      const result = await invokeCustomRunner({
        admission: await admittedCustomRunner(
          projectDir,
          customRunner({
            argv: [helperPath, literalArg],
            env: ['CUSTOM_PUBLIC_VALUE'],
          }),
        ),
        prompt,
        authorizationProjectDir: projectDir,
        cwd: projectDir,
        sourceEnv: {
          LANG: 'C.UTF-8',
          CUSTOM_PUBLIC_VALUE: 'custom-public-value-canary-94bf',
          UNDECLARED_AMBIENT: 'must-not-reach-child',
          PATH: '/host/bin',
          HOME: '/host/home',
          NODE_OPTIONS: '--require=/host/loader.js',
        },
      });

      expect(result.status).toBe('completed');
      expect(result.text).toContain(literalArg);
      expect(result.text).toContain(prompt);
      expect(result.text).not.toContain('custom-public-value-canary-94bf');
      expect(result.text).not.toContain('must-not-reach-child');
      expect(result.text).not.toContain('/host/bin');
      expect(result.text).not.toContain('/host/home');
      expect(result.text).not.toContain('/host/loader.js');
    });
  });
});
