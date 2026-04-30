import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/store.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/actions.js';

type ConfirmStep = 'phrase' | 'reason';

export function ApprovalPrompt() {
  const state = approvalPromptStore.use(s => s);
  const [phraseInput, setPhraseInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>('phrase');
  const [phraseError, setPhraseError] = useState('');
  const t = useTheme();

  const isActive = state.status === 'pending';
  const promptIdentity = state.status === 'pending' ? state.resolve : null;

  useEffect(() => {
    setPhraseInput('');
    setReasonInput('');
    setConfirmStep('phrase');
    setPhraseError('');
  }, [promptIdentity]);

  useInput(
    (input, key) => {
      if (state.status !== 'pending') return;
      const { request } = state;

      if (request.tier === 'sticky') {
        if (input === 'a' || input === 'A') {
          closeApprovalPrompt({ decision: 'allow', scope: 'once' });
          return;
        }
        if (input === 's' || input === 'S') {
          closeApprovalPrompt({ decision: 'allow', scope: 'session' });
          return;
        }
        if (input === 'w' || input === 'W') {
          closeApprovalPrompt({ decision: 'allow', scope: 'always' });
          return;
        }
        if (input === 'x' || input === 'X' || key.escape) {
          closeApprovalPrompt();
          return;
        }
        return;
      }

      if (request.tier === 'confirm') {
        if (confirmStep === 'phrase') {
          if (key.escape) {
            closeApprovalPrompt();
            setPhraseInput('');
            setReasonInput('');
            setConfirmStep('phrase');
            setPhraseError('');
            return;
          }
          if (key.return) {
            if (phraseInput === 'I confirm') {
              setPhraseError('');
              setConfirmStep('reason');
            } else {
              setPhraseInput('');
              setPhraseError('Incorrect phrase. Try again.');
            }
            return;
          }
          if (key.backspace || key.delete) {
            setPhraseInput(p => p.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setPhraseInput(p => p + input);
            setPhraseError('');
          }
          return;
        }

        if (confirmStep === 'reason') {
          if (key.escape) {
            closeApprovalPrompt();
            setPhraseInput('');
            setReasonInput('');
            setConfirmStep('phrase');
            setPhraseError('');
            return;
          }
          if (key.return) {
            if (reasonInput.trim()) {
              const reason = reasonInput.trim();
              closeApprovalPrompt({ decision: 'confirm', phrase: 'I confirm', reason });
              setPhraseInput('');
              setReasonInput('');
              setConfirmStep('phrase');
              setPhraseError('');
            }
            return;
          }
          if (key.backspace || key.delete) {
            setReasonInput(r => r.slice(0, -1));
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setReasonInput(r => r + input);
          }
        }
      }
    },
    { isActive },
  );

  if (state.status !== 'pending') return null;

  const { request } = state;

  if (request.tier === 'sticky') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1}>
        <Text color={t.warning}>{`[?] Write outside task scope: ${request.actionDescription}`}</Text>
        <Text color={t.text}>{'  [A] Approve once'}</Text>
        <Text color={t.text}>{'  [S] Approve for this session'}</Text>
        <Text color={t.textDim}>{'  [W] Always approve (saved to .diptych/approvals.json)'}</Text>
        <Text color={t.error}>{'  [X] Deny'}</Text>
      </Box>
    );
  }

  if (request.tier === 'confirm') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.error} paddingX={1}>
        <Text color={t.error}>{`[!] Destructive action: ${request.actionDescription}`}</Text>
        {confirmStep === 'phrase' && (
          <>
            <Text color={t.textDim}>{'    Type "I confirm" to proceed, or press Escape to cancel.'}</Text>
            <Box>
              <Text color={t.textDim}>{'    Phrase: '}</Text>
              <Text color={t.accent}>{phraseInput}</Text>
              <Text color={t.accent}>{'_'}</Text>
            </Box>
            {phraseError ? <Text color={t.error}>{`    ${phraseError}`}</Text> : null}
          </>
        )}
        {confirmStep === 'reason' && (
          <>
            <Text color={t.text}>{'    Phrase accepted. Enter reason:'}</Text>
            <Box>
              <Text color={t.textDim}>{'    Reason: '}</Text>
              <Text color={t.accent}>{reasonInput}</Text>
              <Text color={t.accent}>{'_'}</Text>
            </Box>
            <Text color={t.textDim}>{'    (Press Enter to confirm, Escape to cancel)'}</Text>
          </>
        )}
      </Box>
    );
  }

  return null;
}
