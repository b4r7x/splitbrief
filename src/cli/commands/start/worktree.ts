import { withCliErrors } from '../../errors.js';
import { canonicalizeProjectDir } from '../../setup.js';
import { createWorktree } from '../../../engine/worktree/create.js';
import { removeWorktree } from '../../../engine/worktree/remove.js';
import { createGitClient } from '../../../lib/git/client.js';
import { slugify } from '../../../utils/slugify.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { generateOpaqueSessionSlug, MAX_SLUG_LENGTH } from '../../../core/sessions/lifecycle.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { CreatedWorktree } from './types.js';

export async function applyWorktreeOption(
  feature: string | undefined,
  opts: WorkflowOpts,
): Promise<CreatedWorktree | null> {
  if (opts.worktree === undefined) return null;

  const baseProjectDir = await canonicalizeProjectDir(opts);
  const persistTranscript = loadConfig(baseProjectDir).config.workflow.persistTranscript;
  const slug =
    typeof opts.worktree === 'string' && opts.worktree.length > 0
      ? opts.worktree
      : persistTranscript
        ? slugify(feature ?? 'session', MAX_SLUG_LENGTH) || 'unknown'
        : generateOpaqueSessionSlug();
  const git = createGitClient(baseProjectDir);
  const wtPath = await withCliErrors(() =>
    createWorktree({ projectDir: baseProjectDir, slug, git }),
  );
  const displaySlug = stripTerminalControls(slug);
  console.log(
    `Starting session in worktree .trees/${displaySlug} (branch splitbrief/${displaySlug})`,
  );
  opts.project = wtPath;
  return { slug, baseProjectDir, git };
}

export async function rollbackCreatedWorktree(created: CreatedWorktree): Promise<void> {
  try {
    await removeWorktree({
      projectDir: created.baseProjectDir,
      slug: created.slug,
      git: created.git,
      force: true,
      deleteBranch: true,
    });
  } catch {
    const displaySlug = stripTerminalControls(created.slug);
    process.stderr.write(
      `Warning: failed to remove worktree .trees/${displaySlug} after a startup error; ` +
        `run "git worktree prune" then "git branch -D splitbrief/${displaySlug}" to clean up.\n`,
    );
  }
}
