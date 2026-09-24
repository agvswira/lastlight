import { displayObservedTimestamp, formatDate, isObservationFresh, statusLabel } from '../domain/policy';
import type { Plan, RehearsalView } from '../domain/types';
import { escapeHtml, statusPill, formatStatusTone } from './ui';

type HorizonInput = {
  view: RehearsalView | Plan;
  title?: string;
  titleId?: string;
  compact?: boolean;
  technicalLabels?: boolean;
  sourceLabel?: string;
  actionText?: string;
  statementText?: string;
};

function isRehearsal(view: HorizonInput['view']): view is RehearsalView {
  return view.source === 'rehearsal';
}

export function renderHorizon({ view, title, titleId = 'horizon-title', compact = false, technicalLabels = true, sourceLabel, actionText, statementText }: HorizonInput): string {
  const total = Number(view.inactivityPeriod) + Number(view.gracePeriod);
  const elapsed = isRehearsal(view)
    ? view.previewElapsed
    : Math.min(Math.max(Number(displayObservedTimestamp(view.observation, view.lastHeartbeat) - view.lastHeartbeat), 0), total);
  const progress = total > 0 ? Math.round(Math.min(1, Math.max(0, elapsed / total)) * 100) : 0;
  const split = total > 0 ? Math.round((Number(view.inactivityPeriod) / total) * 100) : 75;
  const status = view.status;
  const stale = !isRehearsal(view) && view.source === 'chain' && !isObservationFresh(view.observation);
  const kicker = stale ? 'Waiting for chain update' : isRehearsal(view) ? 'Interactive rehearsal' : sourceLabel ?? (view.source === 'recorded' ? 'Recorded view' : 'BOT Chain observation');
  const ownerText = stale ? 'Authority waits for a fresh read' : status === 'CLAIMABLE' || status === 'CLAIMED' ? 'Owner control has ended' : status === 'CANCELLED' ? 'Plan closed by owner' : status === 'GRACE' ? 'Check-in still available' : 'Owner can check in';
  const recipientText = stale ? 'Eligibility waits for a fresh read' : status === 'CLAIMABLE' ? 'Recipient can claim' : status === 'CLAIMED' ? 'Recipient received payout' : status === 'CANCELLED' ? 'Plan is closed' : 'Recipient waits';
  const deadline = formatDate(view.claimableAt, true, true);
  const checkIn = formatDate(view.checkInBy, true, true);
  const headingAttributes = title ? ` aria-labelledby="${escapeHtml(titleId)}"` : '';
  const checkMarker = technicalLabels ? 'R' : '1';
  const claimMarker = technicalLabels ? 'D' : '2';
  const claimLegend = technicalLabels ? 'Manual claim after D' : 'Manual claim after the deadline';
  const statement = stale ? 'Waiting for a fresh chain observation.' : statementText ?? (isRehearsal(view) ? 'See what this timing means.' : status === 'CLAIMABLE' ? 'Your recipient can now claim.' : status === 'GRACE' ? 'You still have time to check in.' : status === 'CLAIMED' ? 'The payout is recorded.' : status === 'CANCELLED' ? 'The plan was closed by its owner.' : 'You’re on track.');
  const action = stale ? 'No action until the chain updates' : actionText ?? ownerText;
  return `<section class="horizon horizon--${status.toLowerCase()} ${stale ? 'horizon--stale' : ''} ${compact ? 'horizon--compact' : ''}" style="--horizon-progress:${progress}%;--horizon-split:${split}%"${headingAttributes}>
    <div class="horizon__topline"><div><span class="horizon__eyebrow">${escapeHtml(kicker)}</span>${title ? `<h2 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h2>` : ''}</div>${statusPill(stale ? 'Stale read' : isRehearsal(view) ? 'No transactions' : statusLabel(status), stale ? 'neutral' : formatStatusTone(status))}</div>
    <div class="horizon__statement"><span>${escapeHtml(statement)}</span><strong>${escapeHtml(action)}</strong></div>
    <div class="horizon__graphic" role="img" aria-label="${escapeHtml(`${stale ? 'Stale chain observation. Wait for a fresh update before treating authority as current. ' : ''}Continuity timeline. Check in by ${checkIn}. Claim opens ${deadline}. ${ownerText}; ${recipientText}.`)}">
      <div class="horizon__role horizon__role--owner"><span>Owner</span><small>${escapeHtml(ownerText)}</small></div>
      <div class="horizon__track"><div class="horizon__base"></div><div class="horizon__active"></div><div class="horizon__grace"></div><div class="horizon__cursor"><span>Now</span></div><div class="horizon__milestone horizon__milestone--check"><span>${checkMarker}</span><small>${technicalLabels ? 'Check in by' : 'Next check-in'}<br>${escapeHtml(checkIn)}</small></div><div class="horizon__milestone horizon__milestone--claim"><span>${claimMarker}</span><small>${technicalLabels ? 'Claim opens' : 'Claim available'}<br>${escapeHtml(deadline)}</small></div></div>
      <div class="horizon__role horizon__role--recipient"><span>Recipient</span><small>${escapeHtml(recipientText)}</small></div>
    </div>
    <div class="horizon__legend"><span><i class="legend-dot legend-dot--owner"></i>Check-in interval</span><span><i class="legend-dot legend-dot--grace"></i>Extra time</span><span><i class="legend-dot legend-dot--claim"></i>${claimLegend}</span></div>
    <div class="horizon__summary"><div><span>Check in by</span><strong>${escapeHtml(checkIn)}</strong></div><div><span>Final deadline</span><strong>${escapeHtml(deadline)}</strong></div><div><span>What moves</span><strong>One full payout</strong></div></div>
    ${isRehearsal(view) ? '<p class="horizon__note">Rehearsal only · no wallet calls, no chain state, no payment.</p>' : ''}
    ${!isRehearsal(view) && view.source === 'recorded' ? '<p class="horizon__note">Recorded proof · this page does not replay or broadcast the transaction.</p>' : ''}
  </section>`;
}
