import { describe, expect, it } from 'vitest';
import { phaseStage } from '../../core/rail-stages.js';
import { queueCopy } from './queue-copy.js';

describe('queueCopy', () => {
  it.each([0, 1, 2])('owns clear feedback and transcript copy for %s messages', (count) => {
    const copy = queueCopy({ seat: null, count });
    expect(copy.clearFeedback).toBe(
      count === 0
        ? 'Queue is already empty'
        : `Cleared ${count} queued ${count === 1 ? 'message' : 'messages'}`,
    );
    expect(copy.cleared).toEqual({
      label: 'Queue cleared',
      value: `${count} pending ${count === 1 ? 'message' : 'messages'} removed`,
    });
  });

  it('uses the byline copy for /queue and names an empty queue', () => {
    const copy = queueCopy({ seat: 'build', taskId: 'T003', count: 2 });
    expect(copy.summary).toBe(copy.byline);
    expect(queueCopy({ seat: null, count: 2 }).summary).toBe('2 queued');
    expect(queueCopy({ seat: 'build', count: 0 }).summary).toBe('Queue is empty');
  });

  it.each([
    ['build', 'BUILD on T003'],
    ['plan', 'PLAN'],
    ['review', 'REVIEW'],
  ] as const)('names the next tool boundary on every steerable %s surface', (seat, target) => {
    expect(queueCopy({ seat, taskId: 'T003', steerable: true })).toMatchObject({
      placeholder: `Message ${target} · read after this tool…`,
      byline: `1 queued for ${target}`,
      shortByline: '1 queued',
      summary: `1 queued for ${target}`,
      feedback: `Sent to ${target} · read after this tool · ctrl+⏎ interrupts`,
      queued: { label: 'Queued', value: `for ${target} · read after this tool` },
      delivered: { label: 'Delivered', value: `to ${target}` },
    });
  });

  it.each(['build', 'plan', 'review'] as const)(
    'keeps queue copy for a non-steerable %s call',
    (seat) => {
      expect(queueCopy({ seat, taskId: 'T003', steerable: false })).toEqual(
        queueCopy({ seat, taskId: 'T003' }),
      );
    },
  );

  it.each([
    ['build', 'BUILD on T003'],
    ['plan', 'PLAN'],
    ['review', 'REVIEW'],
  ] as const)('names mid-call delivery to %s after its call detaches', (seat, target) => {
    for (const count of [1, 2]) {
      expect(
        queueCopy({ seat, taskId: 'T003', count, steerable: false, via: 'mid-call' }).delivered,
      ).toEqual({
        label: 'Delivered',
        value: `${count > 1 ? '2 messages ' : ''}mid-call to ${target}`,
      });
    }
  });

  it.each([
    {
      seat: 'build',
      taskId: 'T003',
      placeholder: 'Message BUILD on T003 · read when its call ends…',
      byline: '1 queued for BUILD on T003',
      shortByline: '1 queued',
      summary: '1 queued for BUILD on T003',
      feedback: 'Queued for BUILD on T003 · ctrl+⏎ sends now',
      queued: { label: 'Queued', value: 'for BUILD on T003 · read when its call ends' },
      delivered: { label: 'Delivered', value: 'to BUILD on T003' },
    },
    {
      seat: 'plan',
      taskId: undefined,
      placeholder: 'Message PLAN · read at its next call…',
      byline: '1 queued for PLAN',
      shortByline: '1 queued',
      summary: '1 queued for PLAN',
      feedback: 'Queued for PLAN · ctrl+⏎ sends now',
      queued: { label: 'Queued', value: 'for PLAN · read at its next call' },
      delivered: { label: 'Delivered', value: 'to PLAN' },
    },
    {
      seat: 'review',
      taskId: undefined,
      placeholder: 'Message REVIEW · read at its verdict call…',
      byline: '1 queued for REVIEW',
      shortByline: '1 queued',
      summary: '1 queued for REVIEW',
      feedback: 'Queued for REVIEW · ctrl+⏎ sends now',
      queued: { label: 'Queued', value: 'for REVIEW · read at its verdict call' },
      delivered: { label: 'Delivered', value: 'to REVIEW' },
    },
  ] as const)('names $seat consistently on all four surfaces', ({ seat, taskId, ...expected }) => {
    expect(queueCopy({ seat, taskId })).toMatchObject(expected);
  });

  it.each([
    ['planning', 'PLAN', 'read at its next call'],
    ['implementing', 'BUILD', 'read when its call ends'],
    ['final-review', 'REVIEW', 'read at its verdict call'],
  ] as const)('renders an old %s event without seat or taskId', (phase, label, timing) => {
    const seat = phaseStage(phase);
    if (seat === null) throw new Error('Expected an active rail stage');
    const copy = queueCopy({ seat });
    expect(copy.placeholder).toBe(`Message ${label} · ${timing}…`);
    expect(copy.byline).toBe(`1 queued for ${label}`);
    expect(copy.feedback).toBe(`Queued for ${label} · ctrl+⏎ sends now`);
    expect(copy.queued).toEqual({ label: 'Queued', value: `for ${label} · ${timing}` });
    expect(copy.delivered).toEqual({ label: 'Delivered', value: `to ${label}` });
  });

  it('names the count only when more than one message is delivered', () => {
    const copy = queueCopy({ seat: 'build', taskId: 'T003', count: 2 });
    expect(copy.byline).toBe('2 queued for BUILD on T003');
    expect(copy.shortByline).toBe('2 queued');
    expect(copy.delivered).toEqual({ label: 'Delivered', value: '2 messages to BUILD on T003' });
  });

  it.each(['plan', 'review'] as const)('keeps a stale brief id out of the %s copy', (seat) => {
    expect(queueCopy({ seat, taskId: 'T003' })).toEqual(queueCopy({ seat }));
  });

  it('keeps generic transcript labels when an old event has no receiving seat', () => {
    const copy = queueCopy({ seat: null });
    expect(copy.queued).toEqual({ label: 'Queued', value: undefined });
    expect(copy.delivered).toEqual({ label: 'Delivered', value: undefined });
  });
});
