import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredRunner,
  createConfiguredCustomImplementer,
  createConfiguredImplementerFixtures,
  implement,
} from '#testing/helpers/configured-custom-implementer.js';
import { markCustomRunnerTrusted } from '../runners/custom/trust.js';
import { customRunnerSecurityPosture } from '../runners/custom/posture.js';
import { resolveCustomExecutable } from '../runners/cli-executable/custom.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const { temporaryDirectory, projectDirectory, runtimeHarness } =
  createConfiguredImplementerFixtures();

describe('createConfiguredCustomImplementer', () => {
  itUnix(
    'does not fall back to source or ambient PATH when the captured authorization PATH is absent',
    { timeout: 30_000 },
    async () => {
      const projectDir = projectDirectory('configured-implementer-empty-authorization-path');
      const temptingBin = temporaryDirectory('configured-implementer-empty-authorization-bin');
      const executableName = 'configured-implementer';
      const temptingExecutable = join(temptingBin, executableName);
      const childStarted = join(projectDir, 'tempting-child-started');
      const stageRequested = join(projectDir, 'unexpected-stage');
      writeFileSync(
        temptingExecutable,
        `#!/bin/sh\nprintf tempting > ${JSON.stringify(childStarted)}\n`,
      );
      chmodSync(temptingExecutable, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = [temptingBin, originalPath].filter(Boolean).join(delimiter);
      try {
        const harness = runtimeHarness(projectDir, {
          authorizationPathEnv: '',
          sourceEnv: { PATH: temptingBin },
          onCreateStage: () => writeFileSync(stageRequested, 'unexpected stage'),
        });
        await expect(
          createConfiguredCustomImplementer({
            runner: configuredRunner({ executable: executableName }),
            runtime: harness.runtime,
          }),
        ).rejects.toThrow('Custom runner admission denied');

        expect(harness.runtime.authorizationPathEnv).toBe('');
        expect(existsSync(childStarted)).toBe(false);
        expect(existsSync(stageRequested)).toBe(false);
        expect(existsSync(join(projectDir, 'src', 'path-absent.ts'))).toBe(false);
        expect(harness.stages).toEqual([]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  itUnix(
    'fails closed on authorization PATH drift before it starts either executable and cleans its stage',
    async () => {
      const projectDir = projectDirectory('configured-implementer-path-drift');
      const stateDir = temporaryDirectory('configured-implementer-path-state');
      const admittedBin = join(projectDir, 'admitted-bin');
      const replacementBin = join(projectDir, 'replacement-bin');
      const executableName = 'configured-implementer';
      const admittedExecutable = join(admittedBin, executableName);
      const replacementExecutable = join(replacementBin, executableName);
      const admittedStarted = join(projectDir, 'admitted-executable-started');
      const replacementStarted = join(projectDir, 'replacement-executable-started');
      const stageRequested = join(projectDir, 'stage-requested');
      mkdirSync(admittedBin);
      mkdirSync(replacementBin);
      writeFileSync(
        admittedExecutable,
        `#!/bin/sh\nprintf admitted > ${JSON.stringify(admittedStarted)}\n`,
      );
      writeFileSync(
        replacementExecutable,
        `#!/bin/sh\nprintf replacement > ${JSON.stringify(replacementStarted)}\n`,
      );
      chmodSync(admittedExecutable, 0o755);
      chmodSync(replacementExecutable, 0o755);
      const runner = configuredRunner({ executable: executableName });
      const posture = customRunnerSecurityPosture('implementer', 'output');
      const resolution = await resolveCustomExecutable({
        command: executableName,
        projectDir,
        pathEnv: admittedBin,
      });
      if (resolution.kind !== 'resolved')
        throw new Error('Admitted test executable did not resolve');
      const trusted = await markCustomRunnerTrusted({
        projectDir,
        stateDir,
        runner,
        posture,
        executable: resolution.executable,
      });
      if (trusted.kind !== 'trusted') throw new Error('Admitted test executable was not trusted');
      const harness = runtimeHarness(projectDir, {
        sourceEnv: {},
        authorizationPathEnv: admittedBin,
        admission: { interaction: 'headless', allowRepoRunners: false, stateDir },
        onCreateStage: () => writeFileSync(stageRequested, 'unexpected stage'),
      });
      const implementer = await createConfiguredCustomImplementer({
        runner,
        runtime: harness.runtime,
      });
      Object.defineProperty(harness.runtime, 'authorizationPathEnv', { value: replacementBin });

      const result = await implement(implementer, projectDir, { file: 'src/path-drift.ts' });

      expect(result.success).toBe(false);
      expect(existsSync(stageRequested)).toBe(true);
      expect(existsSync(admittedStarted)).toBe(false);
      expect(existsSync(replacementStarted)).toBe(false);
      expect(harness.stages).toHaveLength(1);
      expect(existsSync(harness.stages[0] ?? '')).toBe(false);
    },
  );

  itUnix(
    'uses authorization PATH instead of a competing source-env PATH to select the child executable',
    async () => {
      const projectDir = projectDirectory('configured-implementer-competing-path');
      const authorizationBin = join(projectDir, 'authorization-bin');
      const sourceEnvBin = join(projectDir, 'source-env-bin');
      const executableName = 'configured-implementer';
      const authorizationExecutable = join(authorizationBin, executableName);
      const sourceEnvExecutable = join(sourceEnvBin, executableName);
      const authorizationStarted = join(projectDir, 'authorization-executable-started');
      const sourceEnvStarted = join(projectDir, 'source-env-executable-started');
      mkdirSync(authorizationBin);
      mkdirSync(sourceEnvBin);
      writeFileSync(
        authorizationExecutable,
        [
          '#!/bin/sh',
          '/bin/cat >/dev/null',
          `printf authorized > ${JSON.stringify(authorizationStarted)}`,
          'printf \'```ts\\nexport const selectedExecutable = "authorization";\\n```\\n\'',
        ].join('\n'),
      );
      writeFileSync(
        sourceEnvExecutable,
        [
          '#!/bin/sh',
          '/bin/cat >/dev/null',
          `printf source-env > ${JSON.stringify(sourceEnvStarted)}`,
          'printf \'```ts\\nexport const selectedExecutable = "source-env";\\n```\\n\'',
        ].join('\n'),
      );
      chmodSync(authorizationExecutable, 0o755);
      chmodSync(sourceEnvExecutable, 0o755);
      const harness = runtimeHarness(projectDir, {
        authorizationPathEnv: authorizationBin,
        sourceEnv: { PATH: sourceEnvBin },
      });
      const implementer = await createConfiguredCustomImplementer({
        runner: configuredRunner({ executable: executableName }),
        runtime: harness.runtime,
      });

      const result = await implement(implementer, projectDir, { file: 'src/authority.ts' });

      expect(result.success).toBe(true);
      expect(readFileSync(join(projectDir, 'src', 'authority.ts'), 'utf8')).toContain(
        'selectedExecutable = "authorization"',
      );
      expect(existsSync(authorizationStarted)).toBe(true);
      expect(existsSync(sourceEnvStarted)).toBe(false);
    },
  );
});
