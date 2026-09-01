import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  createImplementer as createPreparedImplementer,
  createPlanner as createPreparedPlanner,
} from './factory.js';
import type { CustomRunnerRuntimePort } from './types.js';
import type { PlannerFactoryOptions } from '../planners/types.js';
import type { ImplementerFactoryOptions } from '../implementers/types.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { prepareCustomRunnerAdmission } from './custom-admission.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import { customRunnerAdmissionError } from './custom-launchability.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { prepareExecution } from './prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../core/readiness/types.js';

type CustomRunnerRole = 'planner' | 'implementer';
type CustomCommandContract = 'output' | 'direct';

const API_PLANNER = {
  kind: 'api',
  provider: 'custom-endpoint',
  service: 'custom-endpoint',
  offering: 'payg',
  apiBase: 'https://api.example.test/v1',
  model: 'house-brand-1',
  apiKey: 'test-key',
} as const;

function readyReport(project: string): ReadinessReport {
  return {
    generatedAt: '2026-08-03T20:00:00.000Z',
    projectDir: project,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [{ id: 'runners.configured', severity: 'ok', summary: 'Configured' }],
      },
    ],
    metadata: {},
  };
}

const configuredRoutes = [
  ['planner', 'output'],
  ['planner', 'direct'],
  ['implementer', 'output'],
  ['implementer', 'direct'],
] as const;

async function createPlanner(
  config: Config,
  initialSessionId: string | null | undefined,
  options: PlannerFactoryOptions,
) {
  const runtime = options.customRuntime;
  const runner = resolveConfiguredCustomRunner(config, 'planner');
  if (runtime === undefined || runner === null)
    throw new Error('Missing configured planner test input.');
  const admission = await prepareCustomRunnerAdmission({
    ...runtime.admission,
    projectDir: runtime.authorizationProjectDir,
    runner,
    posture: customRunnerSecurityPosture('planner', runner.command.contract),
    phase: 'planning',
    authorizationPathEnv: runtime.authorizationPathEnv ?? '',
    authorizationPathExt: runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('planner');
  const preparationId = 'factory-configured-planner';
  const slot = { role: 'planner' as const };
  return createPreparedPlanner(config, {
    ...options,
    initialSessionId,
    preparedConfig: config,
    preparationId,
    slot,
    gates: [
      {
        kind: runner.command.contract === 'output' ? 'shell' : 'agent',
        slot,
        preparationId,
        command: { kind: 'configured-custom', invocation: admission.invocation },
      },
    ],
  });
}

async function createImplementer(config: Config, options: ImplementerFactoryOptions) {
  const runtime = options.customRuntime;
  const runner = resolveConfiguredCustomRunner(config, 'implementer');
  if (runtime === undefined || runner === null) {
    throw new Error('Missing configured implementer test input.');
  }
  const admission = await prepareCustomRunnerAdmission({
    ...runtime.admission,
    projectDir: runtime.authorizationProjectDir,
    runner,
    posture: customRunnerSecurityPosture('implementer', runner.command.contract),
    phase: 'implementing',
    authorizationPathEnv: runtime.authorizationPathEnv ?? '',
    authorizationPathExt: runtime.authorizationPathExt ?? '',
  });
  if (admission.kind !== 'admitted') throw customRunnerAdmissionError.denied('implementer');
  const preparationId = 'factory-configured-implementer';
  const slot = {
    role: 'implementer' as const,
    profile: resolveImplementerProfiles(config).defaultProfile.name,
  };
  return createPreparedImplementer(config, {
    ...options,
    preparedConfig: config,
    preparationId,
    slot,
    gates: [
      {
        kind: runner.command.contract === 'output' ? 'shell' : 'agent',
        slot,
        preparationId,
        command: { kind: 'configured-custom', invocation: admission.invocation },
      },
    ],
  });
}

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
            'fs.writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, declaredArtifact);',
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

    let observedProvenance:
      | Parameters<CustomRunnerRuntimePort['beginDeclaredArtifactReview']>[0]['provenance']
      | undefined;
    const runtime = factoryRuntime(fixture, 'interactive');
    const planner = await createPlanner(config, undefined, {
      customRuntime: {
        ...runtime,
        beginDeclaredArtifactReview: (input) => {
          observedProvenance = input.provenance;
          return runtime.beginDeclaredArtifactReview(input);
        },
      },
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
    if (observedProvenance === undefined) {
      throw new Error('The production factory did not receive declared artifact provenance.');
    }
    expect(observedProvenance).toEqual(
      expect.objectContaining({
        programId: null,
        batchId: null,
        transport: expect.objectContaining({
          kind: 'declared-file',
          lease: expect.objectContaining({ attemptId: expect.any(String) }),
        }),
      }),
    );
    expect(observedProvenance?.attemptId).toBe(
      observedProvenance?.transport.kind === 'declared-file'
        ? observedProvenance.transport.lease.attemptId
        : undefined,
    );
  });

  it('carries the production declared-file receipt into the owned planner artifact', async () => {
    const fixture = createFixture('planner-direct-owned-artifact');
    const taskMarkdown = `---
id: T001
title: Preserve the receipt
action: create
file: src/receipt.ts
depends_on: []
---

### Description
Preserve the declared-file receipt.

### Implementation Steps
1. Keep the receipt attached to the phase artifact.

### Tests
- vitest passes

### Constraints
- Keep the receipt attempt-bound
`;
    const config = configuredFactoryBehaviorConfig({
      role: 'planner',
      contract: 'direct',
      sourceName: fixture.sourceName,
      program: [
        "const fs = require('node:fs');",
        `fs.writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, ${JSON.stringify(taskMarkdown)});`,
      ].join('\n'),
      legacyProgram: `require('node:fs').writeFileSync(${JSON.stringify(fixture.legacyMarker)}, 'legacy');`,
    });

    const planner = await createPlanner(config, undefined, {
      customRuntime: factoryRuntime(fixture, 'interactive'),
    });
    const result = await planner.quickPlan({
      feature: 'preserve the declared artifact receipt',
      projectDir: fixture.projectDir,
      callbacks: { onOutput: () => {}, persistTranscript: false },
    });
    const artifact = result.phases?.[0]?.artifact;

    expect(artifact).toBeDefined();
    expect(artifact?.transport).toBe('declared-file');
    expect(artifact?.sourceReceipt).toMatchObject({
      kind: 'declared-file',
      leaseId: expect.any(String),
      inodeIdentity: expect.stringMatching(/^\d+:\d+$/),
      leaseReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(artifact?.programId).toBeNull();
    expect(artifact?.batchId).toBeNull();
    expect(artifact?.text).toBe(taskMarkdown);
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

  it('passes prepared custom shell and agent admission through factories without prompting again', async () => {
    const fixture = createFixture('prepared-admission-once');
    const config = configuredFactoryBehaviorConfig({
      role: 'planner',
      contract: 'output',
      sourceName: fixture.sourceName,
      program: "process.stdout.write('prepared admission');",
      legacyProgram: "process.stdout.write('legacy');",
    });
    const baseRuntime = factoryRuntime(fixture, 'interactive');
    const approve = baseRuntime.admission.onTieredApproval;
    if (approve === undefined) throw new Error('Expected interactive approval callback.');
    const onTieredApproval = vi.fn(approve);
    const runtime: CustomRunnerRuntimePort = {
      ...baseRuntime,
      admission: { ...baseRuntime.admission, onTieredApproval },
    };

    const planner = await createPlanner(config, undefined, { customRuntime: runtime });
    await planner.review('first', fixture.projectDir, { onOutput: () => {} });
    await planner.review('second', fixture.projectDir, { onOutput: () => {} });

    expect(onTieredApproval).toHaveBeenCalledOnce();
  });

  it.each(configuredRoutes)(
    'denies a configured %s %s child before it can start or fall back',
    async (role, contract) => {
      const fixture = createFixture(`denied-${role}-${contract}`);
      const behaviorConfig = configuredFactoryBehaviorConfig({
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
      const config =
        role === 'planner'
          ? behaviorConfig
          : ConfigSchema.parse({ ...behaviorConfig, planner: API_PLANNER });

      expect(process.env[fixture.sourceName]).toBeUndefined();

      const outcome = await prepareExecution({
        projectDir: fixture.projectDir,
        feature: `denied configured ${role} ${contract}`,
        effectiveConfig: config,
        signal: new AbortController().signal,
        policy: {
          purpose: 'new-workflow',
          interaction: 'headless',
          unverifiedAuth: 'denied',
          allowRepoRunners: false,
          allowHooks: true,
          stateDir: fixture.stateDir,
        },
        deps: {
          collectArgVectorPreflightChecks: async () => [],
          collectReadiness: async () => ({ report: readyReport(fixture.projectDir), config }),
          prepareNewSession: vi.fn(),
        },
      });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      const runnerChecks =
        outcome.report.sections.find((section) => section.id === 'runners')?.checks ?? [];
      expect(runnerChecks).toContainEqual(
        expect.objectContaining({
          severity: 'blocker',
          details: ['Configured custom runner admission was denied.'],
          metadata: expect.objectContaining({ role }),
        }),
      );
      expect(existsSync(join(fixture.projectDir, '.splitbrief-runner'))).toBe(false);
      expect(existsSync(join(fixture.projectDir, `src/denied-${contract}.ts`))).toBe(false);
      expect(existsSync(fixture.configuredMarker)).toBe(false);
      expect(existsSync(fixture.legacyMarker)).toBe(false);
      expect(existsSync(resolveCustomRunnerTrustFile(fixture.stateDir))).toBe(false);
    },
  );
});
