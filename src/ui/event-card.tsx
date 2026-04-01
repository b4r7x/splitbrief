import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';
import { highlight } from '../engine/highlight.js';
import { getTheme } from '../theme.js';
import DiffView from './diff-view.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

// --- Markdown rendering helpers for planner-text ---

type CodeBlock = { type: 'code'; lang: string; code: string };
type TextBlock = { type: 'text'; lines: string[] };
type Block = CodeBlock | TextBlock;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let currentText: string[] = [];
  let inCode = false;
  let codeLang = 'typescript';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      if (currentText.length > 0) {
        blocks.push({ type: 'text', lines: currentText });
        currentText = [];
      }
      const langHint = line.slice(3).trim().toLowerCase();
      if (langHint === 'javascript' || langHint === 'js') codeLang = 'javascript';
      else codeLang = 'typescript';
      inCode = true;
      codeLines = [];
    } else if (inCode && line.startsWith('```')) {
      blocks.push({ type: 'code', lang: codeLang, code: codeLines.join('\n') });
      inCode = false;
      codeLines = [];
    } else if (inCode) {
      codeLines.push(line);
    } else {
      currentText.push(line);
    }
  }
  if (inCode && codeLines.length > 0) {
    blocks.push({ type: 'code', lang: codeLang, code: codeLines.join('\n') });
  }
  if (currentText.length > 0) {
    blocks.push({ type: 'text', lines: currentText });
  }
  return blocks;
}

function renderMarkdownLine(line: string, key: number) {
  const t = getTheme();
  if (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### ')) {
    const text = line.replace(/^#+\s*/, '');
    return <Text key={key} color={t.accent} bold>{text}</Text>;
  }
  const boldParts = line.split(/\*\*([^*]+)\*\*/g);
  if (boldParts.length > 1) {
    return (
      <Text key={key} color={t.text}>
        {boldParts.map((part, i) =>
          i % 2 === 1
            ? <Text key={i} color={t.warning}>{part}</Text>
            : <Text key={i}>{part}</Text>
        )}
      </Text>
    );
  }
  const emParts = line.split(/\*([^*]+)\*/g);
  if (emParts.length > 1) {
    return (
      <Text key={key} color={t.text}>
        {emParts.map((part, i) =>
          i % 2 === 1
            ? <Text key={i} italic>{part}</Text>
            : <Text key={i}>{part}</Text>
        )}
      </Text>
    );
  }
  return <Text key={key} color={t.text}>{line}</Text>;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const t = getTheme();
  const [hl, setHl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang as 'typescript' | 'javascript').then(result => {
      if (!cancelled) setHl(result.replace(/\n$/, ''));
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  return (
    <Box marginY={0} paddingX={1} flexDirection="column">
      <Text backgroundColor={t.panelBg}>{hl ?? code}</Text>
    </Box>
  );
}

function PlannerText({ text }: { text: string }) {
  const blocks = parseBlocks(text);

  return (
    <Box marginLeft={2} flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <HighlightedCode key={i} code={block.code} lang={block.lang} />;
        }
        return (
          <Box key={i} flexDirection="column">
            {block.lines.map((line, j) => renderMarkdownLine(line, j))}
          </Box>
        );
      })}
    </Box>
  );
}

function Spinner({ label, color }: { label: string; color: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
      <Text color={color}> {label}</Text>
    </Box>
  );
}

// --- Sub-components for each event card type ---

function PlannerStatusCard({ event }: { event: Extract<TuiEvent, { type: 'planner-status' }> }) {
  const t = getTheme();
  const dur = event.duration ? ` ${(event.duration / 1000).toFixed(1)}s` : '';
  const statusText = event.status === 'done'
    ? `${event.phase} done${dur}`
    : `${event.phase}...`;

  return (
    <Box>
      <Text color={t.planner}>planner </Text>
      <Text color={t.text}>{statusText}</Text>
      {event.summary && <Text color={t.textDim}> {event.summary}</Text>}
    </Box>
  );
}

function TaskStartCard({ event }: { event: Extract<TuiEvent, { type: 'task-start' }> }) {
  const t = getTheme();
  return (
    <Box marginTop={1}>
      <Text color={t.text} bold>T{event.index + 1}: {event.title}</Text>
      <Text color={t.textDim}>  {event.file} ({event.action})</Text>
    </Box>
  );
}

function ImplementerCard({ event, diffExpanded }: { event: Extract<TuiEvent, { type: 'implementer-generate' }>; diffExpanded: boolean }) {
  const t = getTheme();

  if (event.status === 'running') {
    return <Spinner label={`generating ${event.model ?? 'local'}...`} color={t.implementer} />;
  }

  const dur = event.duration ? `  ${(event.duration / 1000).toFixed(1)}s` : '';

  if (event.status === 'failed') {
    return (
      <Box>
        <Text color={t.textDim}>implementer ({event.model ?? '?'})</Text>
        <Text color={t.error}>  failed</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.textDim}>implementer ({event.model ?? '?'}){dur}</Text>
      </Box>
      {event.file && event.diff != null && event.linesAdded != null && event.linesRemoved != null ? (
        <DiffView
          file={event.file}
          linesAdded={event.linesAdded}
          linesRemoved={event.linesRemoved}
          diff={event.diff}
          expanded={diffExpanded}
        />
      ) : event.file ? (
        <Box>
          <Text color={t.textDim}>  {event.file} (+{event.linesAdded ?? 0} -{event.linesRemoved ?? 0})</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ValidateCard({ event }: { event: Extract<TuiEvent, { type: 'validate' }> }) {
  const t = getTheme();
  const dur = event.duration ? ` ${(event.duration / 1000).toFixed(1)}s` : '';

  const stageIcon = (passed: boolean) => passed
    ? <Text color={t.success}>✓</Text>
    : <Text color={t.error}>✗</Text>;

  if (event.status === 'running') {
    const currentStage = !event.stages.tsc ? 'tsc' : !event.stages.lint ? 'lint' : 'test';
    return <Spinner label={`validating ${currentStage}...`} color={t.validator} />;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.validator}>validator</Text>
        <Text color={t.textDim}>{dur}</Text>
      </Box>
      <Box marginLeft={2} gap={2}>
        <Text color={t.textDim}>tsc {stageIcon(event.stages.tsc)}</Text>
        <Text color={t.textDim}>lint {stageIcon(event.stages.lint)}</Text>
        <Text color={t.textDim}>test {stageIcon(event.stages.test)}</Text>
      </Box>
      {event.error && (
        <Box marginLeft={2}>
          <Text color={t.error}>{event.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function RetryCard({ event }: { event: Extract<TuiEvent, { type: 'retry' }> }) {
  const t = getTheme();
  return (
    <Box>
      <Text color={t.warning}>retry </Text>
      <Text color={t.textDim}>attempt {event.attempt}/{event.maxRetries}</Text>
    </Box>
  );
}

function EscalateCard({ event }: { event: Extract<TuiEvent, { type: 'escalate' }> }) {
  const t = getTheme();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.warning} bold>escalate </Text>
        <Text color={t.textDim}>tier {event.tier}</Text>
      </Box>
      {event.hint && (
        <Box marginLeft={2}>
          <Text color={t.textDim}>{event.hint}</Text>
        </Box>
      )}
    </Box>
  );
}

function GitCommitCard({ event }: { event: Extract<TuiEvent, { type: 'git-commit' }> }) {
  const t = getTheme();
  return (
    <Box>
      <Text color={t.success}>committed </Text>
      <Text color={t.textDim}>{event.message}</Text>
    </Box>
  );
}

function ErrorCard({ event }: { event: Extract<TuiEvent, { type: 'error' }> }) {
  const t = getTheme();
  return (
    <Box>
      <Text color={t.error}>error </Text>
      <Text color={t.error}>{event.message}</Text>
    </Box>
  );
}

// --- Main EventCard ---

export default function EventCard({ event, diffExpanded }: EventCardProps) {
  const t = getTheme();
  switch (event.type) {
    case 'planner-status':
      return <PlannerStatusCard event={event} />;

    case 'planner-text':
      return <PlannerText text={event.text} />;

    case 'task-start':
      return <TaskStartCard event={event} />;

    case 'task-complete':
      return null;

    case 'task-skipped':
      return (
        <Box>
          <Text color={t.textDim}>skipped T{event.taskId} {event.title}: {event.reason}</Text>
        </Box>
      );

    case 'implementer-generate':
      return <ImplementerCard event={event} diffExpanded={diffExpanded ?? false} />;

    case 'validate':
      return <ValidateCard event={event} />;

    case 'retry':
      return <RetryCard event={event} />;

    case 'escalate':
      return <EscalateCard event={event} />;

    case 'git-commit':
      return <GitCommitCard event={event} />;

    case 'error':
      return <ErrorCard event={event} />;
  }
}
