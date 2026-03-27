import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

interface UserInputProps {
  prompt: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}

export default function UserInput({ prompt, placeholder = 'Type your response...', onSubmit }: UserInputProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
      <Text bold>{prompt}</Text>
      <TextInput placeholder={placeholder} onSubmit={onSubmit} />
    </Box>
  );
}
