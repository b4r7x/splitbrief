import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { projectDir } from '#testing/helpers/plan-checks.js';
import { NULL_CACHE } from '../../providers/model/runtime-snapshot.js';
import { refusedCheckErrors, renderCheckNotes } from './render-checks.js';

describe('refusedCheckErrors', () => {
  const approved = { npmScriptsApproved: true, projectDir, writtenFiles: [] };

  it('refuses a test check that holds a command', () => {
    expect(
      refusedCheckErrors(
        [{ id: 'K5', kind: 'test', value: 'node --test tests/truncate.test.js' }],
        { npmScriptsApproved: true, projectDir, writtenFiles: [] },
      ),
    ).toEqual([
      {
        code: 'refused-check-command',
        message:
          'Check K5 is refused: a `test` check names one test file, and `node --test tests/truncate.test.js` is not one file. Make it a `cmd` check that runs this command, or set its value to the test file.',
      },
    ]);
  });

  it.each([
    'npm run build -w packages/a',
    'npm run build --workspace=a',
    'npm run build --prefix packages/a',
    'npm run -w a build',
  ])('takes %j, whose option names another package.json', (value) => {
    expect(refusedCheckErrors([{ id: 'K6', kind: 'cmd', value }], approved)).toEqual([]);
  });

  it('judges the script of npm run when an option follows --', () => {
    expect(
      refusedCheckErrors([{ id: 'K6', kind: 'cmd', value: 'npm run lint -- --fix' }], approved),
    ).toEqual([
      {
        code: 'refused-check-command',
        message:
          "Check K6 is refused: `npm run lint -- --fix` runs an npm script, but package.json was not found. Name a script that package.json defines, or list package.json in the task's files and add the script there.",
      },
    ]);
  });

  it.each(['workflow-x,', 'Workflow X', 'workflow x'])(
    'refuses a render check whose value %j is not a scenario id',
    (value) => {
      expect(refusedCheckErrors([{ id: 'FC4', kind: 'render', value }], approved)).toEqual([
        {
          code: 'refused-check-command',
          message: `Check FC4 is refused: a \`render\` check names one scenario id of lowercase letters, digits and hyphens, and \`${value}\` is not one.`,
        },
      ]);
    },
  );

  it('takes a render check that names a scenario id', () => {
    expect(
      refusedCheckErrors([{ id: 'FC4', kind: 'render', value: 'workflow-x' }], approved),
    ).toEqual([]);
  });
});

describe('renderCheckNotes review seat', () => {
  const render = 'npm run tui-shots -- --scenario {id} --output {out}';
  const antigravity = { kind: 'cli', tool: 'antigravity' } as const;
  const plan = makePlanProposal({
    checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker' }],
    criteria: [{ id: 'C1', text: 'Greets', checkIds: ['K1', 'K-render'] }],
  });

  it('names a review seat that cannot see images when the plan has a render check', () => {
    expect(
      renderCheckNotes(
        plan,
        makeConfig({ reviewer: antigravity, validation: { render } }),
        NULL_CACHE,
      ),
    ).toEqual([
      'The review seat, Google Antigravity CLI, cannot see images. The criteria of render check K-render cannot pass with this seat. Change the review seat to a tool that reads images, or request changes to drop it.',
    ]);
  });

  it('puts the review seat note after the note for a missing validation.render', () => {
    const notes = renderCheckNotes(plan, makeConfig({ reviewer: antigravity }), NULL_CACHE);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Render check K-render needs validation\.render/);
    expect(notes[1]).toMatch(/^The review seat, Google Antigravity CLI, cannot see images\./);
  });

  // opencode 2.0.14 lists `opencode-go/qwen3.7-max` with input ["text"].
  it('names an OpenCode review seat whose model reads only text', () => {
    const cache = makeModelCacheAccessor({
      providerModels: { opencode: [{ id: 'opencode-go/qwen3.7-max', supportsImages: false }] },
    });
    const reviewer = { kind: 'cli', tool: 'opencode', model: 'opencode-go/qwen3.7-max' } as const;

    expect(renderCheckNotes(plan, makeConfig({ reviewer, validation: { render } }), cache)).toEqual(
      [
        'The review seat, OpenCode CLI, cannot see images. The criteria of render check K-render cannot pass with this seat. Change the review seat to a tool that reads images, or request changes to drop it.',
      ],
    );
  });

  it('has no review seat note for a review seat that sees images', () => {
    expect(
      renderCheckNotes(
        plan,
        makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' }, validation: { render } }),
        NULL_CACHE,
      ),
    ).toEqual([]);
  });

  it('has no review seat note when the plan has no render check', () => {
    expect(
      renderCheckNotes(
        makePlanProposal(),
        makeConfig({ reviewer: antigravity, validation: { render } }),
        NULL_CACHE,
      ),
    ).toEqual([]);
  });
});
