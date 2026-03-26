import { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { TextInput } from '@inkjs/ui';
import { spawnSync } from 'node:child_process';

interface ApprovalPromptProps {
  type: 'spec' | 'plan';
  filePath: string;
  onApprove: () => void;
  onReject: () => void;
  onComment?: (text: string) => void;
  supportsSession?: boolean;
}

export default function ApprovalPrompt({ type, filePath, onApprove, onReject, onComment, supportsSession }: ApprovalPromptProps) {
  const { exit } = useApp();
  const [commenting, setCommenting] = useState(false);
  const [sessionWarning, setSessionWarning] = useState(false);

  useInput((input, key) => {
    if (commenting) return;
    if (sessionWarning) {
      setSessionWarning(false);
      return;
    }
    if (key.return) {
      onApprove();
    } else if (input === 'e') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      spawnSync(editor, [filePath], { stdio: 'inherit' });
    } else if (input === 'c' && onComment) {
      if (supportsSession === false) {
        setSessionWarning(true);
      } else {
        setCommenting(true);
      }
    } else if (input === 'q') {
      onReject();
      exit();
    }
  });

  if (sessionWarning) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="yellow">Comment requires session continuity (supported by claude-code and agent-sdk).</Text>
        <Text>Available: <Text bold color="green">[Enter]</Text> approve  <Text bold color="blue">[e]</Text> edit  <Text bold color="red">[q]</Text> quit</Text>
      </Box>
    );
  }

  if (commenting) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text>
          <Text bold color="yellow">Comment on {type}:</Text>
        </Text>
        <TextInput
          placeholder="Type your feedback and press Enter..."
          onSubmit={(value) => {
            setCommenting(false);
            if (value.trim() && onComment) {
              onComment(value.trim());
            }
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text>
        <Text bold color="yellow">{type}</Text> generated. Review at <Text color="cyan">{filePath}</Text>
      </Text>
      <Text>
        <Text bold color="green">[Enter]</Text> approve  <Text bold color="blue">[e]</Text> open in editor  {onComment && <><Text bold color="magenta">[c]</Text> comment  </>}<Text bold color="red">[q]</Text> quit
      </Text>
    </Box>
  );
}
