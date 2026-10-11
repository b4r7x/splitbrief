import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { seatRunnerValue } from '../../../engine/orchestrator/recovery/actions.js';
import { configWithSwitchedSeat } from '../../../engine/orchestrator/recovery/switch-seat.js';
import { configPath } from './document.js';
import { loadConfig } from './io.js';
import { recordSeatOfRecord, type SeatOfRecord } from './record-seat.js';

const SMOKE_CONFIG = `version: 3
planner:
  # Keep the planner choice.
  kind: cli
  tool: claude-code
  model: claude-opus-5-5
  effort: high
reviewer:
  # Keep the reviewer choice.
  kind: cli
  tool: codex
  model: gpt-6.1-sol
  effort: high
  fallback:
    tool: claude-code
    model: claude-opus-5-5
implementer:
  kind: cli
  tool: opencode
  model: deepseek/deepseek-flash
  fallback:
    tool: opencode
    model: opencode-go/deepseek-v4.1-flash
    variant: high
workflow:
  approve: plan
`;

let projectDir = '';

afterEach(() => {
  if (projectDir !== '') cleanupTempDir(projectDir);
  projectDir = '';
});

function writeProject(rawYaml: string): void {
  projectDir = createTempDir('record-seat-order');
  const file = configPath(projectDir);
  mkdirSync(join(projectDir, '.splitbrief'));
  writeFileSync(file, rawYaml, { mode: 0o600 });
}

async function swap(seat: SeatOfRecord, auto: boolean): Promise<string> {
  const { config, revision } = loadConfig(projectDir);
  if (revision === null) throw new Error('Expected a config revision');
  const candidate = seatRunnerValue(config, seat.seat, seat.profile).fallback;
  if (candidate === undefined) throw new Error('Expected a fallback');
  const switched = configWithSwitchedSeat(config, seat.seat, candidate, seat.profile, auto);
  if (switched === null) throw new Error('Expected a switched config');
  expect(
    await recordSeatOfRecord(
      projectDir,
      seat,
      seatRunnerValue(switched, seat.seat, seat.profile),
      revision.rawSha256,
    ),
  ).toBe('saved');
  return readFileSync(configPath(projectDir), 'utf8');
}

describe('recorded seat order', () => {
  it('records the smoke automatic BUILD fallback and preserves every other line', async () => {
    writeProject(SMOKE_CONFIG);
    const before = `implementer:
  kind: cli
  tool: opencode
  model: deepseek/deepseek-flash
  fallback:
    tool: opencode
    model: opencode-go/deepseek-v4.1-flash
    variant: high
`;
    const after = `implementer:
  kind: cli
  tool: opencode
  model: opencode-go/deepseek-v4.1-flash
  variant: high
  fallback:
    tool: opencode
    model: deepseek/deepseek-flash
`;
    expect((await swap({ seat: 'build' }, true)).split('\n')).toEqual(
      SMOKE_CONFIG.replace(before, after).split('\n'),
    );
  });

  it('preserves comments inside the swapped seat and its fallback', async () => {
    const rawYaml = SMOKE_CONFIG.replace(
      'implementer:\n  kind: cli',
      'implementer:\n  # Keep the build choice.\n  kind: cli # runner kind',
    )
      .replace('model: deepseek/deepseek-flash', 'model: deepseek/deepseek-flash # chosen model')
      .replace('    variant: high', '    # fallback axis\n    variant: high # selected variant');
    writeProject(rawYaml);
    const recorded = await swap({ seat: 'build' }, true);
    expect(recorded.match(/#.*$/gm)).toEqual(rawYaml.match(/#.*$/gm));
    expect(recorded).toContain('  kind: cli # runner kind\n');
    expect(recorded).toContain('  model: opencode-go/deepseek-v4.1-flash # chosen model\n');
    expect(recorded).toContain('  # Keep the build choice.\n');
  });

  describe.each([
    {
      tool: 'opencode',
      axis: 'variant',
      primary: 'deepseek/deepseek-flash',
      next: 'opencode-go/deepseek-v4.1-flash',
    },
    { tool: 'codex', axis: 'effort', primary: 'gpt-5-codex', next: 'gpt-6.1-sol' },
  ] as const)('$tool $axis', ({ tool, axis, primary, next }) => {
    describe.each([
      { seat: 'plan', block: 'planner:', indent: '  ' },
      { seat: 'build', block: 'implementer:', indent: '  ' },
      { seat: 'review', block: 'reviewer:', indent: '  ' },
      { seat: 'build', profile: 'fast', block: '    fast:', indent: '      ' },
    ] as const)('$block', ({ block, indent, ...seat }) => {
      it.each([true, false])('keeps the seat and fallback order with auto = %s', async (auto) => {
        const metadata =
          'profile' in seat ? ['capabilities:', '  writes_files: direct', 'label: Fast'] : [];
        const before =
          [
            block,
            `kind: cli`,
            `tool: ${tool}`,
            `model: ${primary}`,
            `${axis}: medium`,
            ...metadata,
            'fallback:',
            `  tool: ${tool}`,
            `  model: ${next}`,
            `  ${axis}: high`,
          ]
            .map((line, index) => (index === 0 ? line : indent + line))
            .join('\n') + '\n';
        const rawYaml =
          'profile' in seat
            ? SMOKE_CONFIG +
              `implementer_profiles:\n  default: slow\n  profiles:\n${before}    slow:\n      # Keep the other profile.\n      kind: cli\n      tool: codex\n      model: gpt-5-codex\n`
            : SMOKE_CONFIG.replace(new RegExp(`${block}\\n(?:  [^\\n]*\\n)*`), before);
        writeProject(rawYaml);
        const after =
          [
            block,
            'kind: cli',
            `tool: ${tool}`,
            `model: ${next}`,
            `${axis}: high`,
            ...metadata,
            'fallback:',
            `  tool: ${tool}`,
            `  model: ${auto ? primary : next}`,
            `  ${axis}: ${auto ? 'medium' : 'high'}`,
          ]
            .map((line, index) => (index === 0 ? line : indent + line))
            .join('\n') + '\n';

        expect((await swap(seat, auto)).split('\n')).toEqual(
          rawYaml.replace(before, after).split('\n'),
        );
      });
    });
  });

  it.each([false, true])('keeps an API seat order with camelCase keys = %s', async (camelCase) => {
    const before = `implementer:
  kind: api
  provider: ollama
  model: old-model
  ${camelCase ? 'apiBase' : 'api_base'}: http://localhost:11434/v1
  offering: local
  service: ollama
  timeout: 60
  ${camelCase ? 'contextLength' : 'context_length'}: 200000
  temperature: 0.3
  custom_models:
    - old-model # Keep the custom model.
`;
    const rawYaml = SMOKE_CONFIG.replace(/implementer:\n(?: {2}[^\n]*\n)*/, before);
    writeProject(rawYaml);
    const { config, revision } = loadConfig(projectDir);
    if (revision === null) throw new Error('Expected a config revision');
    expect(
      await recordSeatOfRecord(
        projectDir,
        { seat: 'build' },
        {
          ...config.implementer,
          model: 'new-model',
          variant: 'high',
          effort: 'medium',
          fallback: { variant: 'high', model: 'provider/model', tool: 'opencode' },
        },
        revision.rawSha256,
      ),
    ).toBe('saved');
    const after = `implementer:
  kind: api
  provider: ollama
  model: new-model
  effort: medium
  variant: high
  api_base: http://localhost:11434/v1
  offering: local
  service: ollama
  timeout: 60
  context_length: 200000
  temperature: 0.3
  custom_models:
    - old-model # Keep the custom model.
  fallback:
    tool: opencode
    model: provider/model
    variant: high
`;
    expect(readFileSync(configPath(projectDir), 'utf8').split('\n')).toEqual(
      rawYaml.replace(before, after).split('\n'),
    );
  });
});
