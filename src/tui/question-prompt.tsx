import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';
import type { ClarificationQuestion } from '../orchestrator/question-parser.js';

interface QuestionPromptProps {
  question: ClarificationQuestion;
  questionNumber: number;
  totalQuestions: number;
  onAnswer: (questionId: string, answer: string) => void;
  onSkip: (questionId: string) => void;
  onDone: () => void;
}

export default function QuestionPrompt({
  question,
  questionNumber,
  totalQuestions,
  onAnswer,
  onSkip,
  onDone,
}: QuestionPromptProps) {
  const handleSubmit = (value: string) => {
    const trimmed = value.trim().toLowerCase();

    if (trimmed === 's' || trimmed === 'skip') {
      onSkip(question.id);
      return;
    }

    if (trimmed === 'd' || trimmed === 'done') {
      onDone();
      return;
    }

    if (question.type === 'choice' && question.options) {
      const num = parseInt(value.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= question.options.length) {
        onAnswer(question.id, question.options[num - 1]);
        return;
      }
    }

    onAnswer(question.id, value.trim());
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Question {questionNumber}/{totalQuestions}:</Text>
      <Text>{question.text}</Text>

      {question.type === 'choice' && question.options && (
        <Box flexDirection="column" marginTop={1}>
          {question.options.map((option, i) => (
            <Text key={i} color={question.default === i ? 'green' : undefined}>
              {question.default === i ? '> ' : '  '}{i + 1}. {option}
            </Text>
          ))}
        </Box>
      )}

      {question.type === 'confirm' && (
        <Text dimColor>
          (default: {question.default === true ? 'yes' : 'no'})
        </Text>
      )}

      <Box marginTop={1}>
        <TextInput
          placeholder={question.type === 'choice' ? 'Enter number or text...' : 'Type your response...'}
          onSubmit={handleSubmit}
        />
      </Box>

      <Text dimColor>[Enter] answer  [s] skip  [d] done (no more questions)</Text>
    </Box>
  );
}
