import { join } from 'node:path';
import type { Command } from 'commander';
import ansis from 'ansis';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
  type EffectiveConfigWarning,
} from '../../core/config/runtime/effective-config.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides/schema.js';
import {
  REVIEWS_DIR,
  REVIEW_FILE,
  SPLITBRIEF_DIR,
  isInternalGitStatusPath,
} from '../../core/paths.js';
import { parseFinalReview } from '../../engine/parsers/final-review.js';
import { createReviewer } from '../../engine/runners/factory.js';
import { prepareReviewExecution } from '../../engine/runners/prepare-execution/prepare-execution.js';
import { createCustomRunnerRuntime } from '../../engine/runners/custom-runner-runtime.js';
import type { ArtifactApprovalReview } from '../../engine/runners/types.js';
import { buildFinalReviewPrompt, truncateDiffForPrompt } from '../../engine/spec/prompts/review.js';
import { confinedWriteFile } from '../../lib/confined-fs.js';
import { getCurrentDiff, getDiffSince } from '../../lib/git/diff.js';
import { sanitizeTerminalDisplayText, stripTerminalControls } from '../../utils/display-text.js';
import {
  promptCustomRunnerArtifactApproval,
  promptCustomRunnerDisclosure,
} from '../custom-runner-prompts.js';
import { withCliErrors } from '../errors.js';
import {
  ALLOW_REPO_RUNNERS_HELP,
  parseGitRefOption,
  parseSeatSpecOption,
  type SeatSpec,
} from '../options.js';
import { canonicalizeProjectDir, ensureGitAndConfig, loadConfigOrExit } from '../setup.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from './start/readiness.js';

const NO_SPECIFICATION =
  'none — review for correctness, scope creep, and test coverage of the diff';
const NO_TASK_BRIEFS = 'none — this review has no briefs; the diff below is the whole subject';
const NOTHING_TO_REVIEW = 'nothing to review';

type ReviewOpts = {
  project?: string;
  reviewer?: SeatSpec;
  base?: string;
  allowRepoRunners: boolean;
  allowUnverifiedAuth: boolean;
};

interface ReviewCommandDeps {
  createReviewer?: typeof createReviewer | undefined;
  prepareReviewExecution?: typeof prepareReviewExecution | undefined;
  promptCustomRunnerArtifactApproval?: typeof promptCustomRunnerArtifactApproval | undefined;
}

function reviewStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function seatOverrides(seat: SeatSpec | undefined): CLIOverrides {
  if (seat === undefined) return {};
  return {
    reviewer: { tool: seat.tool, ...(seat.model !== undefined && { model: seat.model }) },
    ...(seat.effort !== undefined && { reviewerEffort: seat.effort }),
  };
}

function printReview(text: string, relativePath: string): void {
  const parsed = parseFinalReview(text);
  console.log(`\n${ansis.bold('Verdict:')} ${parsed.verdict ?? 'not reported'}`);
  for (const finding of parsed.findings) {
    console.log(`  ${finding.severity}: ${stripTerminalControls(finding.text)}`);
  }
  console.log(ansis.dim(relativePath));
}

export function registerReviewCommand(program: Command, deps: ReviewCommandDeps = {}): void {
  const createReviewerForCommand = deps.createReviewer ?? createReviewer;
  const prepareForCommand = deps.prepareReviewExecution ?? prepareReviewExecution;
  const promptForArtifactApproval =
    deps.promptCustomRunnerArtifactApproval ?? promptCustomRunnerArtifactApproval;
  program
    .command('review')
    .description('Review the working-tree diff in one reviewer call (no session, no planning)')
    .option(
      '--reviewer <spec>',
      'Reviewer seat as <tool>[:<model>][@<effort>] (default: the configured reviewer, or the planner)',
      parseSeatSpecOption,
    )
    .option(
      '--base <ref>',
      'Diff against this git ref instead of the working tree',
      parseGitRefOption,
    )
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--allow-repo-runners', ALLOW_REPO_RUNNERS_HELP, false)
    .option(
      '--allow-unverified-auth',
      'Allow a headless review when compatible CLI authentication is unverified',
      false,
    )
    .action(async (opts: ReviewOpts) => {
      const projectDir = await canonicalizeProjectDir(opts);
      await ensureGitAndConfig(projectDir);

      const baseRef = opts.base;
      const diff = truncateDiffForPrompt(
        baseRef === undefined
          ? await withCliErrors(() => getCurrentDiff(projectDir, isInternalGitStatusPath))
          : await withCliErrors(() => getDiffSince(projectDir, baseRef, isInternalGitStatusPath)),
      );
      if (diff.trim() === '') {
        console.log(NOTHING_TO_REVIEW);
        return;
      }

      const loaded = loadConfigOrExit(projectDir);
      // The review seat is named explicitly for this call: `resolveReviewerRunner`
      // decides it once — the configured block, or the planner holding the seat —
      // and preparation then admits it as the reviewer slot, so the factory has
      // one path to take and no second reading of `config.reviewer` exists.
      const declared = {
        ...loaded.config,
        reviewer: resolveReviewerRunner(loaded.config).runner,
      };
      const { config, warnings } = resolveEffectiveConfig({
        base: declared,
        overrides: seatOverrides(opts.reviewer),
        loaderDiagnostics: loaded.loaderDiagnostics,
      });
      emitEffectiveConfigWarnings([
        ...warnings,
        ...loaded.warnings.map(
          (message): EffectiveConfigWarning => ({ source: 'validation', message }),
        ),
      ]);

      const stamp = reviewStamp(new Date());
      const interaction = process.stdin.isTTY ? 'interactive' : 'headless';
      const policy = cliPreparationPolicy({
        purpose: 'review',
        interaction,
        opts: {
          allowRepoRunners: opts.allowRepoRunners,
          allowUnverifiedAuth: opts.allowUnverifiedAuth,
        },
        onTieredApproval: (request) => promptCustomRunnerDisclosure({ request }),
      });
      const execution = preparedExecutionOrThrow(
        await prepareForCommand({
          projectDir,
          effectiveConfig: config,
          policy,
          signal: new AbortController().signal,
        }),
        'prose',
      );

      const reviewer = await createReviewerForCommand(execution.config, {
        preparedConfig: execution.config,
        preparationId: execution.preparationId,
        gates: execution.gates,
        slot: { role: 'reviewer' },
        customRuntime: createCustomRunnerRuntime({
          projectDir,
          sessionId: `review-${stamp}`,
          sweepStaleReviews: false,
          admission: policy,
          // A headless review reaches this gate only for a runner
          // `prepareCustomRunnerAdmission` already admitted, which headless
          // requires an explicit grant for — `--allow-repo-runners`, or the
          // owner-only trust receipt an earlier interactive confirmation wrote.
          // That consent covers the artifact this runner declares, so there is
          // no second prompt to give.
          onArtifactApproval: (_type: 'artifact', review: ArtifactApprovalReview) =>
            interaction === 'interactive'
              ? promptForArtifactApproval(review)
              : Promise.resolve({ approved: true as const }),
        }),
      });

      const seat = resolveReviewerRunner(execution.config);
      const subject =
        baseRef === undefined
          ? 'the working tree'
          : `changes since ${stripTerminalControls(baseRef)}`;
      console.log(`Reviewing ${subject} (reviewer: ${getRunnerCatalogDisplayName(seat.runner)})\n`);

      const result = await withCliErrors(() =>
        reviewer.review(
          buildFinalReviewPrompt({ spec: NO_SPECIFICATION, taskBriefs: NO_TASK_BRIEFS, diff }),
          projectDir,
          {
            onOutput(text: string) {
              process.stdout.write(sanitizeTerminalDisplayText(text, { preserveLineBreaks: true }));
            },
          },
        ),
      );

      const relativePath = join(SPLITBRIEF_DIR, REVIEWS_DIR, stamp, REVIEW_FILE);
      confinedWriteFile(projectDir, relativePath, result.text);
      printReview(result.text, relativePath);
    });
}
