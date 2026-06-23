import type { InputMode, OverlayType, Screen } from '../navigation/types.js';
import { resolveScrollKey } from './scroll.js';
import type { NormalizedKeySignature } from './normalize.js';
import { resolveTextEditingKeyAction, type TextEditingKeyAction } from './text.js';

export type KeyAttachState = 'local' | 'attached';

export type FocusedKeySurface =
  | 'none'
  | 'composer'
  | 'workflow'
  | 'review'
  | 'plan-editor-task-list'
  | 'plan-editor-section-list'
  | 'plan-editor-editing-section'
  | 'plan-editor-regen-reason';

export interface KeyResolverContext {
  screen: Screen;
  inputMode: InputMode;
  focus: FocusedKeySurface;
  overlay: OverlayType;
  attachState: KeyAttachState;
  composerFocus: boolean;
  key: NormalizedKeySignature;
}

type PlanEditorTaskListKeyAction =
  | 'move-down'
  | 'move-up'
  | 'arrow-down'
  | 'arrow-up'
  | 'enter'
  | 'tab'
  | 'j'
  | 'k'
  | 'd'
  | 'm'
  | 'x'
  | 'R'
  | 'p'
  | 's'
  | 'E'
  | 'c'
  | '?'
  | 'Y'
  | 'N'
  | 'q';

type PlanEditorSectionListKeyAction =
  | 'escape'
  | 'arrow-down'
  | 'arrow-up'
  | 'j'
  | 'k'
  | 'e'
  | 'c'
  | 'Y'
  | 'N'
  | 'q'
  | '?';

type PlanEditorEditingSectionKeyAction = 'cancel-edit' | 'save-edit';
type PlanEditorRegenReasonKeyAction = 'cancel-regen' | 'submit-regen' | 'edit-regen-reason';

export type PlanEditorKeyAction =
  | PlanEditorTaskListKeyAction
  | PlanEditorSectionListKeyAction
  | PlanEditorEditingSectionKeyAction
  | PlanEditorRegenReasonKeyAction;

type PlanEditorTaskListKeyOwner = { owner: 'plan-editor'; action: PlanEditorTaskListKeyAction };
type PlanEditorSectionListKeyOwner = {
  owner: 'plan-editor';
  action: PlanEditorSectionListKeyAction;
};
type PlanEditorKeyOwner = { owner: 'plan-editor'; action: PlanEditorKeyAction };

export type KeyOwner =
  | { owner: 'text-editing'; action: TextEditingKeyAction }
  | { owner: 'workflow'; action: 'toggle-diff' | 'toggle-activity' | 'cost' }
  | { owner: 'conversation-scroll'; action: 'scroll' }
  | { owner: 'review'; action: 'scroll' }
  | PlanEditorKeyOwner
  | { owner: 'overlay'; action: 'close' }
  | { owner: 'attached-client'; action: 'detach' };

export function resolveKeyOwner(context: KeyResolverContext): KeyOwner | null {
  const overlayOwner = resolveOverlayOwner(context);
  if (overlayOwner !== null) return overlayOwner;

  if (context.screen !== 'workflow') return null;

  if (context.attachState === 'attached' && isCtrlKey(context.key, 'd')) {
    return { owner: 'attached-client', action: 'detach' };
  }

  if (
    context.inputMode === 'normal' &&
    context.focus === 'workflow' &&
    isCtrlKey(context.key, 'a')
  ) {
    return { owner: 'workflow', action: 'toggle-activity' };
  }

  const textOwner = resolveComposerTextOwner(context);
  if (textOwner !== null) return textOwner;

  const planEditorOwner = resolvePlanEditorOwner(context);
  if (planEditorOwner !== null) return planEditorOwner;

  if (context.focus === 'review') {
    return resolveScrollKey({
      input: context.key.input,
      key: keySignatureAsScrollKey(context.key),
      lineKeys: 'shifted',
    }) === null
      ? null
      : { owner: 'review', action: 'scroll' };
  }

  if (context.inputMode !== 'normal') return null;

  if (context.focus === 'workflow') {
    const conversationScroll = resolveScrollKey({
      input: context.key.input,
      key: keySignatureAsScrollKey(context.key),
      lineKeys: 'shifted',
    });
    if (conversationScroll !== null) return { owner: 'conversation-scroll', action: 'scroll' };
  }

  if (isCtrlKey(context.key, 'd')) return { owner: 'workflow', action: 'toggle-diff' };
  if (isCtrlKey(context.key, 'g')) return { owner: 'workflow', action: 'cost' };

  return null;
}

function resolveOverlayOwner(context: KeyResolverContext): KeyOwner | null {
  if (context.overlay === 'none') return null;
  if (context.overlay === 'cost-drilldown' || context.overlay === 'plan-editor-help') {
    return { owner: 'overlay', action: 'close' };
  }
  if (context.key.key === 'escape') return { owner: 'overlay', action: 'close' };
  return null;
}

function resolveComposerTextOwner(context: KeyResolverContext): KeyOwner | null {
  if (!context.composerFocus) return null;
  const action = resolveTextEditingKeyAction(context.key);
  return action === null ? null : { owner: 'text-editing', action };
}

function resolvePlanEditorOwner(context: KeyResolverContext): KeyOwner | null {
  switch (context.focus) {
    case 'plan-editor-task-list':
      return resolveTaskListOwner(context.key);
    case 'plan-editor-section-list':
      return resolveSectionListOwner(context.key);
    case 'plan-editor-editing-section': {
      const action = resolveTextEditingKeyAction(context.key);
      if (action !== null) return { owner: 'text-editing', action };
      if (context.key.key === 'escape') return { owner: 'plan-editor', action: 'cancel-edit' };
      if (context.key.ctrl && context.key.key === 'enter') {
        return { owner: 'plan-editor', action: 'save-edit' };
      }
      return null;
    }
    case 'plan-editor-regen-reason': {
      const action = resolveTextEditingKeyAction(context.key);
      if (action !== null) return { owner: 'text-editing', action };
      if (context.key.key === 'escape') return { owner: 'plan-editor', action: 'cancel-regen' };
      if (context.key.key === 'enter') return { owner: 'plan-editor', action: 'submit-regen' };
      return isPlainPrintable(context.key)
        ? { owner: 'plan-editor', action: 'edit-regen-reason' }
        : null;
    }
    default:
      return null;
  }
}

function resolveTaskListOwner(key: NormalizedKeySignature): PlanEditorTaskListKeyOwner | null {
  if (key.ctrl) {
    if (key.key === 'j' || key.key === 'n') return taskListOwner('move-down');
    if (key.key === 'k' || key.key === 'p') return taskListOwner('move-up');
    return null;
  }

  if (key.key === 'arrow-down') return taskListOwner('arrow-down');
  if (key.key === 'arrow-up') return taskListOwner('arrow-up');
  if (key.key === 'enter') return taskListOwner('enter');
  if (key.key === 'tab') return taskListOwner('tab');

  if (key.input === 'j') return taskListOwner('j');
  if (key.input === 'k') return taskListOwner('k');
  if (key.input === 'd') return taskListOwner('d');
  if (key.input === 'm') return taskListOwner('m');
  if (key.input === 'x') return taskListOwner('x');
  if (key.input === 'R') return taskListOwner('R');
  if (key.input === 'p') return taskListOwner('p');
  if (key.input === 's') return taskListOwner('s');
  if (key.input === 'E') return taskListOwner('E');
  if (key.input === 'c') return taskListOwner('c');
  if (key.input === '?') return taskListOwner('?');
  if (key.input === 'Y') return taskListOwner('Y');
  if (key.input === 'N') return taskListOwner('N');
  if (key.input === 'q') return taskListOwner('q');

  return null;
}

function resolveSectionListOwner(
  key: NormalizedKeySignature,
): PlanEditorSectionListKeyOwner | null {
  if (key.key === 'escape') return sectionListOwner('escape');
  if (key.key === 'arrow-down') return sectionListOwner('arrow-down');
  if (key.key === 'arrow-up') return sectionListOwner('arrow-up');

  if (key.input === 'j') return sectionListOwner('j');
  if (key.input === 'k') return sectionListOwner('k');
  if (key.input === 'e') return sectionListOwner('e');
  if (key.input === 'c') return sectionListOwner('c');
  if (key.input === 'Y') return sectionListOwner('Y');
  if (key.input === 'N') return sectionListOwner('N');
  if (key.input === 'q') return sectionListOwner('q');
  if (key.input === '?') return sectionListOwner('?');

  return null;
}

function taskListOwner(action: PlanEditorTaskListKeyAction): PlanEditorTaskListKeyOwner {
  return { owner: 'plan-editor', action };
}

function sectionListOwner(action: PlanEditorSectionListKeyAction): PlanEditorSectionListKeyOwner {
  return { owner: 'plan-editor', action };
}

function isCtrlKey(key: NormalizedKeySignature, value: string): boolean {
  return key.ctrl && !key.alt && !key.super && !key.hyper && key.key === value;
}

function isPlainPrintable(key: NormalizedKeySignature): boolean {
  return (
    !key.ctrl &&
    !key.alt &&
    !key.super &&
    !key.hyper &&
    key.input.length > 0 &&
    key.key !== 'unknown'
  );
}

function keySignatureAsScrollKey(key: NormalizedKeySignature) {
  return {
    upArrow: key.key === 'arrow-up',
    downArrow: key.key === 'arrow-down',
    pageUp: key.key === 'page-up',
    pageDown: key.key === 'page-down',
    home: key.key === 'home',
    end: key.key === 'end',
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.alt,
    super: key.super,
    hyper: key.hyper,
  };
}
