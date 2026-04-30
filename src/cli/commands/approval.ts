import { Command } from 'commander';
import ansis from 'ansis';
import { resolveProjectDir } from '../setup.js';
import { readApprovalsStore, writeApprovalsStore, clearGrantsByScope } from '../../engine/orchestrator/approvals-store.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { cliError } from '../errors.js';

const VALID_SCOPES = ['session', 'always', 'all'] as const;
type ClearScope = (typeof VALID_SCOPES)[number];

export function registerApprovalCommand(program: Command): void {
  const approval = program
    .command('approval')
    .description('Manage sticky approval grants');

  approval
    .command('list')
    .description('List all sticky approval grants')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action((opts: { project?: string }) => {
      try {
        const projectDir = resolveProjectDir(opts.project);
        const store = readApprovalsStore(projectDir);

        if (store.grants.length === 0) {
          console.log('No sticky approvals on record.');
          return;
        }

        const colWidths = {
          pattern: Math.max(7, ...store.grants.map((g) => g.pattern.length)),
          cls: Math.max(5, ...store.grants.map((g) => g.class.length)),
          scope: 7,
          sessionId: Math.max(9, ...store.grants.map((g) => g.sessionId?.length ?? 0)),
        };

        const sepWidth =
          colWidths.pattern + 2 + colWidths.cls + 2 + colWidths.scope + 2 + colWidths.sessionId + 2 + 'grantedAt'.length;

        console.log(
          [
            ansis.bold('pattern'.padEnd(colWidths.pattern)),
            ansis.bold('class'.padEnd(colWidths.cls)),
            ansis.bold('scope'.padEnd(colWidths.scope)),
            ansis.bold('sessionId'.padEnd(colWidths.sessionId)),
            ansis.bold('grantedAt'),
          ].join('  '),
        );
        console.log(ansis.dim('-'.repeat(sepWidth)));

        for (const g of store.grants) {
          console.log(
            [
              g.pattern.padEnd(colWidths.pattern),
              g.class.padEnd(colWidths.cls),
              g.scope.padEnd(colWidths.scope),
              (g.sessionId ?? '').padEnd(colWidths.sessionId),
              g.grantedAt,
            ].join('  '),
          );
        }
      } catch (err) {
        throw cliError(toErrorMessage(err), 1);
      }
    });

  approval
    .command('clear')
    .description('Clear approval grants by scope')
    .option('--scope <scope>', 'session | always | all (default: all)', 'all')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action((opts: { scope?: string; project?: string }) => {
      try {
        const projectDir = resolveProjectDir(opts.project);
        const scope = (opts.scope ?? 'all') as ClearScope;

        if (!VALID_SCOPES.includes(scope)) {
          throw cliError(
            `Unknown --scope: "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`,
            1,
          );
        }

        const before = readApprovalsStore(projectDir);
        const after = clearGrantsByScope(before, scope);
        writeApprovalsStore(projectDir, after);
        const count = before.grants.length - after.grants.length;
        console.log(`Cleared ${count} approval grant(s).`);
      } catch (err) {
        if (err instanceof Error && 'exitCode' in err) throw err;
        throw cliError(toErrorMessage(err), 1);
      }
    });
}
