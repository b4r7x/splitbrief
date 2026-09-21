import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import type { CliAuthMethod } from '../../core/runners/cli-tool-catalog.js';
import type { SeatPickerRole } from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import { INHERIT_PLANNER_OPTION_ID, type RunnerPickerOption } from './model-catalog/options.js';
import type { LocalConnectionSave } from './local-connection-form.js';
import { useLocalConnectionActions, usePickerActions } from './use-picker-actions.js';
import { usePickerCatalog } from './use-picker-catalog.js';

function ConfirmOnKeyProbe({
  role,
  selection,
  model,
}: {
  role: SeatPickerRole;
  selection: RunnerPickerOption;
  model?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0, selection.id);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.confirm(selection, { id: model ?? 'auto' });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Confirms a catalog row; with no `itemId` it confirms the pre-selected one. */
function ConfirmRowProbe({ role, itemId }: { role: SeatPickerRole; itemId?: string | undefined }) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    const row =
      itemId === undefined
        ? catalog.items[catalog.initialLeftIdx]
        : catalog.items.find((item) => item.id === itemId);
    if (row !== undefined) void actions.confirm(row, null);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Confirms an expanded model: the drafted id, plus the drafted variant when there is one. */
function ConfirmVariantProbe({
  role,
  toolId,
  modelId,
  variant,
}: {
  role: SeatPickerRole;
  toolId: string;
  modelId: string;
  variant?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0, toolId);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.confirmProviderSelection(modelId, variant);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Saves one local connection to the seat's own block, and reports what that seat reads back. */
function LocalConnectionProbe({
  role,
  save,
  onSeat,
}: {
  role: SeatPickerRole;
  save: LocalConnectionSave;
  onSeat: (apiBase: string, model: string | undefined) => void;
}) {
  const actions = useLocalConnectionActions(role);
  const seat = actions.seat(save.provider);

  useInput((input) => {
    if (input === 's') void actions.save(save);
    else onSeat(seat.apiBase, seat.model);
  });

  return <Text>{seat.apiBase}</Text>;
}

/** Confirms one authentication method for the seat; `c` leaves the picker instead. */
function ConfirmAuthProbe({
  role,
  method,
}: {
  role: SeatPickerRole;
  method: CliAuthMethod | 'host-configured';
}) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput((input) => {
    if (input === 'c') actions.closeOverlay();
    else void actions.confirmAuthMethod(method);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function BrowseOnKeyProbe({ role }: { role: SeatPickerRole }) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    actions.browseCatalog();
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function LeftChangeOnKeyProbe({
  role,
  selection,
}: {
  role: SeatPickerRole;
  selection: RunnerPickerOption;
}) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    actions.leftChange(selection);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function DeleteOnKeyProbe({ role, modelId }: { role: SeatPickerRole; modelId: string }) {
  const catalog = usePickerCatalog(role, 0, modelId);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.deleteRight({ id: modelId, isCustom: true });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

describe('usePickerActions', () => {
  let projectDir = '';

  const seed = (config: Config) => configStore.__testReset({ projectDir, config });

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'picker-actions-test-'));
    configStore.__testReset({ projectDir, config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    feedbackStore.reset();
    pickerViewStore.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('commits a reviewer confirmation to the reviewer block and leaves the planner unchanged', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const plannerBefore = JSON.stringify(config.planner);

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="reviewer" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
    });
    expect(JSON.stringify(configStore.get().config?.planner)).toBe(plannerBefore);
    ui.unmount();
  });

  it('commits a planner confirmation to the planner block and writes no reviewer block', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ kind: 'cli', tool: 'codex' });
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    ui.unmount();
  });

  it('leaves the review seat inherited when the pre-selected row is confirmed', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(<ConfirmRowProbe role="reviewer" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain(CREW_SEAT_LABELS.review);
      expect(feedbackStore.get().message).toContain(PLANNER_INHERITANCE.sentence);
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    ui.unmount();
  });

  it('clears a configured reviewer block when the inherit row is confirmed', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="reviewer" selection={realPickerOption('planner', 'claude-code')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ tool: 'claude-code' });
    });
    ui.unmount();

    const back = renderFeature(
      <ConfirmRowProbe role="reviewer" itemId={INHERIT_PLANNER_OPTION_ID} />,
    );
    await flushEffects();
    back.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toBeUndefined();
    });
    back.unmount();
  });

  it('reports a refusal instead of a removal when the reviewer inherits the planner custom model', async () => {
    seed(
      makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'inherited-custom',
          customModels: ['inherited-custom'],
        },
      }),
    );

    const ui = renderFeature(<DeleteOnKeyProbe role="reviewer" modelId="inherited-custom" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().isError).toBe(true);
    });
    expect(configStore.get().config?.planner).toMatchObject({
      customModels: ['inherited-custom'],
    });
    ui.unmount();
  });

  it('opens the full catalog when the browse action fires', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const configBefore = JSON.stringify(configStore.get().config);

    const ui = renderFeature(<BrowseOnKeyProbe role="planner" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(pickerViewStore.get().browseCatalog).toBe(true);
    });
    expect(JSON.stringify(configStore.get().config)).toBe(configBefore);
    ui.unmount();
  });

  it('closes the browsed catalog when the tool cursor moves', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    pickerViewStore.setBrowseCatalog(true);

    const ui = renderFeature(
      <LeftChangeOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(pickerViewStore.get().browseCatalog).toBe(false);
    });
    ui.unmount();
  });

  it('persists the drafted variant beside the model on confirm', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="opencode"
        modelId="openai/gpt-5.6"
        variant="high"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6',
        variant: 'high',
      });
    });
    ui.unmount();
  });

  it('saves the model alone when no variant was drafted', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="opencode" modelId="openai/gpt-5.5" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ model: 'openai/gpt-5.5' });
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    ui.unmount();
  });

  it('names the saved variant in the confirmation message', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="opencode"
        modelId="openai/gpt-5.6"
        variant="high"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('high');
    });
    expect(feedbackStore.get().message).toContain(`${CREW_SEAT_LABELS.plan} set to:`);
    ui.unmount();
  });

  // The picker offers one ladder per row and the seat's channel picks the field that
  // spends it, so a level drafted on a flag-channel tool is saved rather than announced
  // as a drop. Naming it in the save line is `effort-commit-routing`'s (REQ-E17).
  it('saves a drafted level to the effort field of a flag-channel seat', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="codex" modelId="gpt-5-codex" variant="high" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.startsWith(`${CREW_SEAT_LABELS.plan} set to:`)),
      ).toBe(true);
    });
    stopWatching();

    expect(configStore.get().config?.planner).toMatchObject({ tool: 'codex', effort: 'high' });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    expect(messages.every((message) => !message.includes('cleared'))).toBe(true);
    ui.unmount();
  });

  it('says so when switching tools clears an effort the new tool cannot carry', async () => {
    seed(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' } }),
    );

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'opencode')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('cleared');
    });
    ui.unmount();
  });

  it('names the kept level once, as one identity string', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="claude-code" modelId="opus" variant="high" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.startsWith(`${CREW_SEAT_LABELS.plan} set to:`)),
      ).toBe(true);
    });
    stopWatching();

    expect(
      messages.filter((message) => message.startsWith(`${CREW_SEAT_LABELS.plan} set to:`)),
    ).toEqual([`${CREW_SEAT_LABELS.plan} set to: Claude Code CLI · opus · high`]);
    expect(configStore.get().config?.planner).toMatchObject({
      tool: 'claude-code',
      effort: 'high',
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    ui.unmount();
  });

  it('leaves a dropped level out of the save line', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="claude-code"
        modelId="opus"
        variant="ludicrous"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.startsWith(`${CREW_SEAT_LABELS.plan} set to:`)),
      ).toBe(true);
    });
    stopWatching();

    expect(
      messages.filter((message) => message.startsWith(`${CREW_SEAT_LABELS.plan} set to:`)),
    ).toEqual([`${CREW_SEAT_LABELS.plan} set to: Claude Code CLI · opus`]);
    expect(messages.some((message) => message.includes('Effort ludicrous'))).toBe(true);
    expect(configStore.get().config?.planner).not.toHaveProperty('effort');
    ui.unmount();
  });

  it('keeps a saved PLAN and REVIEW local connection independent across reopen', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    const serverA = 'http://localhost:11434/v1';
    const serverB = 'http://127.0.0.1:11435/v1';
    const readBack: string[] = [];

    const plan = renderFeature(
      <LocalConnectionProbe
        role="planner"
        save={{ provider: 'ollama', apiBase: serverA, apiKey: undefined, model: 'modelA' }}
        onSeat={() => {}}
      />,
    );
    await flushEffects();
    plan.stdin.write('s');
    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ apiBase: serverA });
    });
    plan.unmount();

    const review = renderFeature(
      <LocalConnectionProbe
        role="reviewer"
        save={{ provider: 'ollama', apiBase: serverB, apiKey: undefined, model: 'modelB' }}
        onSeat={() => {}}
      />,
    );
    await flushEffects();
    review.stdin.write('s');
    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ apiBase: serverB });
    });
    review.unmount();

    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      apiBase: serverA,
      model: 'modelA',
    });
    expect(configStore.get().config?.reviewer).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      apiBase: serverB,
      model: 'modelB',
    });

    // Reopened, each seat prefills from its own block rather than from the planner's.
    for (const role of ['planner', 'reviewer'] as const) {
      const reopened = renderFeature(
        <LocalConnectionProbe
          role={role}
          save={{ provider: 'ollama', apiBase: serverA, apiKey: undefined, model: 'modelA' }}
          onSeat={(apiBase, model) => readBack.push(`${apiBase}|${model ?? 'none'}`)}
        />,
      );
      await flushEffects();
      reopened.stdin.write('r');
      await vi.waitFor(() => {
        expect(readBack).toHaveLength(role === 'planner' ? 1 : 2);
      });
      reopened.unmount();
    }
    expect(readBack).toEqual([`${serverA}|modelA`, `${serverB}|modelB`]);
  });

  it('prefills an unconfigured review seat from the profile default, never the planner address', async () => {
    seed(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11499/v1',
          model: 'plan-model',
        },
      }),
    );
    const readBack: string[] = [];

    const ui = renderFeature(
      <LocalConnectionProbe
        role="reviewer"
        save={{
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          apiKey: undefined,
          model: 'x',
        }}
        onSeat={(apiBase, model) => readBack.push(`${apiBase}|${model ?? 'none'}`)}
      />,
    );
    await flushEffects();
    ui.stdin.write('r');
    await vi.waitFor(() => {
      expect(readBack).toHaveLength(1);
    });

    expect(readBack).toEqual(['http://localhost:11434/v1|none']);
    ui.unmount();
  });

  it("drops a carried variant the confirmed row's own ladder does not spell", async () => {
    seed(
      makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: 'anthropic/claude-sonnet-5',
          variant: 'max',
        },
      }),
    );
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'opencode')],
        catalog: {},
        cliModels: [
          {
            connection: { tool: 'opencode', contextKey: 'c' },
            outcome: {
              kind: 'success',
              value: [
                {
                  id: 'openai/gpt-5.5',
                  nativeReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
                },
              ],
            },
          },
        ],
        generation: 1,
      },
    });

    const ui = renderFeature(
      <ConfirmOnKeyProbe
        role="implementer"
        selection={realPickerOption('implementer', 'opencode')}
        model="openai/gpt-5.5"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.implementer).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.5',
      });
    });
    expect(configStore.get().config?.implementer).not.toHaveProperty('variant');
    expect(feedbackStore.get().message).toContain('max');
    ui.unmount();
  });
  it('stores the confirmed method on the seat and changes nothing else', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const detectionBefore = JSON.stringify(detectionStore.get());

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="api-key" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ authChannel: 'api-key' });
    });
    // The method binds the invocation; it is not a second way to choose a tool or a
    // model, and it reaches nothing outside this seat's own block.
    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    expect(JSON.stringify(configStore.get().config?.implementer)).toBe(
      JSON.stringify(config.implementer),
    );
    // Nothing probes, signs in or switches an account: the whole action is one
    // config write, so the detection the host login is read through is untouched.
    expect(JSON.stringify(detectionStore.get())).toBe(detectionBefore);
    expect(feedbackStore.get().isError).toBe(false);
    expect(feedbackStore.get().message).toContain('api key');
    ui.unmount();
  });

  it('removes the explicit field when host configuration is confirmed', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto', authChannel: 'session' },
      }),
    );

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="host-configured" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).not.toHaveProperty('authChannel');
    });
    // Removed, not overwritten with the tool's default: a resolver's answer must
    // never be persisted as the user's choice.
    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
    });
    ui.unmount();
  });

  it('leaves the seat alone when the picker is closed without confirming', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto', authChannel: 'session' },
    });
    seed(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="api-key" />);
    await flushEffects();
    ui.stdin.write('c');
    await flushEffects();

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBe(null);
    ui.unmount();
  });

  it('writes the review seat its own channel and leaves the planner unchanged', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });
    seed(config);
    const plannerBefore = JSON.stringify(config.planner);

    const ui = renderFeature(<ConfirmAuthProbe role="reviewer" method="session" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({
        tool: 'codex',
        authChannel: 'session',
      });
    });
    expect(JSON.stringify(configStore.get().config?.planner)).toBe(plannerBefore);
    ui.unmount();
  });

  it('writes the build seat its own channel', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
        implementer: { kind: 'cli', tool: 'codex' },
      }),
    );

    const ui = renderFeature(<ConfirmAuthProbe role="implementer" method="api-key" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.implementer).toMatchObject({
        tool: 'codex',
        authChannel: 'api-key',
      });
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('authChannel');
    ui.unmount();
  });
});
