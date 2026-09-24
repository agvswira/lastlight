import type { AppState } from '../app/state';
import type { Plan } from '../domain/types';
import { renderHorizon } from '../components/horizon';
import { button, escapeHtml, icon, statusPill, formatStatusTone } from '../components/ui';
import { displayObservedTimestamp, formatRelativeDeadline, isObservationFresh, statusLabel, statusKicker } from '../domain/policy';
import { formatNativeAmount } from '../domain/amount';
import { shortAddress } from '../domain/address';
import { chains, manifests } from '../app/config';
import { addressBlock, inlineNotice, networkBadge, policyRows } from './shared';
import { handoffText } from '../exports/handoff';

function planAction(label: string, action: 'heartbeat' | 'change-successor' | 'cancel', variant: 'primary' | 'secondary' | 'danger', iconName: 'clock' | 'arrow' | 'warning', disabled = false): string {
  return `<button class="button button--${variant} js-plan-action" type="button" data-plan-action="${action}"${disabled ? ' disabled aria-disabled="true"' : ''}>${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;
}

function ownerActions(state: AppState, plan: Plan, isRecorded: boolean): string {
  if (isRecorded) return inlineNotice('Recorded view is read-only', 'This fixture explains the handoff. It has no configured contract address and cannot ask your wallet to sign.', 'info');
  if (manifests[plan.chainId]?.verificationStatus !== 'verified') return inlineNotice('Plan actions are paused', 'Source verification is still pending for this deployment. You can inspect this plan, but Lastlight will not request a signature yet.', 'info');
  if (!state.wallet.connected || !state.wallet.account) return inlineNotice('Owner controls are wallet-gated', 'Connect the wallet named as owner to review check-in, recipient change, or close actions. This page remains readable without a wallet.', 'info');
  if (state.wallet.chainId !== plan.chainId) return inlineNotice('Switch to the plan network', `Owner actions are available on ${chains[plan.chainId].name} after the selected wallet is on the same chain.`, 'warning');
  if (state.wallet.account.toLowerCase() !== plan.owner.toLowerCase() && state.wallet.account.toLowerCase() === plan.successor.toLowerCase()) return '';
  if (state.wallet.account.toLowerCase() !== plan.owner.toLowerCase()) return inlineNotice('Owner wallet required', 'The connected wallet is not the owner named by this plan. Recipient access is shown separately.', 'warning');
  if (plan.status === 'ACTIVE' || plan.status === 'GRACE') {
    const stale = !isObservationFresh(plan.observation);
    const secondsUntilDeadline = plan.status === 'GRACE' && !stale
      ? Number(plan.claimableAt - displayObservedTimestamp(plan.observation, plan.lastHeartbeat))
      : Number.POSITIVE_INFINITY;
    const deadlineWarning = secondsUntilDeadline <= 60
      ? inlineNotice('Confirmation may arrive too late', 'A signature is not inclusion. Leave time for the transaction to be mined before D.', 'warning')
      : '';
    return `${stale ? inlineNotice('Last read is stale', 'Writes stay disabled until a fresh chain observation is available.', 'warning') : ''}${deadlineWarning}<div class="action-row">${planAction(plan.status === 'GRACE' ? 'Check in now' : 'Check in', 'heartbeat', 'primary', 'clock', stale)}${planAction('Change recipient', 'change-successor', 'secondary', 'arrow', stale)}${planAction('Close plan', 'cancel', 'danger', 'warning', stale)}</div>${stale ? '<button class="button button--quiet" type="button" data-refresh-live>Refresh chain read</button>' : ''}`;
  }
  if (plan.status === 'CLAIMABLE') return inlineNotice('Your control has ended', 'The final deadline has passed. The recipient may claim, but the owner cannot reset or close this plan.', 'warning');
  return inlineNotice(statusLabel(plan.status), 'This plan is settled and its state cannot be reopened.', 'info');
}

export function renderPlan(state: AppState, plan: Plan): string {
  const tone = formatStatusTone(plan.status);
  const isRecorded = plan.source === 'recorded';
  const recipientUrl = `#/receive/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
  const receiptUrl = `#/proof/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
  const ownerReminderAvailable = plan.status === 'ACTIVE' || plan.status === 'GRACE';
  const hasConfirmedHeartbeat = Boolean(plan.transactions?.some((transaction) => transaction.action === 'heartbeat'));
  const reminderLabel = hasConfirmedHeartbeat ? 'Download updated reminder' : 'Download calendar reminder';
  const stale = plan.source === 'chain' && !isObservationFresh(plan.observation);
  const claimLink = plan.status === 'CLAIMABLE'
    ? button('Open recipient claim view', { href: recipientUrl, icon: 'arrow' })
    : '';
  const displayNow = Number(displayObservedTimestamp(plan.observation, plan.lastHeartbeat));
  const liveReadNotice = state.activePlanError ? `${inlineNotice('Latest read needs a retry', state.activePlanError, 'warning', state.activePlanDiagnostic)}<button class="button button--quiet" type="button" data-refresh-live>Refresh chain read ${icon('arrow')}</button>` : '';
  const recipientLink = window.location.origin + window.location.pathname + recipientUrl;
  const title = plan.label ?? plan.recordedLabel ?? `BOT continuity plan #${plan.vaultId.toString()}`;
  const remainingAmount = plan.amount !== plan.depositedAmount
    ? `<div><dt>Remaining amount</dt><dd>${escapeHtml(formatNativeAmount(plan.amount))}</dd></div>`
    : '';
  return `<div class="plan-page">
    <section class="product-hero plan-hero"><div class="shell-width product-hero__inner">
      <div class="product-hero__copy">
        <nav class="plan-breadcrumb" aria-label="Breadcrumb"><a href="#/plans">My plans</a><span aria-hidden="true">/</span><span>Plan #${escapeHtml(plan.vaultId)}</span></nav>
        <h1>${escapeHtml(title)}</h1>
        <div class="plan-hero__meta">${networkBadge(plan.chainId)}${statusPill(statusLabel(plan.status), tone)}</div>
      </div>
      <img class="product-hero__art" src="./assets/lastlight-hero.webp" alt="" aria-hidden="true">
    </div></section>
    <div class="shell-width plan-layout">
      <div class="plan-main">
        ${renderHorizon({ view: plan, technicalLabels: false, title: plan.status === 'CLAIMABLE' ? 'Your recipient can now claim.' : 'Your plan at a glance', sourceLabel: isRecorded ? 'Recorded testnet run' : 'Plan progress', actionText: plan.status === 'CLAIMABLE' ? 'Claim is available' : statusKicker(plan.status) })}
        ${liveReadNotice}
        ${stale ? inlineNotice('Observation needs refresh', 'This view is frozen after 20 seconds without a fresh successful chain read.', 'warning') : ''}
        <div class="plan-action-area">${claimLink ? `<div class="action-row">${claimLink}</div>` : ''}${ownerActions(state, plan, isRecorded)}</div>
      </div>
      <aside class="plan-aside" aria-label="Plan allocation and details"><div class="side-panel side-panel--light plan-allocation"><span class="plan-allocation__label">Allocated</span><strong class="big-amount">${escapeHtml(formatNativeAmount(plan.depositedAmount))}</strong><dl class="mini-definition">${remainingAmount}<div><dt>Owner</dt><dd>${escapeHtml(shortAddress(plan.owner))}</dd></div><div><dt>Recipient</dt><dd>${escapeHtml(shortAddress(plan.successor))}</dd></div><div><dt>Final deadline</dt><dd>${escapeHtml(formatRelativeDeadline(plan.claimableAt, displayNow))}</dd></div></dl><div class="plan-allocation__actions">${button('View chain proof', { href: receiptUrl, variant: 'secondary', icon: 'arrow' })}<button class="button button--quiet" type="button" data-download-calendar="owner" ${ownerReminderAvailable ? '' : 'disabled'}>${icon('download')}<span>${ownerReminderAvailable ? reminderLabel : 'Reminder unavailable after deadline'}</span></button></div></div><details class="plan-advanced"><summary>Addresses &amp; receipt</summary><div class="plan-advanced__content">${addressBlock('Contract', plan.contract)}${addressBlock('Owner', plan.owner)}${addressBlock('Recipient', plan.successor)}<button class="button button--quiet" type="button" data-download-receipt>${icon('download')}<span>Download receipt JSON</span></button></div></details></aside>
      <div class="plan-details">
        <section class="plan-section"><div class="section-heading"><h2>Plan timing</h2><p>Only a confirmed check-in renews this plan’s deadline.</p></div>${policyRows(plan)}</section>
        <section class="plan-section handoff-section"><div class="section-heading"><h2>Share with recipient</h2><p>Send this link so your recipient can inspect the plan when needed.</p></div><div class="handoff-preview"><div><span class="handoff-preview__label">Recipient link</span><code>${escapeHtml(recipientLink)}</code></div><div class="handoff-preview__actions"><button class="button button--secondary js-copy" data-copy="${escapeHtml(recipientLink)}" type="button">${icon('copy')}<span>Copy link</span></button><button class="button button--quiet" type="button" data-download-handoff="html">${icon('download')}<span>Download HTML</span></button><button class="button button--quiet" type="button" data-download-handoff="json">${icon('download')}<span>Download locator</span></button></div></div><details class="handoff-instructions"><summary>Plain-text instructions</summary><pre class="plain-instructions">${escapeHtml(handoffText(plan))}</pre><button class="button button--quiet js-copy" data-copy="${escapeHtml(handoffText(plan))}" type="button">${icon('copy')}<span>Copy instructions</span></button></details></section>
      </div>
    </div>
  </div>`;
}
