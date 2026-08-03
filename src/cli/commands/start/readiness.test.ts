import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-config.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  detectRunnerEvidence,
  runnerDiscoveryContextKey,
} from '../../../engine/detection/detect.js';
import { revalidateCliStartGates, type CliStartGates } from '../../../engine/runners/start-gate.js';
import { authorizeConfiguredCliStart } from './readiness.js';

const FIXTURE_EXECUTABLE_FINGERPRINT = `1:2:3:4:sha256:${'0'.repeat(64)}`;
const itUnix = process.platform === 'win32' ? it.skip : it;

type EvidenceOverrides = Readonly<{
  context: RunnerDiscoveryContext;
  auth?: RunnerEvidence['auth'];
  source?: RunnerEvidence['context']['source'];
  runnerId?: string;
  selectionId?: string;
  path?: string;
}>;

function evidenceFor(overrides: EvidenceOverrides): RunnerEvidence {
  const tool = configuredCliTool(overrides.context);
  const contextKey = runnerDiscoveryContextKey(overrides.context);
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  return {
    runner: {
      id: overrides.runnerId ?? tool,
      kind: 'cli',
      locality: 'local',
      enabled: 'enabled',
    },
    context: { key: contextKey, observedAt: 1, source: overrides.source ?? 'fresh' },
    installation: 'installed',
    executable: {
      kind: 'trusted',
      identity: {
        canonicalPath: overrides.path ?? `/usr/local/bin/${tool}`,
        realPath: overrides.path ?? `/usr/local/bin/${tool}`,
        platformFileId: '1:2',
        fingerprint: FIXTURE_EXECUTABLE_FINGERPRINT,
        resolvedAt: 1,
      },
    },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth: overrides.auth ?? 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: overrides.selectionId ?? 'unselected',
      observedAt: 1,
      contextKey,
    },
  };
}

function configuredCliTool(context: RunnerDiscoveryContext): CliToolId {
  if (context.kind !== 'cli') throw new Error('test expected a CLI context');
  const tool = Object.values(CLI_TOOL_CATALOG).find((candidate) => candidate.id === context.id);
  if (tool === undefined) throw new Error('test expected a known CLI tool');
  return tool.id;
}

function authorize(options: {
  config: Config;
  interaction?: 'interactive' | 'headless';
  allowUnverifiedAuth?: boolean;
  evidence: (context: RunnerDiscoveryContext) => RunnerEvidence;
  disclosures?: Array<{ role: 'planner' | 'implementer'; tool: CliToolId }>;
}) {
  return authorizeConfiguredCliStart({
    projectDir: '/project',
    config: options.config,
    interaction: options.interaction ?? 'interactive',
    allowUnverifiedAuth: options.allowUnverifiedAuth ?? false,
    detectEvidence: async ({ context }) => options.evidence(context),
    revalidateGates: async ({ gates }) => gates,
    ...(options.disclosures !== undefined && {
      onAuthUnknownDisclosure: (disclosure) => options.disclosures?.push(disclosure),
    }),
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function sameLengthCodexShims(
  markerPath: string,
): Readonly<{ initial: string; replacement: string }> {
  const probes = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    "  printf 'codex 0.40.0\\n'",
    '  exit 0',
    'fi',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    "  printf 'authenticated\\n'",
    '  exit 0',
    'fi',
  ].join('\n');
  const initial = `${probes}\n:\n${'#'.repeat(2_048)}\n`;
  const replacementBase = `${probes}\ntouch ${shellQuote(markerPath)}\n`;
  return {
    initial,
    replacement: `${replacementBase}${'#'.repeat(
      Buffer.byteLength(initial) - Buffer.byteLength(replacementBase),
    )}`,
  };
}

describe('fresh configured CLI start authorization', () => {
  it('uses fresh exact-config evidence instead of a prior readiness projection', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });
    const gates = await authorize({
      config,
      evidence: (context) => evidenceFor({ context }),
    });

    expect(gates.get('codex')?.executable.path).toBe('/usr/local/bin/codex');
  });

  itUnix(
    'denies a same-tool replacement between role probes before any gate can invoke it',
    async () => {
      const projectDir = createTempDir('start-role-merge-project');
      const executableDir = createTempDir('start-role-merge-executable');
      const executablePath = join(executableDir, 'codex');
      const markerPath = join(executableDir, 'replacement-invoked');
      const { initial, replacement } = sameLengthCodexShims(markerPath);
      const originalPath = process.env.PATH;
      const originalApiKey = process.env.OPENAI_API_KEY;
      const fixedTime = new Date(1_700_000_000_000);
      let before: ReturnType<typeof statSync> | undefined;
      let plannerEvidence: RunnerEvidence | undefined;
      let implementerEvidence: RunnerEvidence | undefined;
      let gatesAtInvocation: CliStartGates | undefined;
      let authorizationError: unknown;

      try {
        writeFileSync(executablePath, initial, { mode: 0o755 });
        chmodSync(executablePath, 0o755);
        utimesSync(executablePath, fixedTime, fixedTime);
        before = statSync(executablePath);
        process.env.PATH = [executableDir, originalPath ?? ''].filter(Boolean).join(delimiter);
        process.env.OPENAI_API_KEY = 'test-only-start-gate-key';

        const config = makeConfig({
          planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
          implementer: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
        });
        await authorizeConfiguredCliStart({
          projectDir,
          config,
          interaction: 'headless',
          allowUnverifiedAuth: false,
          detectEvidence: async ({ context }) => {
            const evidence = await detectRunnerEvidence({ context, projectDir });
            if (context.role === 'planner') {
              plannerEvidence = evidence;
              writeFileSync(executablePath, replacement, { mode: 0o755 });
              chmodSync(executablePath, 0o755);
              utimesSync(executablePath, fixedTime, fixedTime);
            } else {
              implementerEvidence = evidence;
            }
            return evidence;
          },
          revalidateGates: async (input) => {
            const gates = await revalidateCliStartGates(input);
            gatesAtInvocation = gates;
            const executable = gates.get('codex')?.executable;
            if (executable !== undefined) {
              spawnSync(executable.path, ['exec'], { cwd: projectDir, stdio: 'ignore' });
            }
            return gates;
          },
        });
      } catch (error) {
        authorizationError = error;
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalApiKey;
      }

      const after = statSync(executablePath);
      const plannerIdentity =
        plannerEvidence?.executable.kind === 'trusted'
          ? plannerEvidence.executable.identity
          : undefined;
      const implementerIdentity =
        implementerEvidence?.executable.kind === 'trusted'
          ? implementerEvidence.executable.identity
          : undefined;

      try {
        expect(Buffer.byteLength(initial)).toBe(Buffer.byteLength(replacement));
        expect(after.ino).toBe(before?.ino);
        expect(after.size).toBe(before?.size);
        expect(after.mtimeMs).toBe(before?.mtimeMs);
        expect(plannerIdentity?.fingerprint).not.toBe(implementerIdentity?.fingerprint);
        expect(gatesAtInvocation).toBeUndefined();
        expect(existsSync(markerPath)).toBe(false);
        expect(authorizationError).toMatchObject({
          message: expect.stringContaining('different executable identities'),
        });
      } finally {
        cleanupTempDir(projectDir);
        cleanupTempDir(executableDir);
      }
    },
  );

  it('discloses compatibility auth unknown before admitting an interactive run', async () => {
    const disclosures: Array<{ role: 'planner' | 'implementer'; tool: CliToolId }> = [];
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'aider', authChannel: 'provider-dependent' },
    });
    const gates = await authorize({
      config,
      evidence: (context) => evidenceFor({ context, auth: 'unknown' }),
      disclosures,
    });

    expect(disclosures).toEqual([{ role: 'planner', tool: 'aider' }]);
    expect(gates.has('aider')).toBe(true);
  });

  it('blocks unknown auth in headless mode without the explicit allowance', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'aider', authChannel: 'provider-dependent' },
    });

    await expect(
      authorize({
        config,
        interaction: 'headless',
        evidence: (context) => evidenceFor({ context, auth: 'unknown' }),
      }),
    ).rejects.toThrow('--allow-unverified-auth');
  });

  it('admits unknown auth in headless mode with the explicit allowance', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'aider', authChannel: 'provider-dependent' },
    });
    const gates = await authorize({
      config,
      interaction: 'headless',
      allowUnverifiedAuth: true,
      evidence: (context) => evidenceFor({ context, auth: 'unknown' }),
    });

    expect(gates.has('aider')).toBe(true);
  });

  it('does not let interactive disclosure bypass first-class unknown auth', async () => {
    const disclosures: Array<{ role: 'planner' | 'implementer'; tool: CliToolId }> = [];
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });

    await expect(
      authorize({
        config,
        evidence: (context) => evidenceFor({ context, auth: 'unknown' }),
        disclosures,
      }),
    ).rejects.toThrow('could not be verified');
    expect(disclosures).toEqual([]);
  });

  it('fails closed when supplied evidence is not fresh', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });

    await expect(
      authorize({
        config,
        evidence: (context) => evidenceFor({ context, source: 'legacy-projection' }),
      }),
    ).rejects.toThrow('not checked freshly');
  });

  it('fails closed when fresh evidence names a different runner', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });

    await expect(
      authorize({
        config,
        evidence: (context) => evidenceFor({ context, runnerId: 'claude-code' }),
      }),
    ).rejects.toThrow('changed while it was being checked');
  });

  it.each([
    [
      'role',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        role: context.role === 'planner' ? 'implementer' : 'planner',
      }),
    ],
    [
      'auth channel',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        authChannel: 'session',
      }),
    ],
    [
      'endpoint origin',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        endpointOrigin: 'https://evidence-only.example',
      }),
    ],
    [
      'credential domain',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        credentialPresent: true,
        endpointOrigin: 'https://api.openai.example',
        credentialDomain: {
          providerId: 'openai',
          endpointOrigin: 'https://api.openai.example',
          authChannel: 'api-key',
          credentialSource: { kind: 'env', name: 'EVIDENCE_ONLY_OPENAI_KEY' },
          configGeneration: context.configGeneration,
        },
      }),
    ],
    [
      'configuration generation',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        configGeneration: `${context.configGeneration}-different`,
      }),
    ],
    [
      'model selection',
      (context: RunnerDiscoveryContext): RunnerDiscoveryContext => ({
        ...context,
        model: 'evidence-only-model',
      }),
    ],
  ] as const)('denies fresh evidence bound to a different %s', async (_field, differentContext) => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });

    await expect(
      authorize({
        config,
        evidence: (context) => evidenceFor({ context: differentContext(context) }),
      }),
    ).rejects.toThrow('changed while it was being checked');
  });
});
