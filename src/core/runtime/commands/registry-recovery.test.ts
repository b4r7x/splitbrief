import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

type RewindCall = { target: string; comment: string | undefined };
type RedoCall = { taskId: string };

describe('/revise-spec command', () => {
  it('forwards target=spec and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (target, comment) => {
          rewinds.push({ target, comment });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-spec needs more detail',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(rewinds).toEqual([{ target: 'spec', comment: 'needs more detail' }]);
  });

  it('forwards target=spec with no comment when none is given', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (target, comment) => {
          rewinds.push({ target, comment });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-spec',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(rewinds).toEqual([{ target: 'spec', comment: undefined }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'researching',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-spec',
      screen: 'workflow',
      phase: 'researching',
      onError: (m) => {
        error = m;
      },
    });
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/revise/i);
  });

  it('surfaces a guard error when the engine rejects the rewind', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: () => false,
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-spec',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(error).toMatch(/cannot rewind|no active/i);
  });
});

describe('/revise-plan command', () => {
  it('forwards target=plan and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-plan too many tasks',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(rewinds).toEqual([{ target: 'plan', comment: 'too many tasks' }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'specifying',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/revise-plan',
      screen: 'workflow',
      phase: 'specifying',
      onError: (m) => {
        error = m;
      },
    });
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/revise/i);
  });
});

describe('/redo-task command', () => {
  it('forwards the task ID to the engine', () => {
    const redos: RedoCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/redo-task T001',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(redos).toEqual([{ taskId: 'T001' }]);
  });

  it('does NOT call the engine and surfaces a usage error when no task ID is given', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/redo-task',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });
    expect(redos).toEqual([]);
    expect(error).toMatch(/task id/i);
  });

  it('does NOT call the engine and surfaces a guard error when phase does not allow redo', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'planning',
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/redo-task T001',
      screen: 'workflow',
      phase: 'planning',
      onError: (m) => {
        error = m;
      },
    });
    expect(redos).toEqual([]);
    expect(error).toMatch(/redo/i);
  });
});
