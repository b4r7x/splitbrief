import { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { resolveSessionIds } from '../../engine/mcp/discovery.js';
import { generateToken } from '../../engine/mcp/auth-token.js';
import { createResolver } from '../../engine/mcp/resolver.js';
import { startMcpServer } from '../../engine/mcp/server.js';
import { createToolHandler } from '../../engine/mcp/tool/handler.js';
import { getDiptychVersion } from '../../core/paths-io.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const DEFAULT_PORT = 4321;

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('MCP resource and write-tool server commands');

  mcp
    .command('serve')
    .description('Start an MCP server for project resources and write tools')
    .option('--port <number>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--session <id>', 'Serve only this session')
    .option('--all-sessions', 'Serve all sessions in the project')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(
      async (opts: { port?: string; session?: string; allSessions?: boolean; project?: string }) => {
        const projectDir = resolveProjectDir(opts.project);

        if (opts.session !== undefined && opts.allSessions) {
          throw cliError('--session and --all-sessions are mutually exclusive.', 1);
        }

        const rawPort = opts.port ?? String(DEFAULT_PORT);
        const port = Number.parseInt(rawPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
          throw cliError(
            `Invalid --port: "${rawPort}". Must be an integer between 1 and 65535.`,
            1,
          );
        }

        let sessionIds: string[];
        try {
          sessionIds = resolveSessionIds(projectDir, {
            ...(opts.session !== undefined && { session: opts.session }),
            ...(opts.allSessions && { allSessions: opts.allSessions }),
          });
        } catch (err) {
          throw cliError(toErrorMessage(err), 1);
        }

        const token = generateToken();
        const diptychVersion = getDiptychVersion();
        const resolver = createResolver({ projectDir, sessionIds, diptychVersion });
        const toolHandler = createToolHandler(projectDir);

        let handle: Awaited<ReturnType<typeof startMcpServer>>;
        try {
          handle = await startMcpServer({
            port,
            host: '127.0.0.1',
            token,
            resolver,
            serverVersion: diptychVersion,
            toolHandler,
          });
        } catch (err) {
          process.stderr.write(`Error: ${toErrorMessage(err)}\n`);
          process.exit(1);
        }

        const actualPort = handle.port;
        const sessionsLabel = opts.allSessions ? 'all' : sessionIds.join(', ');

        process.stdout.write(
          [
            'diptych MCP server ready',
            '  Exposes session resources and write tools.',
            '',
            `  URL:    http://127.0.0.1:${actualPort}/mcp`,
            `  Token:  ${token}`,
            `  Sessions: ${sessionsLabel}`,
            '',
            'To configure in Claude Code (.claude/settings.json):',
            '  {',
            '    "mcpServers": {',
            '      "diptych": {',
            '        "type": "http",',
            `        "url": "http://127.0.0.1:${actualPort}/mcp",`,
            `        "headers": { "Authorization": "Bearer ${token}" }`,
            '      }',
            '    }',
            '  }',
            '',
            'Press Ctrl+C to stop.',
            '',
          ].join('\n'),
        );

        const shutdown = async () => {
          await handle.close();
          process.exit(0);
        };

        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      },
    );
}
