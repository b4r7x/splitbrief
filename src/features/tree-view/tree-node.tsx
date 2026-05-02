import React from 'react';
import { Text, Box } from 'ink';
import type { TreeLine } from './format.js';

interface TreeNodeProps {
  line: TreeLine;
  isSelected: boolean;
}

export function TreeNode({ line, isSelected }: TreeNodeProps): React.ReactElement {
  const activeMarker = line.isActive ? '●' : '○';
  const branchIndicator = line.isBranchPoint
    ? (line.isCollapsed ? ' [+]' : ' [-]')
    : '';

  const color = getNodeColor(line);

  return (
    <Box>
      <Text dimColor={!line.isActive}>
        {line.prefix}
      </Text>
      {isSelected ? (
        <Text color="cyan" bold>{activeMarker}</Text>
      ) : (
        <Text bold={false}>{activeMarker}</Text>
      )}
      {color ? (
        <Text color={color} bold={line.isActive} dimColor={!line.isActive}>
          {' '}{line.label}{branchIndicator}
        </Text>
      ) : (
        <Text bold={line.isActive} dimColor={!line.isActive}>
          {' '}{line.label}{branchIndicator}
        </Text>
      )}
    </Box>
  );
}

function getNodeColor(line: TreeLine): string | undefined {
  if (line.type === 'recovery-decision') return 'yellow';
  if (line.type === 'branch-summary') return 'magenta';
  if (line.type === 'agent-invocation') return 'blue';
  if (line.type === 'cost-checkpoint') return 'green';
  if (line.type === 'file-state') return 'white';
  return undefined;
}
