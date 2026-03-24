import { Box, Text, useInput, useApp } from 'ink';
import { spawnSync } from 'node:child_process';

interface ApprovalPromptProps {
  type: 'spec' | 'plan';
  filePath: string;
  onApprove: () => void;
  onReject: () => void;
}

export default function ApprovalPrompt({ type, filePath, onApprove, onReject }: ApprovalPromptProps) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.return) {
      onApprove();
    } else if (input === 'e') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      spawnSync(editor, [filePath], { stdio: 'inherit' });
    } else if (input === 'q') {
      onReject();
      exit();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text>
        <Text bold color="yellow">{type}</Text> generated. Review at <Text color="cyan">{filePath}</Text>
      </Text>
      <Text>
        <Text bold color="green">[Enter]</Text> approve  <Text bold color="blue">[e]</Text> open in editor  <Text bold color="red">[q]</Text> quit
      </Text>
    </Box>
  );
}
