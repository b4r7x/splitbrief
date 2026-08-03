import { describe, it, expect, beforeEach } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { createOtelSink } from './otel.js';
import { taskId } from '../../../core/schemas/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';

describe('createOtelSink', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  });

  it('emits a workflow root span on workflow_started → workflow_complete', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'researching', feature: 'add x' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const workflow = spans.find((s) => s.name === 'splitbrief.workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.attributes['splitbrief.feature']).toBe('add x');
    expect(workflow?.status.code).toBe(SpanStatusCode.OK);
  });

  it('redacts secrets from the feature span attribute', () => {
    const sink = createOtelSink({ provider });
    sink({
      type: 'workflow_started',
      ts: 1,
      phase: 'researching',
      feature: 'use sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa for auth',
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.workflow');
    expect(workflow?.attributes['splitbrief.feature']).not.toContain(
      'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(workflow?.attributes['splitbrief.feature']).toContain('***REDACTED***');
  });

  it('replaces the feature span attribute when transcript persistence is disabled', () => {
    const sink = createOtelSink({ provider, persistTranscript: false });
    sink({
      type: 'workflow_started',
      ts: 1,
      phase: 'researching',
      feature: 'secret feature prompt',
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.workflow');
    expect(workflow?.attributes['splitbrief.feature']).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(JSON.stringify(workflow?.attributes)).not.toContain('secret feature prompt');
  });

  it('sets workflow_config attributes on the workflow span', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'workflow_config',
      ts: 2,
      phase: 'idle',
      mode: 'standard',
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      implementerTool: 'ollama',
      implementerModel: 'llama3',
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.workflow');
    expect(workflow?.attributes['splitbrief.mode']).toBe('standard');
    expect(workflow?.attributes['splitbrief.planner.tool']).toBe('claude-code');
    expect(workflow?.attributes['splitbrief.planner.model']).toBe('opus');
    expect(workflow?.attributes['splitbrief.implementer.tool']).toBe('ollama');
    expect(workflow?.attributes['splitbrief.implementer.model']).toBe('llama3');
  });

  it('opens the researching phase span on a fresh run with duration when workflow_started precedes planner_status running and done', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'researching', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'researching', status: 'running' });
    sink({ type: 'planner_status', ts: 50, phase: 'researching', status: 'done', duration: 48 });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const phase = spans.find((s) => s.name === 'splitbrief.phase.researching');
    const workflow = spans.find((s) => s.name === 'splitbrief.workflow');
    expect(phase).toBeDefined();
    expect(phase?.attributes['splitbrief.phase.duration_ms']).toBe(48);
    expect(phase?.parentSpanContext?.spanId).toBe(workflow?.spanContext().spanId);
  });

  it('drops the researching phase span when the first planner_status running precedes workflow_started', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'planner_status', ts: 1, phase: 'researching', status: 'running' });
    sink({ type: 'workflow_started', ts: 2, phase: 'researching', feature: 'x' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === 'splitbrief.phase.researching')).toBeUndefined();
  });

  it('transitions phase spans when a new phase begins', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'researching', status: 'running' });
    sink({ type: 'planner_status', ts: 3, phase: 'specifying', status: 'running' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === 'splitbrief.phase.researching')).toBeDefined();
    expect(spans.find((s) => s.name === 'splitbrief.phase.specifying')).toBeDefined();
  });

  it('opens the implementing phase span in instant mode so the task parents under it, not researching', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'researching', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'researching', status: 'running' });
    sink({ type: 'planner_status', ts: 3, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'instant task',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 20,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'instant task',
      method: 'local',
      retries: 0,
      duration: 10,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const implementing = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    const researching = spans.find((s) => s.name === 'splitbrief.phase.researching');
    const task = spans.find((s) => s.name === 'splitbrief.task');
    expect(implementing).toBeDefined();
    expect(task?.parentSpanContext?.spanId).toBe(implementing?.spanContext().spanId);
    expect(task?.parentSpanContext?.spanId).not.toBe(researching?.spanContext().spanId);
  });

  it('emits a task span nested under phase on task_started → task_completed', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Add foo',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 50,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Add foo',
      method: 'local',
      retries: 0,
      duration: 40,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const task = spans.find((s) => s.name === 'splitbrief.task');
    const phase = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    expect(task).toBeDefined();
    expect(task?.attributes['splitbrief.task.id']).toBe('T001');
    expect(task?.attributes['splitbrief.task.title']).toBe('Add foo');
    expect(task?.attributes['splitbrief.task.file']).toBe('a.ts');
    expect(task?.attributes['splitbrief.task.action']).toBe('create');
    expect(task?.attributes['splitbrief.task.method']).toBe('local');
    expect(task?.attributes['splitbrief.task.retries']).toBe(0);
    expect(task?.attributes['splitbrief.task.duration_ms']).toBe(40);
    expect(task?.status.code).toBe(SpanStatusCode.OK);
    expect(task?.parentSpanContext?.spanId).toBe(phase?.spanContext().spanId);
  });

  it('marks task span with ERROR status on task_full_fail', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'Modify bar',
      index: 0,
      total: 1,
      file: 'b.ts',
      action: 'modify',
    });
    sink({ type: 'task_full_fail', ts: 50, phase: 'implementing', taskId: taskId('T002') });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const task = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.task');
    expect(task?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('marks task span with skip_reason on task_skipped', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T003'),
      title: 'Old task',
      index: 0,
      total: 1,
      file: 'c.ts',
      action: 'create',
    });
    sink({
      type: 'task_skipped',
      ts: 30,
      phase: 'implementing',
      taskId: taskId('T003'),
      title: 'Old task',
      reason: 'already done',
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const task = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.task');
    expect(task?.attributes['splitbrief.task.skip_reason']).toBe('already done');
  });

  it('omits task prose attributes when transcript persistence is disabled', () => {
    const sentinel = 'otel-task-sentinel-34918';
    const sink = createOtelSink({ provider, persistTranscript: false });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T303'),
      title: `title ${sentinel}`,
      index: 0,
      total: 1,
      file: `src/${sentinel}.ts`,
      action: 'modify',
      routingReason: `route ${sentinel}`,
    });
    sink({
      type: 'task_skipped',
      ts: 30,
      phase: 'implementing',
      taskId: taskId('T303'),
      title: `skip ${sentinel}`,
      reason: `reason ${sentinel}`,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const task = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.task');
    expect(task?.attributes['splitbrief.task.id']).toBe('T303');
    expect(task?.attributes['splitbrief.task.index']).toBe(0);
    expect(task?.attributes['splitbrief.task.total']).toBe(1);
    expect(task?.attributes['splitbrief.task.title']).toBeUndefined();
    expect(task?.attributes['splitbrief.task.file']).toBeUndefined();
    expect(task?.attributes['splitbrief.task.action']).toBeUndefined();
    expect(task?.attributes['splitbrief.task.skip_reason']).toBeUndefined();
    expect(JSON.stringify(task?.attributes)).not.toContain(sentinel);
  });

  it('records workflow_cancelled with ERROR status on all open spans', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T004'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'd.ts',
      action: 'create',
    });
    sink({ type: 'workflow_cancelled', ts: 50, phase: 'implementing' });

    const spans = exporter.getFinishedSpans();
    const workflow = spans.find((s) => s.name === 'splitbrief.workflow');
    const task = spans.find((s) => s.name === 'splitbrief.task');
    expect(workflow?.status.code).toBe(SpanStatusCode.ERROR);
    expect(task?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('accumulates cost_update tokens on the workflow span', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'cost_update',
      ts: 20,
      phase: 'implementing',
      tokenUsage: {
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 200,
        implementerOutput: 80,
        escalationInput: 10,
        escalationOutput: 5,
      },
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.workflow');
    expect(workflow?.attributes['splitbrief.cost.input_tokens']).toBe(310);
    expect(workflow?.attributes['splitbrief.cost.output_tokens']).toBe(135);
  });

  it('adds validate span event on validate done', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'validate',
      ts: 30,
      phase: 'implementing',
      taskId: taskId('T005'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const phase = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'splitbrief.phase.implementing');
    const validateEvent = phase?.events.find((e) => e.name === 'splitbrief.validate');
    expect(validateEvent).toBeDefined();
    expect(validateEvent?.attributes?.['splitbrief.validate.passed']).toBe(true);
  });

  it('force-closes the workflow span and open children with ERROR on an error event without a trailing workflow_complete', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T300'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'd.ts',
      action: 'create',
    });
    sink({ type: 'error', ts: 20, phase: 'implementing', message: 'something broke' });

    const spans = exporter.getFinishedSpans();
    const workflow = spans.find((s) => s.name === 'splitbrief.workflow');
    const phase = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    const task = spans.find((s) => s.name === 'splitbrief.task');
    expect(workflow).toBeDefined();
    expect(workflow?.events.some((e) => e.name === 'exception')).toBe(true);
    expect(workflow?.status.code).toBe(SpanStatusCode.ERROR);
    expect(phase?.status.code).toBe(SpanStatusCode.ERROR);
    expect(task?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('does not reopen or re-end the workflow span when a workflow_complete trails an error', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'error', ts: 10, phase: 'idle', message: 'boom' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflows = exporter.getFinishedSpans().filter((s) => s.name === 'splitbrief.workflow');
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records warning events as span events on workflow span', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'warning', ts: 10, phase: 'idle', message: 'watch out' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.workflow');
    expect(workflow?.events.some((e) => e.name === 'splitbrief.warning')).toBe(true);
  });

  it('is a no-op before workflow_started', () => {
    const sink = createOtelSink({ provider });
    sink({
      type: 'cost_update',
      ts: 1,
      phase: 'idle',
      tokenUsage: {
        plannerInput: 1,
        plannerOutput: 1,
        implementerInput: 1,
        implementerOutput: 1,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('keeps runner-call child output out of traces without adding runner telemetry', () => {
    const childOutputCanary = 'custom-public-child-output-48152';
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'researching', feature: 'ordinary workflow' });
    sink({
      type: 'runner_call_text_delta',
      ts: 2,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: `helper output: ${childOutputCanary}`,
    });
    sink({ type: 'workflow_complete', ts: 3, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const serializedTraceData = JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
      })),
    );

    expect(serializedTraceData).not.toContain(childOutputCanary);
    expect(spans.map((span) => span.name)).toEqual(['splitbrief.workflow']);
    expect(spans.flatMap((span) => span.events)).toEqual([]);
  });

  it('opens a workflow span on workflow_resumed so a resumed run emits a non-empty trace', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_resumed', ts: 1, phase: 'implementing' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T100'),
      title: 'resumed task',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'modify',
    });
    sink({
      type: 'task_completed',
      ts: 20,
      phase: 'implementing',
      taskId: taskId('T100'),
      title: 'resumed task',
      method: 'local',
      retries: 0,
      duration: 10,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const workflow = spans.find((s) => s.name === 'splitbrief.workflow');
    const phase = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    const task = spans.find((s) => s.name === 'splitbrief.task');
    expect(workflow).toBeDefined();
    expect(phase?.parentSpanContext?.spanId).toBe(workflow?.spanContext().spanId);
    expect(task?.parentSpanContext?.spanId).toBe(phase?.spanContext().spanId);
  });

  it('emits a workflow root span for the resume sequence (planner_status running then workflow_resumed, no workflow_started)', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'planner_status', ts: 1, phase: 'implementing', status: 'running' });
    sink({ type: 'workflow_resumed', ts: 2, phase: 'implementing' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === 'splitbrief.workflow')).toBeDefined();
  });

  it('is a no-op when planner_status running fires before any workflow_started or workflow_resumed', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'planner_status', ts: 1, phase: 'implementing', status: 'running' });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('does not open a phase span for escalating and keeps post-escalation tasks under implementing', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({ type: 'planner_status', ts: 3, phase: 'escalating', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T200'),
      title: 'next task',
      index: 1,
      total: 2,
      file: 'b.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 20,
      phase: 'implementing',
      taskId: taskId('T200'),
      title: 'next task',
      method: 'local',
      retries: 0,
      duration: 10,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const implementing = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    const task = spans.find((s) => s.name === 'splitbrief.task');
    expect(spans.find((s) => s.name === 'splitbrief.phase.escalating')).toBeUndefined();
    expect(task?.parentSpanContext?.spanId).toBe(implementing?.spanContext().spanId);
  });

  it('keeps the implementing phase span open across an escalation while a task span is live and parents later tasks under implementing', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'first task',
      index: 0,
      total: 2,
      file: 'a.ts',
      action: 'create',
    });
    sink({ type: 'planner_status', ts: 12, phase: 'escalating', status: 'running' });

    expect(
      exporter.getFinishedSpans().find((s) => s.name === 'splitbrief.phase.implementing'),
    ).toBeUndefined();

    sink({
      type: 'task_completed',
      ts: 20,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'first task',
      method: 'local',
      retries: 0,
      duration: 10,
    });
    sink({
      type: 'task_started',
      ts: 22,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'second task',
      index: 1,
      total: 2,
      file: 'b.ts',
      action: 'modify',
    });
    sink({
      type: 'task_completed',
      ts: 30,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'second task',
      method: 'local',
      retries: 0,
      duration: 8,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const implementing = spans.find((s) => s.name === 'splitbrief.phase.implementing');
    const tasks = spans.filter((s) => s.name === 'splitbrief.task');
    const second = tasks.find((s) => s.attributes['splitbrief.task.id'] === 'T002');
    expect(spans.find((s) => s.name === 'splitbrief.phase.escalating')).toBeUndefined();
    expect(second?.parentSpanContext?.spanId).toBe(implementing?.spanContext().spanId);
  });
});
