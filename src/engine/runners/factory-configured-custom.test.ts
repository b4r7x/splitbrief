import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import { ConfigSchema, type Config } from '../../core/schemas/config.js';
import {
  beginDeclaredArtifactReview,
  cleanupStaleArtifactReviews,
} from '../orchestrator/approval/planner-artifact.js';
import { createStagedProject } from '../orchestrator/approval/staged-project.js';
import { defaultContext, makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resolveCustomRunnerTrustFile } from './custom-trust.js';
import { createImplementer, createPlanner } from './factory.js';
import type { CustomRunnerRuntimePort } from './types.js';

type CustomRunnerRole = 'planner' | 'implementer';
type CustomCommandContract = 'output' | 'direct';

const configuredRoutes = [
  ['planner', 'output'],
  ['planner', 'direct'],
  ['implementer', 'output'],
  ['implementer', 'direct'],
] as const;

describe('configured custom runner factory behavior', () => {
  const fixtureDirs: string[] = [];
  let sourceSequence = 0;

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  type FactoryBehaviorFixture = Readonly<{
    projectDir: string;
    stateDir: string;
    configuredMarker: string;
    legacyMarker: string;
    sourceName: string;
    sourceValue: string;
  }>;

  type FactoryBehaviorConfigInput = Readonly<{
    role: CustomRunnerRole;
    contract: CustomCommandContract;
    program: string;
    legacyProgram: string;
    sourceName: string;
  }>;

  type ChildObservation = Readonly<{
    source: string;
    cwd: string;
  }>;

  function fixtureDir(prefix: string): string {
    const dir = createTempDir(prefix);
    fixtureDirs.push(dir);
    return dir;
  }

  function createFixture(label: string): FactoryBehaviorFixture {
    const projectDir = fixtureDir(`factory-r7-${label}-project`);
    const stateDir = fixtureDir(`factory-r7-${label}-state`);
    const observationDir = fixtureDir(`factory-r7-${label}-observation`);
    sourceSequence += 1;
    const sourceName = `FACTORY_R7_SOURCE_${process.pid}_${sourceSequence}`;

    createTestGitRepo(projectDir, { 'src/existing.ts': 'export const existing = true;\n' });

    return {
      projectDir,
      stateDir,
      configuredMarker: join(observationDir, 'configured-child-ran'),
      legacyMarker: join(observationDir, 'legacy-child-ran'),
      sourceName,
      sourceValue: `factory-r7-source-${sourceSequence}`,
    };
  }

  function configuredFactoryBehaviorConfig(input: FactoryBehaviorConfigInput): Config {
    const id = `factory-r7-${input.role}-${input.contract}`;
    const runner = {
      kind: input.contract === 'output' ? 'shell' : 'agent',
      command: process.execPath,
      args: ['-e', input.program],
      outputFormat: 'text' as const,
      idleWarnMs: 300_000,
      idleKillMs: 1_800_000,
      env: [input.sourceName],
    };
    const customCommands = {
      [id]: {
        label: `Factory R7 ${input.role} ${input.contract}`,
        contract: input.contract,
        executable: process.execPath,
        argv: ['-e', input.program],
        outputFormat: 'text' as const,
        idleWarnMs: 300_000,
        idleKillMs: 1_800_000,
        env: [input.sourceName],
      },
    };

    if (input.role === 'planner') {
      return ConfigSchema.parse({ ...makeConfig(), planner: runner, customCommands });
    }

    return ConfigSchema.parse({
      ...makeConfig(),
      implementer: {
        kind: input.contract === 'output' ? 'agent' : 'shell',
        command: process.execPath,
        args: ['-e', input.legacyProgram],
        outputFormat: 'text',
        model: 'legacy-fallback',
      },
      implementerProfiles: {
        default: 'factory-r7',
        profiles: {
          'factory-r7': { ...runner, model: 'configured-custom' },
        },
      },
      customCommands,
    });
  }

  function factoryRuntime(
    fixture: FactoryBehaviorFixture,
    interaction: 'interactive' | 'headless',
  ): CustomRunnerRuntimePort {
    const sessionId = 'factory-r7-session';
    return {
      sessionId,
      authorizationProjectDir: fixture.projectDir,
      sourceEnv: { [fixture.sourceName]: fixture.sourceValue },
      authorizationPathEnv: process.env.PATH ?? '',
      ...(process.env.PATHEXT === undefined ? {} : { authorizationPathExt: process.env.PATHEXT }),
      admission:
        interaction === 'interactive'
          ? {
              interaction,
              allowRepoRunners: false,
              stateDir: fixture.stateDir,
              onTieredApproval: async () => ({
                decision: 'confirm',
                phrase: CONFIRM_PHRASE,
                reason: 'Exercise the configured factory route.',
              }),
            }
          : {
              interaction,
              allowRepoRunners: false,
              stateDir: fixture.stateDir,
            },
      createStage: async (sourceProjectDir) => createStagedProject(sourceProjectDir),
      cleanupStaleArtifactReviews: () =>
        cleanupStaleArtifactReviews({ projectDir: fixture.projectDir, sessionId }),
      beginDeclaredArtifactReview: (input) =>
        beginDeclaredArtifactReview({
          ...input,
          projectDir: fixture.projectDir,
          sessionId,
          onApprovalNeeded: async () => ({ approved: true }),
        }),
    };
  }

  function observationProgram(input: {
    marker: string;
    sourceName: string;
    writeDeclaredArtifact?: boolean;
    writeStageOnly?: boolean;
  }): string {
    return [
      "const fs = require('node:fs');",
      `const source = process.env[${JSON.stringify(input.sourceName)}] ?? 'missing';`,
      'const observation = JSON.stringify({ source, cwd: process.cwd() });',
      "const declaredArtifact = JSON.stringify({ result: 'declared', cwd: process.cwd() });",
      `fs.writeFileSync(${JSON.stringify(input.marker)}, observation);`,
      ...(input.writeStageOnly === false
        ? []
        : ["fs.writeFileSync('stage-only.txt', 'discarded');"]),
      ...(input.writeDeclaredArtifact
        ? [
            "fs.mkdirSync('.splitbrief-runner/output', { recursive: true });",
            "fs.writeFileSync('.splitbrief-runner/output/result', declaredArtifact);",
            "process.stdout.write('diagnostic only');",
          ]
        : ['process.stdout.write(observation);']),
    ].join('\n');
  }

  function parseObservation(text: string): ChildObservation {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('source' in parsed) ||
      !('cwd' in parsed) ||
      typeof parsed.source !== 'string' ||
      typeof parsed.cwd !== 'string'
    ) {
      throw new Error('Configured child did not return a valid observation.');
    }
    return { source: parsed.source, cwd: parsed.cwd };
  }

  function exportedString(source: string, name: string): string {
    const prefix = `export const ${name} = `;
    const start = source.indexOf(prefix);
    const end = source.indexOf(';', start);
    if (start < 0 || end < 0) {
      throw new Error(`Expected exported ${name} string in child output.`);
    }
    const value: unknown = JSON.parse(source.slice(start + prefix.length, end));
    if (typeof value !== 'string') {
      throw new Error(`Expected exported ${name} to be a string.`);
    }
    return value;
  }

  function expectStableReceipt(fixture: FactoryBehaviorFixture, definitionId: string): void {
    const trustFile = resolveCustomRunnerTrustFile(fixture.stateDir);
    expect(existsSync(trustFile)).toBe(true);
    expect(JSON.parse(readFileSync(trustFile, 'utf8'))).toEqual({
      version: 1,
      receipts: [expect.objectContaining({ definitionId })],
    });
  }

  function expectDiscardedChildStage(
    fixture: FactoryBehaviorFixture,
    observation: ChildObservation,
  ): void {
    expect(observation.source).toBe(fixture.sourceValue);
    expect(observation.cwd).not.toBe(fixture.projectDir);
    expect(existsSync(observation.cwd)).toBe(false);
    expect(existsSync(join(fixture.projectDir, 'stage-only.txt'))).toBe(false);
  }

  it('runs a configured planner output child through the public factory', async () => {
    const fixture = createFixture('planner-output');
    const config = configuredFactoryBehaviorConfig({
      role: 'planner',
      contract: 'output',
      sourceName: fixture.sourceName,
      program: observationProgram({
        marker: fixture.configuredMarker,
        sourceName: fixture.sourceName,
      }),
      legacyProgram: `require('node:fs').writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
    });

    const planner = await createPlanner(config, undefined, {
      customRuntime: factoryRuntime(fixture, 'interactive'),
    });
    const result = await planner.review('review the fixture', fixture.projectDir, {
      onOutput: () => {},
    });
    const observation = parseObservation(readFileSync(fixture.configuredMarker, 'utf8'));

    expect(existsSync(fixture.configuredMarker)).toBe(true);
    expect(existsSync(fixture.legacyMarker)).toBe(false);
    expect(result.text).toContain('***REDACTED***');
    expectDiscardedChildStage(fixture, observation);
    expectStableReceipt(fixture, 'factory-r7-planner-output');
  });

  it('runs a configured planner direct child through the public factory', async () => {
    const fixture = createFixture('planner-direct');
    const config = configuredFactoryBehaviorConfig({
      role: 'planner',
      contract: 'direct',
      sourceName: fixture.sourceName,
      program: observationProgram({
        marker: fixture.configuredMarker,
        sourceName: fixture.sourceName,
        writeDeclaredArtifact: true,
        writeStageOnly: false,
      }),
      legacyProgram: `require('node:fs').writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
    });

    const planner = await createPlanner(config, undefined, {
      customRuntime: factoryRuntime(fixture, 'interactive'),
    });
    const result = await planner.review('review the fixture', fixture.projectDir, {
      onOutput: () => {},
    });
    const observation = parseObservation(readFileSync(fixture.configuredMarker, 'utf8'));

    expect(existsSync(fixture.configuredMarker)).toBe(true);
    expect(existsSync(fixture.legacyMarker)).toBe(false);
    expect(result.text).toContain('"result":"declared"');
    expect(result.text).toContain(observation.cwd);
    expect(result.text).not.toContain('diagnostic only');
    expectDiscardedChildStage(fixture, observation);
    expect(existsSync(join(fixture.projectDir, '.splitbrief-runner'))).toBe(false);
    expectStableReceipt(fixture, 'factory-r7-planner-direct');
  });

  it('runs a configured implementer output child through the public factory', async () => {
    const fixture = createFixture('implementer-output');
    const config = configuredFactoryBehaviorConfig({
      role: 'implementer',
      contract: 'output',
      sourceName: fixture.sourceName,
      program: [
        "const fs = require('node:fs');",
        `const source = process.env[${JSON.stringify(fixture.sourceName)}] ?? 'missing';`,
        'const observation = JSON.stringify({ source, cwd: process.cwd() });',
        `fs.writeFileSync(${JSON.stringify(fixture.configuredMarker)}, observation);`,
        "fs.writeFileSync('stage-only.txt', 'discarded');",
        "process.stdout.write('```ts\\nexport const source = ' + JSON.stringify(source) + ';\\nexport const childCwd = ' + JSON.stringify(process.cwd()) + ';\\n```\\n');",
      ].join('\n'),
      legacyProgram: `require('node:fs').writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
    });
    const task = makeTask({ file: 'src/factory-output.ts' });

    const implementer = await createImplementer(config, {
      customRuntime: factoryRuntime(fixture, 'interactive'),
    });
    const result = await implementer.implement({
      task,
      projectDir: fixture.projectDir,
      config,
      context: { ...defaultContext, dir: fixture.projectDir },
      onOutput: () => {},
    });
    const observation = parseObservation(readFileSync(fixture.configuredMarker, 'utf8'));
    const target = readFileSync(join(fixture.projectDir, task.file), 'utf8');

    expect(result.success).toBe(true);
    expect(result.output).toContain('***REDACTED***');
    expect(existsSync(fixture.configuredMarker)).toBe(true);
    expect(existsSync(fixture.legacyMarker)).toBe(false);
    expectDiscardedChildStage(fixture, observation);
    expect(exportedString(target, 'source')).toBe('***REDACTED***');
    expect(exportedString(target, 'childCwd')).toBe(observation.cwd);
    expect(implementer.capabilities).toEqual({ writesFiles: 'extracted-code' });
    expectStableReceipt(fixture, 'factory-r7-implementer-output');
  });

  it('runs a configured implementer direct child through the public factory', async () => {
    const fixture = createFixture('implementer-direct');
    const config = configuredFactoryBehaviorConfig({
      role: 'implementer',
      contract: 'direct',
      sourceName: fixture.sourceName,
      program: [
        "const fs = require('node:fs');",
        `const source = process.env[${JSON.stringify(fixture.sourceName)}] ?? 'missing';`,
        'const observation = JSON.stringify({ source, cwd: process.cwd() });',
        `fs.writeFileSync(${JSON.stringify(fixture.configuredMarker)}, observation);`,
        "fs.mkdirSync('src', { recursive: true });",
        "fs.writeFileSync('src/factory-direct.ts', 'export const source = ' + JSON.stringify(source) + ';\\nexport const childCwd = ' + JSON.stringify(process.cwd()) + ';\\n');",
      ].join('\n'),
      legacyProgram: `require('node:fs').writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
    });
    const task = makeTask({ file: 'src/factory-direct.ts' });
    const outerStage = await createStagedProject(fixture.projectDir);

    try {
      const implementer = await createImplementer(config, {
        customRuntime: factoryRuntime(fixture, 'interactive'),
      });
      const result = await implementer.implement({
        task,
        projectDir: outerStage.projectDir,
        config,
        context: { ...defaultContext, dir: outerStage.projectDir },
        onOutput: () => {},
      });
      const observation = parseObservation(readFileSync(fixture.configuredMarker, 'utf8'));
      const target = readFileSync(join(outerStage.projectDir, task.file), 'utf8');

      expect(result.success).toBe(true);
      expect(existsSync(fixture.configuredMarker)).toBe(true);
      expect(existsSync(fixture.legacyMarker)).toBe(false);
      expect(observation.source).toBe(fixture.sourceValue);
      expect(realpathSync(observation.cwd)).toBe(realpathSync(outerStage.projectDir));
      expect(existsSync(join(fixture.projectDir, task.file))).toBe(false);
      expect(exportedString(target, 'source')).toBe(fixture.sourceValue);
      expect(exportedString(target, 'childCwd')).toBe(observation.cwd);
      expect(implementer.capabilities).toEqual({ writesFiles: 'direct' });
      expectStableReceipt(fixture, 'factory-r7-implementer-direct');
    } finally {
      outerStage.cleanup();
    }
  });

  it.each(
    configuredRoutes,
  )('denies a configured %s %s child before it can start or fall back', async (role, contract) => {
    const fixture = createFixture(`denied-${role}-${contract}`);
    const config = configuredFactoryBehaviorConfig({
      role,
      contract,
      sourceName: fixture.sourceName,
      program: [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(fixture.configuredMarker)}, 'configured');`,
        "process.stdout.write('configured');",
      ].join('\n'),
      legacyProgram: [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
        "process.stdout.write('legacy');",
      ].join('\n'),
    });
    const output: string[] = [];

    expect(process.env[fixture.sourceName]).toBeUndefined();

    if (role === 'planner') {
      const planner = await createPlanner(config, undefined, {
        customRuntime: factoryRuntime(fixture, 'headless'),
      });

      await expect(
        planner.review('review the fixture', fixture.projectDir, {
          onOutput: (chunk) => output.push(chunk),
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-admission-denied' });
      expect(existsSync(join(fixture.projectDir, '.splitbrief-runner'))).toBe(false);
    } else {
      const task = makeTask({ file: `src/denied-${contract}.ts` });
      const implementer = await createImplementer(config, {
        customRuntime: factoryRuntime(fixture, 'headless'),
      });

      const result = await implementer.implement({
        task,
        projectDir: fixture.projectDir,
        config,
        context: { ...defaultContext, dir: fixture.projectDir },
        onOutput: (chunk) => output.push(chunk),
      });

      expect(result.success).toBe(false);
      expect(existsSync(join(fixture.projectDir, task.file))).toBe(false);
    }

    expect(output).toEqual([]);
    expect(existsSync(fixture.configuredMarker)).toBe(false);
    expect(existsSync(fixture.legacyMarker)).toBe(false);
    expect(existsSync(resolveCustomRunnerTrustFile(fixture.stateDir))).toBe(false);
  });
});
