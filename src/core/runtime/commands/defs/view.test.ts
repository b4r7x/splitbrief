import { describe, it, expect } from 'vitest';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import { ALL_SCREENS } from '../../../navigation/types.js';
import { viewCommands } from './view.js';

function tasksCommand(ctx: ReturnType<typeof makeCtx>) {
  const cmd = viewCommands(ctx).find((c) => c.name === '/tasks');
  if (cmd?.kind !== 'noarg') throw new Error('/tasks is not a no-argument command');
  return cmd;
}

describe('viewCommands /tasks', () => {
  it('opens the sidebar above the breakpoint and prints the list below it', () => {
    let visible = false;
    const wideMessages: string[] = [];
    const wide = makeCtx({
      toggleSidebar: () => {
        visible = !visible;
        return { status: 'toggled', visible };
      },
      setFeedbackMessage: (msg) => wideMessages.push(msg),
    });

    tasksCommand(wide).handler();

    expect(visible).toBe(true);
    expect(wideMessages).toEqual(['Brief list shown']);

    const narrowMessages: string[] = [];
    const narrowErrors: string[] = [];
    const narrow = makeCtx({
      toggleSidebar: () => ({
        status: 'unavailable',
        message: 'Sidebar is hidden on small terminals.',
      }),
      listBriefs: () => [
        { id: 'T001', status: 'done' },
        { id: 'T002', status: 'in_progress' },
        { id: 'T003', status: 'escalated' },
        { id: 'T004', status: 'pending' },
      ],
      setFeedbackMessage: (msg) => narrowMessages.push(msg),
      setFeedbackError: (msg) => narrowErrors.push(msg),
    });

    tasksCommand(narrow).handler();

    expect(narrowMessages).toEqual([
      'Briefs: T001 passed, T002 running, T003 escalated, T004 queued',
    ]);
    expect(narrowErrors).toEqual([]);
  });

  it('leaves an already-open sidebar open', () => {
    let visible = true;
    const ctx = makeCtx({
      toggleSidebar: () => {
        visible = !visible;
        return { status: 'toggled', visible };
      },
    });

    tasksCommand(ctx).handler();

    expect(visible).toBe(true);
  });

  it('says the plan is empty below the breakpoint when no brief exists yet', () => {
    const messages: string[] = [];
    const ctx = makeCtx({
      toggleSidebar: () => ({
        status: 'unavailable',
        message: 'Sidebar is hidden on small terminals.',
      }),
      listBriefs: () => [],
      setFeedbackMessage: (msg) => messages.push(msg),
    });

    tasksCommand(ctx).handler();

    expect(messages).toEqual(['No briefs planned yet']);
  });
});

describe('viewCommands /usage', () => {
  function usageCommand(ctx: ReturnType<typeof makeCtx>) {
    const matches = viewCommands(ctx).filter((c) => c.name === '/usage');
    expect(matches).toHaveLength(1);
    const cmd = matches[0];
    if (cmd?.kind !== 'noarg') throw new Error('/usage is not a no-argument command');
    return cmd;
  }

  it('opens the usage destination and nothing else', () => {
    const opened: Array<{ type: string; focus: string | undefined }> = [];
    const messages: string[] = [];
    const errors: string[] = [];
    const ctx = makeCtx({
      openOverlay: (type, focus) => opened.push({ type, focus }),
      setFeedbackMessage: (msg) => messages.push(msg),
      setFeedbackError: (msg) => errors.push(msg),
    });

    usageCommand(ctx).handler();

    expect(opened).toEqual([{ type: 'usage-details', focus: undefined }]);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('lives on the workflow alone, where the run whose usage it shows lives', async () => {
    const offWorkflow = ALL_SCREENS.filter((screen) => screen !== 'workflow');
    expect(usageCommand(makeCtx({})).validScreens).toEqual(['workflow']);
    expect(offWorkflow).not.toEqual([]);

    for (const screen of offWorkflow) {
      const opened: string[] = [];
      const errors: string[] = [];
      await runCommandInTest({
        commands: viewCommands(makeCtx({ openOverlay: (type) => opened.push(type) })),
        raw: '/usage',
        screen,
        onError: (msg) => errors.push(msg),
      });

      expect(opened, screen).toEqual([]);
      expect(errors, screen).toEqual(['/usage is only available on the workflow screen.']);
    }
  });
});
