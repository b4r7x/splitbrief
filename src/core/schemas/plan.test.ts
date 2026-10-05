import { describe, expect, it } from 'vitest';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { PlanAnswerSchema, PlanSchema } from './plan.js';
import { TaskSchema } from './task.js';

describe('PlanAnswerSchema', () => {
  it('parses a questions answer and a plan answer', () => {
    const questions = {
      result: {
        kind: 'questions',
        questions: [{ id: 'Q1', text: 'Which name?', choices: null, default: 'World' }],
      },
    };
    expect(PlanAnswerSchema.parse(questions)).toEqual(questions);
    const plan = { result: makePlanProposal() };
    expect(PlanAnswerSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it('refuses a task id outside TNNN, a task with no suggested file and a fourth question', () => {
    const plan = makePlanProposal();
    const badId = { result: { ...plan, tasks: [{ ...plan.tasks[0], id: 'task-1' }] } };
    expect(PlanAnswerSchema.safeParse(badId).success).toBe(false);
    const noFile = { result: { ...plan, tasks: [{ ...plan.tasks[0], suggestedFiles: [] }] } };
    expect(PlanAnswerSchema.safeParse(noFile).success).toBe(false);
    const question = { id: 'Q', text: 'Q?', choices: null, default: 'yes' };
    const four = { result: { kind: 'questions', questions: Array(4).fill(question) } };
    expect(PlanAnswerSchema.safeParse(four).success).toBe(false);
  });

  it('spells every task path as the write gate spells a changed file', () => {
    const plan = makePlanProposal({
      tasks: [
        makeTaskSpec({
          suggestedFiles: ['./src/hello.ts'],
          contextFiles: ['src/../src/types.ts'],
          protectedOperations: [{ path: 'src/../package.json', operation: 'write' }],
        }),
      ],
    });

    expect(PlanAnswerSchema.parse({ result: plan }).result).toMatchObject({
      tasks: [
        {
          suggestedFiles: ['src/hello.ts'],
          contextFiles: ['src/types.ts'],
          protectedOperations: [{ path: 'package.json', operation: 'write' }],
        },
      ],
    });
  });

  it('refuses a question whose default is empty or is not one of its choices', () => {
    const answer = (question: object) => ({ result: { kind: 'questions', questions: [question] } });
    const choice = { id: 'Q1', text: 'Which store?', choices: ['redis', 'memory'] };
    expect(PlanAnswerSchema.safeParse(answer({ ...choice, default: 'memory' })).success).toBe(true);
    expect(PlanAnswerSchema.safeParse(answer({ ...choice, default: 'sqlite' })).success).toBe(
      false,
    );
    const input = { id: 'Q2', text: 'Name?', choices: null };
    expect(PlanAnswerSchema.safeParse(answer({ ...input, default: 'World' })).success).toBe(true);
    expect(PlanAnswerSchema.safeParse(answer({ ...input, default: '' })).success).toBe(false);
  });
});

describe('PlanSchema', () => {
  it('keeps the run-level plan without the tasks', () => {
    const plan = PlanSchema.parse(makePlanProposal());
    expect(Object.keys(plan).sort()).toEqual([
      'checks',
      'criteria',
      'decisions',
      'summary',
      'validation',
    ]);
  });

  it('loads a plain decision as an entry with no task, and keeps a task id it already has', () => {
    const loaded = PlanSchema.parse(
      makePlanProposal({ decisions: ['Keep the greeting in one module'] }),
    );
    expect(loaded.decisions).toEqual([{ text: 'Keep the greeting in one module', taskId: null }]);

    const ledger = PlanSchema.parse({
      ...makePlanProposal(),
      decisions: [{ text: 'Use node:crypto — the dependency is standard', taskId: 'T003' }],
    });
    expect(ledger.decisions).toEqual([
      { text: 'Use node:crypto — the dependency is standard', taskId: 'T003' },
    ]);
  });
});

describe('TaskSchema', () => {
  it('still parses a task with only the old fields', () => {
    const legacy = {
      id: 'T001',
      title: 'Create hello module',
      action: 'create',
      file: 'src/hello.ts',
      dependsOn: [],
      description: 'Create a hello world module',
      tests: [],
      constraints: [],
      typeDefs: '',
      implementationSteps: [],
      status: 'pending',
    };
    expect(TaskSchema.parse(legacy)).toEqual(legacy);
  });
});
