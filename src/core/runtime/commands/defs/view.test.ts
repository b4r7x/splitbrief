import { describe, it, expect } from 'vitest';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
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
