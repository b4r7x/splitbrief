import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import {
  readApprovalsStore,
  mutateApprovalsStore,
  clearGrantsByScope,
} from '../../core/approval/store.js';
import { cliError, withCliErrors } from '../errors.js';
import { renderTable } from '../render-table.js';
import { includes } from '../../utils/type-guards.js';

const VALID_SCOPES = ['session', 'always', 'all'] as const;

export function registerApprovalCommand(program: Command): void {
  const approval = program.command('approval').description('Manage sticky approval grants');

  approval
    .command('list')
    .description('List all sticky approval grants')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action((opts: { project?: string }) =>
      withCliErrors(() => {
        const projectDir = resolveProjectDir(opts.project);
        const store = readApprovalsStore(projectDir);

        if (store.grants.length === 0) {
          console.log('No sticky approvals on record.');
          return;
        }

        const lines = renderTable({
          columns: [
            { header: 'pattern', min: 7, value: (g) => g.pattern },
            { header: 'class', min: 5, value: (g) => g.class },
            { header: 'scope', min: 7, value: (g) => g.scope },
            { header: 'sessionId', min: 9, value: (g) => g.sessionId ?? '' },
            { header: 'grantedAt', min: 0, value: (g) => g.grantedAt },
          ],
          rows: store.grants,
          boldHeader: true,
          separator: true,
        });
        for (const line of lines) console.log(line);
      }),
    );

  approval
    .command('clear')
    .description('Clear approval grants by scope')
    .option('--scope <scope>', 'session | always | all (default: all)', 'all')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action((opts: { scope?: string; project?: string }) =>
      withCliErrors(() => {
        const projectDir = resolveProjectDir(opts.project);
        const rawScope = opts.scope ?? 'all';

        if (!includes(VALID_SCOPES, rawScope)) {
          throw cliError(
            `Unknown --scope: "${rawScope}". Valid scopes: ${VALID_SCOPES.join(', ')}`,
            1,
          );
        }

        const scope = rawScope;
        let count = 0;
        mutateApprovalsStore(projectDir, (before) => {
          const after = clearGrantsByScope(before, scope);
          count = before.grants.length - after.grants.length;
          return after;
        });
        console.log(`Cleared ${count} approval grant(s).`);
      }),
    );
}
