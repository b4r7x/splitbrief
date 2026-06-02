import { describe, it, expect, beforeEach } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { createOtelSink } from './otel.js';
import { taskId } from '../../../core/schemas/task.js';

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
    const workflow = spans.find((s) => s.name === 'diptych.workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.attributes['diptych.feature']).toBe('add x');
    expect(workflow?.status.code).toBe(SpanStatusCode.OK);
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

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'diptych.workflow');
    expect(workflow?.attributes['diptych.mode']).toBe('standard');
    expect(workflow?.attributes['diptych.planner.tool']).toBe('claude-code');
    expect(workflow?.attributes['diptych.planner.model']).toBe('opus');
    expect(workflow?.attributes['diptych.implementer.tool']).toBe('ollama');
    expect(workflow?.attributes['diptych.implementer.model']).toBe('llama3');
  });

  it('emits a phase span nested under workflow when planner_status running fires', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'researching', status: 'running' });
    sink({ type: 'planner_status', ts: 50, phase: 'researching', status: 'done', duration: 48 });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const phase = spans.find((s) => s.name === 'diptych.phase.researching');
    const workflow = spans.find((s) => s.name === 'diptych.workflow');
    expect(phase).toBeDefined();
    expect(phase?.attributes['diptych.phase.duration_ms']).toBe(48);
    expect(phase?.parentSpanContext?.spanId).toBe(workflow?.spanContext().spanId);
  });

  it('transitions phase spans when a new phase begins', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'researching', status: 'running' });
    sink({ type: 'planner_status', ts: 3, phase: 'specifying', status: 'running' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    expect(spans.find((s) => s.name === 'diptych.phase.researching')).toBeDefined();
    expect(spans.find((s) => s.name === 'diptych.phase.specifying')).toBeDefined();
  });

  it('emits a task span nested under phase on task_started → task_completed', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T1'),
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
      taskId: taskId('T1'),
      title: 'Add foo',
      method: 'local',
      retries: 0,
      duration: 40,
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const spans = exporter.getFinishedSpans();
    const task = spans.find((s) => s.name === 'diptych.task');
    const phase = spans.find((s) => s.name === 'diptych.phase.implementing');
    expect(task).toBeDefined();
    expect(task?.attributes['diptych.task.id']).toBe('T1');
    expect(task?.attributes['diptych.task.title']).toBe('Add foo');
    expect(task?.attributes['diptych.task.file']).toBe('a.ts');
    expect(task?.attributes['diptych.task.action']).toBe('create');
    expect(task?.attributes['diptych.task.method']).toBe('local');
    expect(task?.attributes['diptych.task.retries']).toBe(0);
    expect(task?.attributes['diptych.task.duration_ms']).toBe(40);
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
      taskId: taskId('T2'),
      title: 'Modify bar',
      index: 0,
      total: 1,
      file: 'b.ts',
      action: 'modify',
    });
    sink({ type: 'task_full_fail', ts: 50, phase: 'implementing', taskId: taskId('T2') });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const task = exporter.getFinishedSpans().find((s) => s.name === 'diptych.task');
    expect(task?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('marks task span with skip_reason on task_skipped', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T3'),
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
      taskId: taskId('T3'),
      title: 'Old task',
      reason: 'already done',
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const task = exporter.getFinishedSpans().find((s) => s.name === 'diptych.task');
    expect(task?.attributes['diptych.task.skip_reason']).toBe('already done');
  });

  it('records workflow_cancelled with ERROR status on all open spans', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'task_started',
      ts: 10,
      phase: 'implementing',
      taskId: taskId('T4'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'd.ts',
      action: 'create',
    });
    sink({ type: 'workflow_cancelled', ts: 50, phase: 'implementing' });

    const spans = exporter.getFinishedSpans();
    const workflow = spans.find((s) => s.name === 'diptych.workflow');
    const task = spans.find((s) => s.name === 'diptych.task');
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

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'diptych.workflow');
    expect(workflow?.attributes['diptych.cost.input_tokens']).toBe(310);
    expect(workflow?.attributes['diptych.cost.output_tokens']).toBe(135);
  });

  it('adds validate span event on validate done', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'planner_status', ts: 2, phase: 'implementing', status: 'running' });
    sink({
      type: 'validate',
      ts: 30,
      phase: 'implementing',
      taskId: taskId('T5'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const phase = exporter.getFinishedSpans().find((s) => s.name === 'diptych.phase.implementing');
    const validateEvent = phase?.events.find((e) => e.name === 'diptych.validate');
    expect(validateEvent).toBeDefined();
    expect(validateEvent?.attributes?.['diptych.validate.passed']).toBe(true);
  });

  it('records error events as exceptions on workflow span', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'error', ts: 10, phase: 'idle', message: 'something broke' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'diptych.workflow');
    expect(workflow?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('records warning events as span events on workflow span', () => {
    const sink = createOtelSink({ provider });
    sink({ type: 'workflow_started', ts: 1, phase: 'idle', feature: 'x' });
    sink({ type: 'warning', ts: 10, phase: 'idle', message: 'watch out' });
    sink({ type: 'workflow_complete', ts: 100, phase: 'complete' });

    const workflow = exporter.getFinishedSpans().find((s) => s.name === 'diptych.workflow');
    expect(workflow?.events.some((e) => e.name === 'diptych.warning')).toBe(true);
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
});
