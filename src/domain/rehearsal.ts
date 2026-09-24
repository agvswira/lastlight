import { clamp, getRehearsalView, statusAt } from './policy';
import type { RehearsalAction, RehearsalView } from './types';

export function createRehearsal(baseTimestamp = Math.floor(Date.now() / 1000), inactivityPeriod = 90 * 24 * 60 * 60, gracePeriod = 30 * 24 * 60 * 60): RehearsalView {
  return getRehearsalView(baseTimestamp, inactivityPeriod, gracePeriod, 0);
}

export function reduceRehearsal(view: RehearsalView, action: RehearsalAction | { type: 'set-preview'; elapsed: number } | { type: 'set-policy'; inactivityPeriod: number; gracePeriod: number }): RehearsalView {
  if (typeof action === 'object' && action.type === 'set-preview') {
    return getRehearsalView(view.baseTimestamp, view.inactivityPeriod, view.gracePeriod, action.elapsed, { lastAction: undefined });
  }
  if (typeof action === 'object' && action.type === 'set-policy') {
    return getRehearsalView(view.baseTimestamp, action.inactivityPeriod, action.gracePeriod, Math.min(view.previewElapsed, action.inactivityPeriod + action.gracePeriod));
  }
  switch (action) {
    case 'keep-checking-in':
      return getRehearsalView(view.baseTimestamp, view.inactivityPeriod, view.gracePeriod, 0, { lastAction: action });
    case 'miss-check-in':
      return getRehearsalView(view.baseTimestamp, view.inactivityPeriod, view.gracePeriod, view.inactivityPeriod, { lastAction: action });
    case 'return-during-grace': {
      const from = view.previewElapsed;
      if (statusAt(from, view.inactivityPeriod, view.gracePeriod) !== 'GRACE') return { ...view, lastAction: action, returnFrom: from, returnTo: from };
      return getRehearsalView(view.baseTimestamp, view.inactivityPeriod, view.gracePeriod, 0, { lastAction: action, returnFrom: from, returnTo: 0 });
    }
    case 'let-deadline-pass':
      return getRehearsalView(view.baseTimestamp, view.inactivityPeriod, view.gracePeriod, view.inactivityPeriod + view.gracePeriod, { lastAction: action });
  }
}

export function withPreviewProgress(view: RehearsalView, normalized: number): RehearsalView {
  const span = view.inactivityPeriod + view.gracePeriod;
  return reduceRehearsal(view, { type: 'set-preview', elapsed: clamp(normalized, 0, 1) * span });
}
