import type { CliReadinessState, CliToolDetection } from '../../../src/core/discovery/detection.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../src/core/runners/cli-tool-catalog.js';
import { cliDetectionFromReadiness } from '../../../src/engine/detection/detect.js';
import { deriveCliReadiness, type CliReadinessFacts } from '../../../src/core/schemas/readiness.js';

export const PROBE_EXECUTABLE = Object.freeze({
  path: '/opt/splitbrief/bin/cli-tool',
  fingerprint: Object.freeze({ dev: 1, ino: 2, size: 3, mtimeMs: 4 }),
});

export const PROBED_AT = 1_786_000_000_000;

/**
 * The probe facts a readiness state is derived from. Every field is an input to
 * the real `deriveCliReadiness`, so a combination that no longer derives its
 * state is rejected below instead of being fabricated into existence.
 */
export function cliReadinessFactsFor(
  state: CliReadinessState,
  tool: CliToolId = 'codex',
): CliReadinessFacts {
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  const base = {
    tool,
    enabled: true,
    installation: 'installed',
    executable: { path: PROBE_EXECUTABLE.path, fingerprint: { ...PROBE_EXECUTABLE.fingerprint } },
    trust: 'trusted',
    installedVersion: testedVersion,
    testedVersion,
    compatibility: 'compatible',
    auth: 'authenticated',
    probedAt: PROBED_AT,
  } as const satisfies CliReadinessFacts;

  switch (state) {
    case 'ready':
      return base;
    case 'disabled':
      return { ...base, enabled: false };
    case 'unavailable':
      return {
        ...base,
        installation: 'unavailable',
        executable: null,
        trust: 'not-checked',
        installedVersion: null,
        compatibility: 'not-checked',
        auth: 'not-checked',
      };
    case 'untrusted':
      return {
        ...base,
        trust: 'untrusted',
        installedVersion: null,
        compatibility: 'not-checked',
        auth: 'not-checked',
      };
    case 'incompatible':
      return { ...base, compatibility: 'incompatible', auth: 'not-checked' };
    case 'unverified':
      return { ...base, compatibility: 'unverified', auth: 'not-checked' };
    case 'unauthenticated':
      return { ...base, auth: 'unauthenticated' };
  }
}

/**
 * Build a store-shaped detection record the way detection itself builds one:
 * facts through the real `deriveCliReadiness`, then the real readiness →
 * detection projection. Facts that do not derive the requested state throw, so
 * an unproducible record (a `ready` tool with no executable, say) cannot be
 * written by hand.
 */
export function makeCliToolDetection(facts: CliReadinessFacts): CliToolDetection {
  return cliDetectionFromReadiness(deriveCliReadiness(facts));
}

export function cliDetectionFor(
  state: CliReadinessState,
  tool: CliToolId = 'codex',
  overrides: Partial<CliReadinessFacts> = {},
): CliToolDetection {
  const detection = makeCliToolDetection({ ...cliReadinessFactsFor(state, tool), ...overrides });
  if (detection.diagnostic.state !== state) {
    throw new Error(
      `readiness facts for ${tool} derive "${detection.diagnostic.state}", not "${state}"`,
    );
  }
  return detection;
}

export function cliDetectionsFor(
  state: CliReadinessState,
  tools: readonly CliToolId[],
): CliToolDetection[] {
  return tools.map((tool) => cliDetectionFor(state, tool));
}
