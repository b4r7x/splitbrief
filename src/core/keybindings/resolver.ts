import type { InputMode, OverlayType, Screen } from '../navigation/types.js';
import { resolveScrollKey } from './scroll.js';
import type { NormalizedKeySignature } from './normalize.js';
import { resolveTextEditingKeyAction, type TextEditingKeyAction } from './text.js';

export type KeyAttachState = 'local' | 'attached';

export type FocusedKeySurface = 'none' | 'composer' | 'workflow' | 'review';

export interface KeyResolverContext {
  screen: Screen;
  inputMode: InputMode;
  focus: FocusedKeySurface;
  overlay: OverlayType;
  attachState: KeyAttachState;
  composerFocus: boolean;
  key: NormalizedKeySignature;
}

export type KeyOwner =
  | { owner: 'text-editing'; action: TextEditingKeyAction }
  | { owner: 'workflow'; action: 'toggle-diff' | 'toggle-activity' | 'cost' }
  | { owner: 'conversation-scroll'; action: 'scroll' }
  | { owner: 'review'; action: 'scroll' }
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
  if (context.overlay === 'cost-drilldown') {
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

function isCtrlKey(key: NormalizedKeySignature, value: string): boolean {
  return key.ctrl && !key.alt && !key.super && !key.hyper && key.key === value;
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
