import { describe, it, expect, vi } from 'vitest';
import { workflowCommands } from './workflow.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

function command(name: string, overrides: Parameters<typeof makeCtx>[0] = {}) {
  const found = workflowCommands(makeCtx(overrides)).find((cmd) => cmd.name === name);
  if (found?.kind !== 'noarg') throw new Error(`${name} is not a no-argument command`);
  return found;
}

function argCommand(name: string, overrides: Parameters<typeof makeCtx>[0] = {}) {
  const found = workflowCommands(makeCtx(overrides)).find((cmd) => cmd.name === name);
  if (found?.kind !== 'arg') throw new Error(`${name} is not an argument command`);
  return found;
}

describe('/resume', () => {
  it('is offered only while a run is live', () => {
    const resume = command('/resume');

    expect(
      resume.guard?.({
        phase: 'implementing',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      resume.guard?.({
        phase: 'idle',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBe('No run to resume in this phase');
  });

  it('is offered on an open run at rest, whatever phase it stopped in', () => {
    const resume = command('/resume');

    expect(
      resume.guard?.({
        phase: 'reviewing-spec',
        plannerSupportsImages: true,
        openRunAtRest: true,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      resume.guard?.({
        phase: 'reviewing-spec',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBe('No run to resume in this phase');
  });

  it('continues the run through the resume port', async () => {
    const resumeRun = vi.fn(() => true);
    const errors: string[] = [];

    await command('/resume', { resumeRun, setFeedbackError: (m) => errors.push(m) }).handler();

    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('says so when nothing is parked or saved', async () => {
    const errors: string[] = [];

    await command('/resume', {
      resumeRun: () => false,
      setFeedbackError: (m) => errors.push(m),
    }).handler();

    expect(errors).toEqual(['Nothing to resume.']);
  });
});

describe('/steer', () => {
  it('is offered while a run is live or at rest', () => {
    const steer = argCommand('/steer');

    expect(
      steer.guard?.({
        phase: 'implementing',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      steer.guard?.({
        phase: 'reviewing-plan',
        plannerSupportsImages: true,
        openRunAtRest: true,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      steer.guard?.({
        phase: 'idle',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBe('No run to steer in this phase');
  });

  it('stops now and continues with the correction through the steer port', async () => {
    const steerRun = vi.fn(() => true);
    const errors: string[] = [];

    await argCommand('/steer', { steerRun, setFeedbackError: (m) => errors.push(m) }).handler(
      'focus on retries',
    );

    expect(steerRun).toHaveBeenCalledWith('focus on retries');
    expect(errors).toEqual([]);
  });

  it('asks for a correction when the text is blank', async () => {
    const steerRun = vi.fn(() => true);
    const errors: string[] = [];

    await argCommand('/steer', { steerRun, setFeedbackError: (m) => errors.push(m) }).handler('  ');

    expect(steerRun).not.toHaveBeenCalled();
    expect(errors).toEqual(['Usage: /steer <correction>']);
  });
});

describe('/end', () => {
  // One line serves an open run, whose changes End run keeps, and a ready run, which it discards.
  it('promises no change on disk that End run on a ready run puts in run.patch instead', () => {
    expect(command('/end').description).toBe('Close the run, saving unapplied changes');
  });

  it('is offered only while a run is live', () => {
    const end = command('/end');

    expect(
      end.guard?.({
        phase: 'implementing',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      end.guard?.({
        phase: 'complete',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBe('No run to end in this phase');
  });

  it('is offered on an open run at rest, whatever phase it stopped in', () => {
    const end = command('/end');

    expect(
      end.guard?.({
        phase: 'reviewing-spec',
        plannerSupportsImages: true,
        openRunAtRest: true,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBeUndefined();
    expect(
      end.guard?.({
        phase: 'reviewing-spec',
        plannerSupportsImages: true,
        openRunAtRest: false,
        applyUnfinished: false,
        applying: false,
      }),
    ).toBe('No run to end in this phase');
  });

  it('is not offered on a run at rest whose Apply did not finish', () => {
    expect(
      command('/end').guard?.({
        phase: 'complete',
        plannerSupportsImages: true,
        openRunAtRest: true,
        applyUnfinished: true,
        applying: false,
      }),
    ).toBe('Apply did not finish. Restore or retry Apply first, then end the run.');
  });

  it('ends the run through the end port', async () => {
    const endRun = vi.fn(() => true);

    await command('/end', { endRun }).handler();

    expect(endRun).toHaveBeenCalledTimes(1);
  });

  it('says so when there is no run to end', async () => {
    const errors: string[] = [];

    await command('/end', {
      endRun: () => false,
      setFeedbackError: (m) => errors.push(m),
    }).handler();

    expect(errors).toEqual(['No active run to end.']);
  });
});
