import { describe, expect, it } from 'vitest';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG, type CliAuthChannelId } from '../../core/runners/cli-tool-catalog.js';
import type { CliReadinessProbeEvidence } from '../runners/cli-tools/cli-probe-evidence.js';
import type { probeDeclaredCliReadinessEvidence } from '../runners/cli-tools/readiness-probe.js';
import type { CliExecutableResolver } from '../runners/resolve-cli-executable.js';
import { detectRunnerEvidence } from './runner-evidence.js';

const TESTED_VERSION = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;

/** One clock for every call: an injected seam is part of the observation's identity. */
const observationClock = () => 1_000;

function cliContext(
  input: Readonly<{
    authChannel?: CliAuthChannelId | undefined;
    model?: string | undefined;
    role?: 'planner' | 'implementer' | undefined;
    configGeneration?: string | undefined;
  }> = {},
): RunnerDiscoveryContext {
  return {
    role: input.role ?? 'planner',
    kind: 'cli',
    id: 'codex',
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.authChannel === undefined ? {} : { authChannel: input.authChannel }),
    credentialPresent: false,
    configGeneration: input.configGeneration ?? 'observation-generation',
  };
}

function executableAt(ino: number): CliExecutableIdentity {
  return { path: '/trusted/bin/codex', fingerprint: { dev: 1, ino, size: 3, mtimeMs: 4 } };
}

/** Resolves the same receipt every time, so only the context can change the key. */
function stableResolver(): CliExecutableResolver {
  return async () => executableAt(2);
}

/**
 * A readiness probe that never spawns anything: it parks until the test
 * releases it, counting how many separate probes the sharing key allowed.
 */
function gatedProbe() {
  const waiting: Array<() => void> = [];
  const signals: Array<AbortSignal | undefined> = [];
  let calls = 0;
  const probe: typeof probeDeclaredCliReadinessEvidence = async (options) => {
    calls += 1;
    signals.push(options.signal);
    await new Promise<void>((resolve) => waiting.push(resolve));
    const evidence: CliReadinessProbeEvidence = {
      version: { kind: 'success', value: TESTED_VERSION },
      auth: 'verified',
    };
    return evidence;
  };
  return {
    probe,
    signals,
    calls: () => calls,
    release: () => {
      for (const resume of waiting.splice(0)) resume();
    },
  };
}

function detect(
  input: Readonly<{
    context: RunnerDiscoveryContext;
    resolveExecutable: CliExecutableResolver;
    probeDeclaredReadiness: typeof probeDeclaredCliReadinessEvidence;
    signal?: AbortSignal | undefined;
  }>,
) {
  return detectRunnerEvidence({
    context: input.context,
    projectDir: '/observation/project',
    resolveExecutable: input.resolveExecutable,
    probeDeclaredReadiness: input.probeDeclaredReadiness,
    now: observationClock,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('detectRunnerEvidence in-flight sharing', () => {
  it.each(['session', 'api-key', 'provider-dependent', undefined] as const)(
    'does not reuse native auth observations for %s without account freshness',
    async (authChannel) => {
      const fixture = gatedProbe();
      const options = { context: cliContext({ authChannel }), resolveExecutable: stableResolver() };
      const first = detect({ ...options, probeDeclaredReadiness: fixture.probe });
      const second = detect({ ...options, probeDeclaredReadiness: fixture.probe });
      await settle();
      fixture.release();
      await expect(first).resolves.toMatchObject({ auth: 'verified' });
      await expect(second).resolves.toMatchObject({ auth: 'verified' });
      expect(fixture.calls()).toBe(2);
    },
  );

  it('probes afresh after the previous observation has settled', async () => {
    const fixture = gatedProbe();
    const options = {
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: stableResolver(),
      probeDeclaredReadiness: fixture.probe,
    };

    const first = detect(options);
    await settle();
    fixture.release();
    await first;

    const later = detect(options);
    await settle();
    fixture.release();
    await later;

    expect(fixture.calls()).toBe(2);
  });

  it('cancels one native observation without cancelling another', async () => {
    const fixture = gatedProbe();
    const options = {
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: stableResolver(),
      probeDeclaredReadiness: fixture.probe,
    };
    const leaving = new AbortController();

    const cancelled = detect({ ...options, signal: leaving.signal });
    const staying = detect({ ...options, signal: new AbortController().signal });
    await settle();
    leaving.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.signals[0]?.aborted).toBe(true);
    expect(fixture.signals[1]?.aborted).toBe(false);
    fixture.release();
    await expect(staying).resolves.toMatchObject({ auth: 'verified' });
    expect(fixture.calls()).toBe(2);
  });

  it('aborts each native observation when its caller leaves', async () => {
    const fixture = gatedProbe();
    const options = {
      context: cliContext({ authChannel: 'session' }),
      resolveExecutable: stableResolver(),
      probeDeclaredReadiness: fixture.probe,
    };
    const first = new AbortController();
    const second = new AbortController();

    const one = detect({ ...options, signal: first.signal });
    const two = detect({ ...options, signal: second.signal });
    await settle();
    first.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.signals[0]?.aborted).toBe(true);
    expect(fixture.signals[1]?.aborted).toBe(false);
    second.abort();
    await expect(two).rejects.toMatchObject({ name: 'AbortError' });

    expect(fixture.signals[0]?.aborted).toBe(true);
    expect(fixture.calls()).toBe(2);
    fixture.release();
  });
});
