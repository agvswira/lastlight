import type { AppState } from '../app/state';
import type { Plan } from '../domain/types';
import { renderHorizon } from '../components/horizon';
import { button, diagnosticDetails, escapeHtml, formatStatusTone, icon, statusPill } from '../components/ui';
import { formatDate, isObservationFresh, statusLabel } from '../domain/policy';
import { formatNativeAmount } from '../domain/amount';
import { shortAddress } from '../domain/address';
import { addressBlock, inlineNotice, networkBadge, policyRows, readinessRow } from './shared';

function claimAction(state: AppState, plan: Plan): string {
  if (plan.status === 'CLAIMED') return button('Payout settled · no action remains', { disabled: true, variant: 'secondary', icon: 'check' });
  if (plan.status === 'CANCELLED') return button('Closed by owner · no claim remains', { disabled: true, variant: 'secondary', icon: 'warning' });
  if (plan.status !== 'CLAIMABLE') return button('Claim opens after the final deadline', { disabled: true, variant: 'secondary', icon: 'clock' });
  if (plan.source === 'recorded') return button('Recorded view · no claim sent', { disabled: true, icon: 'arrow' });
  if (!isObservationFresh(plan.observation)) return `${button('Checking whether claiming is open', { disabled: true, variant: 'secondary', icon: 'clock' })}<button class="button button--quiet" type="button" data-refresh-live>Refresh chain read</button>`;
  const walletMatch = Boolean(state.wallet.connected && state.wallet.account && state.wallet.account.toLowerCase() === plan.successor.toLowerCase());
  const networkMatch = state.wallet.chainId === plan.chainId;
  if (walletMatch && networkMatch) return `<button class="button button--primary js-plan-action" type="button" data-plan-action="claim">${icon('arrow')}<span>Claim BOT</span></button>`;
  return button(walletMatch ? 'Switch to the plan network' : 'Use the recipient wallet to claim', { disabled: true, icon: 'wallet' });
}

export function renderReceive(state: AppState, plan: Plan): string {
  const walletMatch = Boolean(state.wallet.connected && state.wallet.account && state.wallet.account.toLowerCase() === plan.successor.toLowerCase());
  const networkKnown = Boolean(state.wallet.connected && state.wallet.chainId !== undefined);
  const networkMatch = networkKnown && state.wallet.chainId === plan.chainId;
  const claimFeeKey = state.wallet.account ? `claim:${plan.chainId}:${plan.contract.toLowerCase()}:${state.wallet.account.toLowerCase()}:${plan.vaultId.toString()}:${plan.successor.toLowerCase()}` : '';
  const claimFee = state.actionFeeEstimate?.intentKey === claimFeeKey ? state.actionFeeEstimate : undefined;
  const gasInsufficient = Boolean(claimFee && state.walletBalance !== undefined && state.walletBalance < BigInt(claimFee.feeWei));
  const gasText = claimFee
    ? `${state.walletBalance !== undefined ? `${formatNativeAmount(state.walletBalance)} balance` : 'Balance unavailable'} · estimated ${formatNativeAmount(BigInt(claimFee.feeWei))} gas`
    : state.actionFeeEstimateLoading && plan.status === 'CLAIMABLE' && walletMatch ? 'Estimating claim fee from the selected RPC…'
      : state.walletBalance !== undefined ? `${formatNativeAmount(state.walletBalance)} balance; leave room for gas`
        : state.walletBalanceLoading ? 'Reading native BOT balance…'
          : state.walletBalanceError ? 'Balance read unavailable'
            : plan.status === 'CLAIMABLE' ? 'Connect to check balance and fee'
              : plan.status === 'CLAIMED' ? 'No claim gas required; payout settled'
                : plan.status === 'CANCELLED' ? 'No claim available; plan is closed' : 'Gas is needed to claim; estimate available when claiming opens';
  const gasTone = gasInsufficient ? 'warn' : claimFee ? 'good' : 'neutral';
  const horizonTitle = plan.status === 'CLAIMABLE' ? 'Claiming is open.' : plan.status === 'CLAIMED' ? 'The payout has settled.' : plan.status === 'CANCELLED' ? 'The plan is closed.' : 'The owner can still reset this date.';
  const horizonAction = plan.status === 'CLAIMABLE' ? 'Manual claim' : plan.status === 'CLAIMED' ? 'Payout received' : plan.status === 'CANCELLED' ? 'Closed by owner' : 'Recipient waits';
  const horizonStatement = plan.status === 'CLAIMABLE' ? 'The recipient wallet can claim now.' : plan.status === 'CLAIMED' ? 'The payout is complete.' : plan.status === 'CANCELLED' ? 'This plan can no longer be claimed.' : 'The claim window has not opened yet.';
  const claimWindow = plan.status === 'CLAIMABLE' ? 'Available now' : plan.status === 'CLAIMED' ? 'Settled' : plan.status === 'CANCELLED' ? 'Closed by owner' : `Opens ${formatDate(plan.claimableAt, true, true)}`;
  const networkRow = !state.wallet.connected ? readinessRow('Network', 'Connect to check', 'neutral') : readinessRow('Network', networkMatch ? 'Matches this plan' : 'Switch to the plan network', networkMatch ? 'good' : 'warn');
  const liveReadNotice = state.activePlanError ? `${inlineNotice('Latest read needs a retry', state.activePlanError, 'warning', state.activePlanDiagnostic)}<button class="button button--quiet" type="button" data-refresh-live>Refresh chain read ${icon('arrow')}</button>` : '';
  return `<div class="receive-page">
    <section class="product-hero receive-product-hero"><div class="shell-width product-hero__inner">
      <div class="product-hero__copy">
        <nav class="plan-breadcrumb" aria-label="Breadcrumb"><a href="#/plans">My plans</a><span aria-hidden="true">/</span><span>Plan #${escapeHtml(plan.vaultId)}</span></nav>
        <h1>Recipient view</h1>
        <p class="lede">See when this plan can be claimed and what your wallet needs to do.</p>
        <div class="receive-hero__meta">${networkBadge(plan.chainId)}${statusPill(statusLabel(plan.status), formatStatusTone(plan.status))}</div>
      </div>
      <img class="product-hero__art" src="/assets/lastlight-hero.webp" alt="" aria-hidden="true">
    </div></section>
    <div class="shell-width receive-layout">
      <div class="receive-main">
        ${renderHorizon({ view: plan, technicalLabels: false, title: horizonTitle, sourceLabel: plan.source === 'recorded' ? 'Recorded view' : 'Plan progress', actionText: horizonAction, statementText: horizonStatement })}
        ${liveReadNotice}
        <div class="recipient-action">${claimAction(state, plan)}</div>
        ${plan.status === 'CLAIMABLE' ? '<p class="receive-claim-note">Claiming requires a wallet transaction. The deadline alone does not move funds.</p>' : ''}
        ${state.actionFeeEstimateError ? diagnosticDetails(state.actionFeeEstimateError) : ''}
        ${plan.source === 'recorded' ? inlineNotice('Recorded view · no claim can be sent', 'This example shows the recipient experience, but this project has no configured contract address or receipt. It never turns a fixture into a wallet action.', 'info') : ''}
      </div>
      <aside class="receive-aside" aria-label="Plan allocation"><div class="side-panel side-panel--light receive-allocation">
        <span class="receive-allocation__label">Allocated</span><strong class="big-amount">${escapeHtml(formatNativeAmount(plan.depositedAmount))}</strong>
        <dl class="mini-definition"><div><dt>Recipient</dt><dd>${escapeHtml(shortAddress(plan.successor))}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(shortAddress(plan.owner))}</dd></div><div><dt>Final deadline</dt><dd>${escapeHtml(claimWindow)}</dd></div></dl>
        <div class="receive-allocation__actions"><a class="button button--secondary" href="#/proof/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}">${icon('arrow')}<span>View chain proof</span></a><button class="button button--quiet" type="button" data-download-recipient-calendar>${icon('download')}<span>Download claim reminder</span></button></div>
      </div><details class="plan-advanced receive-advanced"><summary>Full addresses</summary><div class="plan-advanced__content">${addressBlock('Recipient', plan.successor)}${addressBlock('Owner', plan.owner)}</div></details></aside>
      <div class="receive-details">
        <section class="recipient-section"><div class="section-heading"><h2>Before you claim</h2><p>Check the wallet, network, and claim window before confirming a transaction.</p></div><ul class="readiness-list">${readinessRow('Connected wallet', state.wallet.connected ? (walletMatch ? 'Matches the recipient' : 'Use the named recipient wallet') : 'Connect to check', state.wallet.connected ? (walletMatch ? 'good' : 'warn') : 'neutral')}${networkRow}${readinessRow('BOT for gas', gasText, gasTone)}${readinessRow('Claim window', claimWindow, plan.status === 'CLAIMABLE' ? 'good' : 'neutral')}</ul></section>
        <section class="recipient-section"><div class="section-heading"><h2>Plan timing</h2><p>The owner can check in or change the recipient before the final deadline.</p></div>${policyRows(plan)}</section>
      </div>
    </div>
  </div>`;
}
