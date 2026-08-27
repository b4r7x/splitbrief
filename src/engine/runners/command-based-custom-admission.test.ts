import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invokeCustomCommandBasedRunner } from './command-based.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import { admitCustomRunner } from './custom-launchability.js';
import {
  admittedCustomRunner,
  customRunner,
  executableReceipt,
} from '#testing/helpers/custom-command-based.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('invokeCustomCommandBasedRunner admission', () => {
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
      const result = await invokeCustomCommandBasedRunner({
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

  it('runs only the runner embedded in an admission bundle, not a competing root runner', async () => {
    await withTempDir('splitbrief custom admission bundle', async (projectDir) => {
      const admittedEffect = join(projectDir, 'admitted-runner-started');
      const competingEffect = join(projectDir, 'competing-runner-started');
      const admittedRunner = customRunner({
        argv: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(admittedEffect)}, 'admitted')`,
        ],
      });
      const competingRunner = customRunner({
        argv: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(competingEffect)}, 'competing')`,
        ],
      });
      const inputWithCompetingFields = {
        admission: await admittedCustomRunner(projectDir, admittedRunner),
        runner: competingRunner,
        executable: executableReceipt(),
        prompt: '',
        authorizationProjectDir: projectDir,
        cwd: projectDir,
        sourceEnv: {},
      };

      await expect(invokeCustomCommandBasedRunner(inputWithCompetingFields)).resolves.toMatchObject(
        {
          status: 'completed',
        },
      );
      expect(existsSync(admittedEffect)).toBe(true);
      expect(existsSync(competingEffect)).toBe(false);
    });
  });

  it('uses admitted literal argv in a child cwd distinct from its authorization project', async () => {
    await withTempDir(
      'splitbrief custom authorization project',
      async (authorizationProjectDir) => {
        await withTempDir('splitbrief custom child cwd', async (cwd) => {
          const result = await invokeCustomCommandBasedRunner({
            admission: await admittedCustomRunner(
              authorizationProjectDir,
              customRunner({ argv: ['-e', 'process.stdout.write(process.cwd())'] }),
            ),
            prompt: '',
            authorizationProjectDir,
            cwd,
            sourceEnv: {},
          });

          expect(result.text.trim()).toBe(realpathSync(cwd));
          expect(result.text).not.toContain(realpathSync(authorizationProjectDir));
        });
      },
    );
  });

  it('fails a token/authorization-project mismatch and malformed token before child spawn', async () => {
    await withTempDir('splitbrief custom admission project', async (authorizationProjectDir) => {
      await withTempDir('splitbrief custom mismatched project', async (otherProjectDir) => {
        const childEffect = join(authorizationProjectDir, 'should-not-start');
        const admission = await admittedCustomRunner(
          authorizationProjectDir,
          customRunner({
            argv: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(childEffect)}, 'started')`,
            ],
          }),
        );
        const malformedAdmission = JSON.parse('{"kind":"custom-runner-invocation"}');

        await expect(
          invokeCustomCommandBasedRunner({
            admission,
            prompt: '',
            authorizationProjectDir: otherProjectDir,
            cwd: authorizationProjectDir,
            sourceEnv: {},
          }),
        ).rejects.toMatchObject({ kind: 'custom-runner-admission-scope-mismatch' });
        await expect(
          invokeCustomCommandBasedRunner({
            admission: malformedAdmission,
            prompt: '',
            authorizationProjectDir,
            cwd: authorizationProjectDir,
            sourceEnv: {},
          }),
        ).rejects.toMatchObject({ kind: 'custom-runner-admission-invalid' });
        expect(existsSync(childEffect)).toBe(false);
      });
    });
  });

  it('rejects changed authorization-path resolution before a custom child can start', async () => {
    await withTempDir('splitbrief custom resolution project', async (authorizationProjectDir) => {
      const admittedBin = join(authorizationProjectDir, 'admitted-bin');
      const replacementBin = join(authorizationProjectDir, 'replacement-bin');
      const executableName = 'custom-runner';
      const admittedExecutable = join(admittedBin, executableName);
      const replacementExecutable = join(replacementBin, executableName);
      const admittedEffect = join(authorizationProjectDir, 'admitted-executable-started');
      const replacementEffect = join(authorizationProjectDir, 'replacement-executable-started');
      mkdirSync(admittedBin);
      mkdirSync(replacementBin);
      writeFileSync(
        admittedExecutable,
        `#!/bin/sh\nprintf admitted > ${JSON.stringify(admittedEffect)}\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        replacementExecutable,
        `#!/bin/sh\nprintf replacement > ${JSON.stringify(replacementEffect)}\n`,
        { mode: 0o755 },
      );
      chmodSync(admittedExecutable, 0o755);
      chmodSync(replacementExecutable, 0o755);
      const runner = customRunner({ executable: executableName });
      const admitted = await admitCustomRunner({
        projectDir: authorizationProjectDir,
        runner,
        posture: customRunnerSecurityPosture('implementer', 'output'),
        interaction: 'headless',
        grant: true,
        pathEnv: admittedBin,
        stateDir: join(authorizationProjectDir, 'state'),
      });
      expect(admitted).toMatchObject({ kind: 'admitted' });
      if (admitted.kind !== 'admitted') throw new Error('Custom runner was not admitted');

      await expect(
        invokeCustomCommandBasedRunner({
          admission: admitted.invocation,
          prompt: '',
          authorizationProjectDir,
          authorizationPathEnv: replacementBin,
          cwd: authorizationProjectDir,
          sourceEnv: {},
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-executable-resolution-drifted' });
      expect(existsSync(admittedEffect)).toBe(false);
      expect(existsSync(replacementEffect)).toBe(false);
    });
  });

  itUnix(
    'keeps absent authorization PATH empty instead of launching a source or ambient PATH candidate',
    async () => {
      await withTempDir('splitbrief custom absent authority', async (authorizationProjectDir) => {
        const binDir = join(authorizationProjectDir, 'bin');
        const executableName = 'custom-runner';
        const executablePath = join(binDir, executableName);
        const childEffect = join(authorizationProjectDir, 'ambient-path-child-started');
        mkdirSync(binDir);
        writeFileSync(
          executablePath,
          `#!/bin/sh\nprintf started > ${JSON.stringify(childEffect)}\n`,
          { mode: 0o755 },
        );
        chmodSync(executablePath, 0o755);
        const admitted = await admitCustomRunner({
          projectDir: authorizationProjectDir,
          runner: customRunner({ executable: executableName }),
          posture: customRunnerSecurityPosture('implementer', 'output'),
          interaction: 'headless',
          grant: true,
          pathEnv: binDir,
          stateDir: join(authorizationProjectDir, 'state'),
        });
        if (admitted.kind !== 'admitted') throw new Error('Custom runner was not admitted');
        const originalPath = process.env.PATH;

        try {
          process.env.PATH = binDir;
          await expect(
            invokeCustomCommandBasedRunner({
              admission: admitted.invocation,
              prompt: '',
              authorizationProjectDir,
              cwd: authorizationProjectDir,
              sourceEnv: { PATH: binDir },
            }),
          ).rejects.toMatchObject({ kind: 'custom-runner-executable-resolution-drifted' });
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }

        expect(existsSync(childEffect)).toBe(false);
      });
    },
  );

  it('rejects a replaced admitted executable before it can produce a child side effect', async () => {
    await withTempDir('splitbrief custom executable drift', async (projectDir) => {
      const executablePath = join(projectDir, 'custom-runner');
      const childEffect = join(projectDir, 'replacement-started');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const admission = await admittedCustomRunner(
        projectDir,
        customRunner({ executable: executablePath }),
        executableReceipt(executablePath),
      );

      writeFileSync(
        executablePath,
        `#!/bin/sh\nprintf replacement-started > ${JSON.stringify(childEffect)}\n`,
        { mode: 0o755 },
      );
      chmodSync(executablePath, 0o755);

      await expect(
        invokeCustomCommandBasedRunner({
          admission,
          prompt: '',
          authorizationProjectDir: projectDir,
          cwd: projectDir,
          sourceEnv: {},
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-executable-drifted' });
      expect(existsSync(childEffect)).toBe(false);
    });
  });
});
