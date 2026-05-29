import type { Command } from 'commander';
import { sessionDir } from '../../core/paths.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { writeSessionHtmlReport } from '../../engine/export/collect.js';
import { cliError, withCliErrors } from '../errors.js';
import { resolveProjectDir } from '../setup.js';

interface ExportCommandOptions {
  project?: string;
  out?: string;
}

async function exportAction(
  sessionId: string | undefined,
  opts: ExportCommandOptions,
): Promise<void> {
  await withCliErrors(() => {
    const projectDir = resolveProjectDir(opts.project);
    const resolvedSessionId = resolveExportSessionId(projectDir, sessionId);
    const result = writeSessionHtmlReport(
      sessionDir(projectDir, resolvedSessionId),
      resolvedSessionId,
      opts.out,
    );

    if (result.status === 'error') {
      throw cliError(result.error, 1);
    }

    console.log(`Report written to ${result.path}`);
  });
}

export function registerExportCommand(program: Command): void {
  program
    .command('export [session-id]')
    .description('Export a session as an HTML report')
    .option('-o, --out <path>', 'Output file path')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .action(exportAction);
}

function resolveExportSessionId(
  projectDir: string,
  requestedSessionId: string | undefined,
): string {
  if (requestedSessionId) return requestedSessionId;

  const sessions = listAllSessions(projectDir);
  const activeSessionId = readActive(projectDir);

  if (activeSessionId) {
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    if (activeSession?.status === 'complete') return activeSessionId;
  }

  const completedSession = sessions.find((session) => session.status === 'complete');
  if (completedSession) return completedSession.id;

  throw cliError('No session specified and no completed sessions found.', 1);
}
