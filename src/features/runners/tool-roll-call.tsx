import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { Box } from 'ink';
import type { ReactNode } from 'react';
import { glyph } from '../../lib/glyphs.js';
import { probeCheckText, slowestProbe } from '../../core/discovery/probe-activity.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { useProbeActivity } from '../../hooks/use-slow-probe-text.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';

/**
 * First-run tool check: one row per tool found on this machine, in catalog order so no row moves
 * as answers arrive. A row states only checking or checked; whether a tool is ready belongs to the
 * crew step after it. A footer (a feedback notice) takes the note's place, so the panel keeps its
 * height when every listed tool is on this machine.
 */
export function ToolRollCall({ footer }: { footer?: ReactNode }) {
  const t = useTheme();
  const { snapshot, now } = useProbeActivity();
  const tools = CLI_TOOL_IDS.flatMap((tool) => {
    const entry = snapshot.tools.find((candidate) => candidate.tool === tool);
    return entry === undefined ? [] : [entry];
  });
  const { frame } = useSpinnerFrame(
    tools.length === 0 || tools.some(({ state }) => state === 'checking'),
  );

  return (
    <Box flexDirection="column">
      {tools.length === 0 ? (
        <Text color={t.textDim}>
          <Text color={t.accent}>{frame}</Text> Looking for coding tools…
        </Text>
      ) : (
        tools.map(({ tool, state }) => {
          const slow =
            state === 'checking'
              ? slowestProbe(
                  snapshot.probes.filter((probe) => probe.tool === tool),
                  now,
                )
              : null;
          return (
            <Box key={tool} gap={1} paddingLeft={2}>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={t.text} wrap="truncate-end">
                  {CLI_TOOL_CATALOG[tool].displayName}
                </Text>
              </Box>
              {slow !== null && (
                <Box flexShrink={0}>
                  <Text color={t.text}>{probeCheckText(slow, now)}</Text>
                </Box>
              )}
              <Box width={2} paddingLeft={1} flexShrink={0}>
                {state === 'checked' ? (
                  <Text color={t.textDim}>{glyph('check')}</Text>
                ) : (
                  <Text color={t.accent}>{frame}</Text>
                )}
              </Box>
            </Box>
          );
        })
      )}
      {footer ?? (
        <Box marginTop={1}>
          <Text color={t.textDim}>Next: choose your crew.</Text>
        </Box>
      )}
    </Box>
  );
}
