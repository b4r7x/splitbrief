import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_KINDS } from '../../src/core/schemas/enums.js';

const docPath = join(import.meta.dirname, '..', '..', 'docs', 'EXTENDING.md');
const doc = readFileSync(docPath, 'utf8');

const CLI_REQUIRED_STEPS = [
  'core descriptor',
  'supported roles, model, auth, posture',
  'trusted identity',
  'probe',
  'lossless transport',
  'args conflicts',
  'parser/terminal',
  'env',
  'direct-change proof',
  'common/live/eval gates',
  'late registry/docs',
] as const;

const PROVIDER_REQUIRED_STEPS = [
  'service/offering',
  'endpoint',
  'credential',
  'billing/privacy/asOf',
  'policy',
  'production conformance',
  'eval',
  'late registration',
] as const;

function sectionSlice(heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

function orderedSteps(section: string, steps: readonly string[]): void {
  const lower = section.toLowerCase();
  let cursor = 0;
  for (const step of steps) {
    const needle = step.toLowerCase();
    const index = lower.indexOf(needle, cursor);
    expect(index, `missing step "${step}"`).toBeGreaterThanOrEqual(0);
    cursor = index + needle.length;
  }
}

describe('required-step', () => {
  it('lists every CLI admission step in order', () => {
    orderedSteps(sectionSlice('### CLI admission checklist'), CLI_REQUIRED_STEPS);
  });

  it('lists every provider admission step in order', () => {
    orderedSteps(sectionSlice('### Provider admission checklist'), PROVIDER_REQUIRED_STEPS);
  });
});

describe('raw/production transaction', () => {
  it('documents CLI raw then production conformance on the same record', () => {
    const cli = sectionSlice('#### Raw/production transaction (CLI)');
    expect(cli).toContain('scripts/cli-conformance.ts raw');
    expect(cli).toContain('scripts/cli-conformance.ts production');
    expect(cli.indexOf('raw')).toBeLessThan(cli.indexOf('production'));
    expect(cli).toContain('RawCliCandidateContract');
    expect(cli).toContain('productionConformance');
    expect(cli).toMatch(/late steps|late registry/i);
  });

  it('documents provider raw then production conformance on the same record', () => {
    const provider = sectionSlice('#### Raw/production transaction (provider)');
    expect(provider).toContain('scripts/provider-conformance.ts raw');
    expect(provider).toContain('scripts/provider-conformance.ts production');
    expect(provider.indexOf('raw')).toBeLessThan(provider.indexOf('production'));
    expect(provider).toContain('RawProviderCandidateContract');
    expect(provider).toContain('productionConformance');
  });

  it('states the fixed admission order ending in late registration/docs', () => {
    expect(doc).toContain(
      'primary-source record → deterministic fixtures → credentialed production-path smoke → implementation-quality/privacy evaluation → central registration/docs',
    );
  });
});

describe('forbidden-abstraction', () => {
  it('states the closed runner-kind set from RUNNER_KINDS', () => {
    const constraints = sectionSlice('### Architectural constraints');
    expect(constraints).toContain('One runner-kind set');
    for (const kind of RUNNER_KINDS) {
      expect(constraints).toContain(kind);
    }
    expect(constraints).toMatch(/do not add a sixth runner kind/i);
  });

  it('rejects a generic argv DSL and plugin framework', () => {
    const constraints = sectionSlice('### Architectural constraints');
    expect(constraints).toMatch(/no argv dsl/i);
    expect(constraints).toMatch(/no argv dsl or plugin framework/i);
    expect(constraints).toMatch(/plugin framework/i);
    expect(constraints).toMatch(/do not build a generic argv insertion dsl/i);
  });

  it('requires one OpenAI transport through openai-stream only', () => {
    const constraints = sectionSlice('### Architectural constraints');
    expect(constraints).toMatch(/one openai transport/i);
    expect(constraints).toContain('src/engine/providers/openai-stream/');
    expect(constraints).toMatch(
      /do not add a second generic openai-compatible streaming transport/i,
    );
  });
});
