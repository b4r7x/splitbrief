import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAppContext } from '../app.js';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { useFilterableList } from '../hooks/use-filterable-list.js';
import { truncate } from '../utils/format.js';
import { computeScrollOffset } from '../ui/picker-utils.js';
import { Spinner } from '../ui/spinner.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection.js';
import { writeConfigSelection } from '../core/config.js';
import type { PlannerDetection, ImplementerDetection } from '../engine/detection.js';
import type { Theme } from '../ui/theme.js';
import type { PlannerTool } from '../types.js';

interface ConfigPickerProps {
  onClose: () => void;
}

interface PickerItem {
  id: string;
  label: string;
  sublabel: string;
  isSentinel?: boolean;
}

function buildPlannerItems(planners: PlannerDetection[]): PickerItem[] {
  const items: PickerItem[] = planners
    .filter(p => p.available)
    .map(p => ({
      id: p.tool,
      label: p.tool,
      sublabel: p.version ? `v${p.version}` : '',
    }));
  items.push({ id: '__custom__', label: '+ Custom shell command...', sublabel: '', isSentinel: true });
  return items;
}

function buildModelItems(implementers: ImplementerDetection[]): PickerItem[] {
  const items: PickerItem[] = [];
  for (const imp of implementers) {
    if (!imp.available || !imp.models) continue;
    for (const model of imp.models) {
      items.push({ id: `${imp.provider}/${model}`, label: model, sublabel: imp.provider });
    }
  }
  items.push({ id: '__custom__', label: '+ Custom endpoint...', sublabel: '', isSentinel: true });
  return items;
}

function filterItem(item: PickerItem, query: string): boolean {
  const lower = query.toLowerCase();
  return item.label.toLowerCase().includes(lower) || item.sublabel.toLowerCase().includes(lower);
}

interface ItemRowProps {
  item: PickerItem;
  isCursor: boolean;
  nameWidth: number;
  sublabelWidth: number;
  theme: Theme;
}

function ItemRow({ item, isCursor, nameWidth, sublabelWidth, theme: t }: ItemRowProps) {
  const cursor = isCursor ? '\u25b8 ' : '  ';
  const name = truncate(item.label, nameWidth).padEnd(nameWidth);
  const sub = item.sublabel ? truncate(item.sublabel, sublabelWidth) : '';

  return (
    <Box>
      <Text color={isCursor ? t.accent : (item.isSentinel ? t.textDim : t.text)}>{cursor}</Text>
      <Text color={isCursor ? t.accent : (item.isSentinel ? t.textDim : t.text)} bold={isCursor}>{name}</Text>
      {sub && <Text color={t.textDim}>{'  '}{sub}</Text>}
    </Box>
  );
}

type CustomStep = null | 'planner-command' | 'impl-provider' | 'impl-model';

export function ConfigPicker({ onClose }: ConfigPickerProps) {
  const t = useTheme();
  const { projectDir, reloadConfig } = useAppContext();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [plannerItems, setPlannerItems] = useState<PickerItem[]>([]);
  const [modelItems, setModelItems] = useState<PickerItem[]>([]);
  const [activeSection, setActiveSection] = useState<'planner' | 'model'>('planner');
  const [customStep, setCustomStep] = useState<CustomStep>(null);
  const [customInput, setCustomInput] = useState('');
  const [customProvider, setCustomProvider] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectAvailablePlanners(), detectAvailableImplementers()]).then(
      ([planners, implementers]) => {
        if (cancelled) return;
        setPlannerItems(buildPlannerItems(planners));
        setModelItems(buildModelItems(implementers));
        setPhase('ready');
      },
    );
    return () => { cancelled = true; };
  }, []);

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const sectionMaxVisible = Math.max(Math.floor((rows - 16) / 2), 3);
  const nameWidth = isSmall ? 30 : 40;
  const sublabelWidth = Math.max(10, contentWidth - nameWidth - 6);

  const plannerList = useFilterableList({
    items: plannerItems,
    filterFn: filterItem,
    onSelect: (item) => {
      if (item.isSentinel) {
        setCustomStep('planner-command');
        setCustomInput('');
        return;
      }
      setActiveSection('model');
    },
    onClose,
    isActive: phase === 'ready' && activeSection === 'planner' && !customStep,
  });

  const modelList = useFilterableList({
    items: modelItems,
    filterFn: filterItem,
    onSelect: (item) => {
      if (item.isSentinel) {
        setCustomStep('impl-provider');
        setCustomInput('');
        return;
      }
      const [provider, ...rest] = item.id.split('/');
      const model = rest.join('/');
      const plannerItem = plannerItems[plannerList.selectedIndex];
      if (!plannerItem || plannerItem.isSentinel) return;
      writeConfigSelection(
        projectDir,
        { tool: plannerItem.id as PlannerTool },
        { provider, model },
      );
      reloadConfig();
      onClose();
    },
    onClose,
    isActive: phase === 'ready' && activeSection === 'model' && !customStep,
  });

  useInput((input, key) => {
    if (phase !== 'ready') return;

    if (!customStep) {
      if (key.tab && !key.shift) {
        setActiveSection(prev => prev === 'planner' ? 'model' : 'planner');
        return;
      }
      if (key.tab && key.shift) {
        setActiveSection(prev => prev === 'planner' ? 'model' : 'planner');
        return;
      }
      return;
    }

    if (key.escape) {
      setCustomStep(null);
      setCustomInput('');
      return;
    }

    if (key.return && customInput.trim()) {
      if (customStep === 'planner-command') {
        writeConfigSelection(
          projectDir,
          { tool: 'shell' as PlannerTool, command: customInput.trim() },
          { provider: modelItems[modelList.selectedIndex]?.sublabel ?? 'ollama', model: modelItems[modelList.selectedIndex]?.label ?? 'qwen2.5-coder:7b' },
        );
        reloadConfig();
        onClose();
        return;
      }
      if (customStep === 'impl-provider') {
        setCustomProvider(customInput.trim());
        setCustomInput('');
        setCustomStep('impl-model');
        return;
      }
      if (customStep === 'impl-model') {
        const plannerItem = plannerItems[plannerList.selectedIndex];
        const tool = (plannerItem && !plannerItem.isSentinel ? plannerItem.id : 'claude-code') as PlannerTool;
        writeConfigSelection(
          projectDir,
          { tool },
          { provider: customProvider, model: customInput.trim(), apiBase: customProvider.startsWith('http') ? customProvider : undefined },
        );
        reloadConfig();
        onClose();
        return;
      }
    }

    if (key.backspace || key.delete) {
      setCustomInput(prev => prev.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setCustomInput(prev => prev + input);
    }
  }, { isActive: phase === 'ready' });

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" width={cols} height={rows} alignItems="center" justifyContent="center">
        <Spinner label="Detecting planners and models..." color={t.accent} />
      </Box>
    );
  }

  const plannerScrollOffset = computeScrollOffset(plannerList.selectedIndex, sectionMaxVisible, plannerList.filtered.length);
  const plannerVisible = plannerList.filtered.slice(plannerScrollOffset, plannerScrollOffset + sectionMaxVisible);
  const modelScrollOffset = computeScrollOffset(modelList.selectedIndex, sectionMaxVisible, modelList.filtered.length);
  const modelVisible = modelList.filtered.slice(modelScrollOffset, modelScrollOffset + sectionMaxVisible);

  const plannerActive = activeSection === 'planner' && !customStep;
  const modelActive = activeSection === 'model' && !customStep;

  const customLabel = customStep === 'planner-command'
    ? 'Shell command:'
    : customStep === 'impl-provider'
      ? 'Provider name or API base URL:'
      : customStep === 'impl-model'
        ? `Model name (${customProvider}):`
        : '';

  let footerHint = 'Tab switch  \u2191\u2193 navigate  Enter select  Esc close';
  if (customStep) {
    footerHint = 'Enter confirm  Esc cancel';
  }

  return (
    <Box flexDirection="column" width={cols} height={rows} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={contentWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>Config</Text>
        </Box>

        <Box marginBottom={0}>
          <Text bold color={plannerActive ? t.accent : t.text}>Planner</Text>
          {!plannerActive && plannerList.filtered.length > 0 && (
            <Text color={t.textDim}>{' \u2014 '}{plannerList.filtered[plannerList.selectedIndex]?.label ?? ''}</Text>
          )}
        </Box>

        {customStep === 'planner-command' ? (
          <Box borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1} width={contentWidth}>
            <Text color={t.accent}>{'> '}</Text>
            <Text>{customInput || <Text color={t.textDim}>type shell command...</Text>}</Text>
          </Box>
        ) : (
          <>
            <Box borderStyle="round" borderColor={plannerActive ? t.accent : t.border} paddingX={1} marginBottom={0} width={contentWidth}>
              <Text color={plannerActive ? t.accent : t.textDim}>{'> '}</Text>
              <Text>{plannerActive ? (plannerList.filter || <Text color={t.textDim}>Type to filter...</Text>) : <Text color={t.textDim}>{plannerList.filter || 'Type to filter...'}</Text>}</Text>
            </Box>

            {plannerScrollOffset > 0 && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

            <Box flexDirection="column" marginBottom={1}>
              {plannerVisible.map((item, i) => {
                const globalIndex = plannerScrollOffset + i;
                return (
                  <ItemRow
                    key={item.id}
                    item={item}
                    isCursor={plannerActive && globalIndex === plannerList.selectedIndex}
                    nameWidth={nameWidth}
                    sublabelWidth={sublabelWidth}
                    theme={t}
                  />
                );
              })}
              {plannerList.filtered.length === 0 && <Text color={t.textDim}>{'  No planners detected'}</Text>}
            </Box>

            {plannerScrollOffset + sectionMaxVisible < plannerList.filtered.length && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
          </>
        )}

        <Box marginBottom={0}>
          <Text bold color={modelActive ? t.accent : t.text}>Model</Text>
          {!modelActive && modelList.filtered.length > 0 && (
            <Text color={t.textDim}>{' \u2014 '}{modelList.filtered[modelList.selectedIndex]?.label ?? ''}</Text>
          )}
        </Box>

        {customStep === 'impl-provider' || customStep === 'impl-model' ? (
          <Box borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1} width={contentWidth}>
            <Text color={t.textDim}>{customLabel} </Text>
            <Text color={t.accent}>{'> '}</Text>
            <Text>{customInput || <Text color={t.textDim}>type here...</Text>}</Text>
          </Box>
        ) : (
          <>
            <Box borderStyle="round" borderColor={modelActive ? t.accent : t.border} paddingX={1} marginBottom={0} width={contentWidth}>
              <Text color={modelActive ? t.accent : t.textDim}>{'> '}</Text>
              <Text>{modelActive ? (modelList.filter || <Text color={t.textDim}>Type to filter...</Text>) : <Text color={t.textDim}>{modelList.filter || 'Type to filter...'}</Text>}</Text>
            </Box>

            {modelScrollOffset > 0 && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

            <Box flexDirection="column">
              {modelVisible.map((item, i) => {
                const globalIndex = modelScrollOffset + i;
                return (
                  <ItemRow
                    key={item.id}
                    item={item}
                    isCursor={modelActive && globalIndex === modelList.selectedIndex}
                    nameWidth={nameWidth}
                    sublabelWidth={sublabelWidth}
                    theme={t}
                  />
                );
              })}
              {modelList.filtered.length === 0 && <Text color={t.textDim}>{'  No models detected'}</Text>}
            </Box>

            {modelScrollOffset + sectionMaxVisible < modelList.filtered.length && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
          </>
        )}
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{footerHint}</Text>
      </Box>
    </Box>
  );
}
