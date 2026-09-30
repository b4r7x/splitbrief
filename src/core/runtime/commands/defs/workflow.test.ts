import { describe, it, expect, vi } from 'vitest';
import { workflowCommands } from './workflow.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';

function command(name: string, overrides: Parameters<typeof makeCtx>[0] = {}) {
  const found = workflowCommands(makeCtx(overrides)).find((cmd) => cmd.name === name);
  if (found?.kind !== 'noarg') throw new Error(`${name} is not a no-argument command`);
  return found;
}

describe('/resume', () => {
  it('is offered only while a run is live', () => {
    const resume = command('/resume');

    expect(
      resume.guard?.({ phase: 'implementing', plannerSupportsImages: true, openRunAtRest: false }),
    ).toBeUndefined();
    expect(
      resume.guard?.({ phase: 'idle', plannerSupportsImages: true, openRunAtRest: false }),
    ).toBe('No run to resume in this phase');
  });

  it('is offered on an open run at rest, whatever phase it stopped in', () => {
    const resume = command('/resume');

    expect(
      resume.guard?.({ phase: 'reviewing-spec', plannerSupportsImages: true, openRunAtRest: true }),
    ).toBeUndefined();
    expect(
      resume.guard?.({
        phase: 'reviewing-spec',
        plannerSupportsImages: true,
        openRunAtRest: false,
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

describe('/end', () => {
  it('is offered only while a run is live', () => {
    const end = command('/end');

    expect(
      end.guard?.({ phase: 'implementing', plannerSupportsImages: true, openRunAtRest: false }),
    ).toBeUndefined();
    expect(
      end.guard?.({ phase: 'complete', plannerSupportsImages: true, openRunAtRest: false }),
    ).toBe('No run to end in this phase');
  });

  it('is offered on an open run at rest, whatever phase it stopped in', () => {
    const end = command('/end');

    expect(
      end.guard?.({ phase: 'reviewing-spec', plannerSupportsImages: true, openRunAtRest: true }),
    ).toBeUndefined();
    expect(
      end.guard?.({ phase: 'reviewing-spec', plannerSupportsImages: true, openRunAtRest: false }),
    ).toBe('No run to end in this phase');
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
