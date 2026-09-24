import type { Plan } from '../domain/types';
import { chains, manifests } from '../app/config';
import { button, escapeHtml, formatStatusTone, icon, statusPill } from '../components/ui';
import { formatDateUtc, statusLabel } from '../domain/policy';
import { formatNativeAmount } from '../domain/amount';
import { shortAddress } from '../domain/address';
import { addressBlock, inlineNotice, networkBadge, policyRows } from './shared';

export type ProofReadIssue = { message: string; diagnostic?: unknown };

function safeBigInt(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

export function renderProof(plan: Plan, readIssue?: ProofReadIssue): string {
  const chain = chains[plan.chainId];
  const manifest = manifests[plan.chainId];
  const isRecorded = plan.source === 'recorded';
  const latestReceipt = plan.transactions?.[0];
  const knownTransaction = Boolean(plan.transactionHash);
  const feeWei = safeBigInt(latestReceipt?.feeWei);
  const sourceVerified = manifest.contractAddress?.toLowerCase() === plan.contract.toLowerCase() && manifest.verificationStatus === 'verified';
  const sourceUrl = sourceVerified ? manifest.verifiedSourceUrl : null;
  const explorerContractUrl = `${chain.explorerUrl}/address/${plan.contract}`;
  const readNotice = readIssue ? `${inlineNotice('Latest proof read needs a retry', readIssue.message, 'warning', readIssue.diagnostic)}<button class="button button--quiet" type="button" data-refresh-live>Refresh chain read ${icon('arrow')}</button>` : '';
  const transactionRows = (plan.transactions ?? []).map((transaction) => {
    const transactionFee = safeBigInt(transaction.feeWei);
    return `<article class="known-transaction"><div><strong>${escapeHtml(transaction.eventName ?? transaction.action ?? 'Transaction')}</strong><small>${transaction.blockNumber ? `Block ${escapeHtml(transaction.blockNumber)}` : 'Block unavailable'}${transaction.confirmations ? ` · ${escapeHtml(transaction.confirmations)} confirmations observed` : ''}</small></div><code class="wrap-anywhere">${escapeHtml(transaction.hash)}</code><span>${transactionFee !== undefined ? escapeHtml(formatNativeAmount(transactionFee)) : 'Fee unavailable'}</span></article>`;
  }).join('');
  return `<div class="proof-page">
    <section class="product-hero proof-hero"><div class="shell-width product-hero__inner">
      <div class="product-hero__copy">
        <nav class="plan-breadcrumb" aria-label="Breadcrumb"><a href="#/plans">My plans</a><span aria-hidden="true">/</span><span>Plan #${escapeHtml(plan.vaultId)}</span></nav>
        <h1>Proof &amp; receipt</h1>
        <p class="lede">Current plan state and the transaction evidence available for this plan.</p>
        <div class="proof-hero__meta">${networkBadge(plan.chainId)}${statusPill(isRecorded ? 'Recorded view' : statusLabel(plan.status), isRecorded ? 'neutral' : formatStatusTone(plan.status))}</div>
      </div>
      <img class="product-hero__art" src="/assets/lastlight-hero.webp" alt="" aria-hidden="true">
    </div></section>
    <div class="shell-width proof-layout">
      <div class="proof-main">
        ${readNotice}
        <article class="receipt-card">
          <div class="receipt-card__top"><span class="receipt-card__brand"><img class="wordmark__mark" src="/assets/lastlight-mark.png" alt="" width="32" height="32"><span>Lastlight</span></span><span>${isRecorded ? 'Recorded view' : latestReceipt ? 'Confirmed receipt' : 'Current chain read'}</span></div>
          <h2>${escapeHtml(statusLabel(plan.status))}</h2>
          <strong class="receipt-amount">${escapeHtml(formatNativeAmount(plan.depositedAmount))}</strong>
          <dl class="receipt-details">
            <div><dt>Recipient</dt><dd>${escapeHtml(shortAddress(plan.settlementRecipient ?? plan.successor))}</dd></div>
            <div><dt>Observed at</dt><dd>${escapeHtml(formatDateUtc(Number(plan.observation?.blockTimestamp ?? plan.createdAt), true))}</dd></div>
            <div><dt>Transaction evidence</dt><dd>${isRecorded ? 'No transaction attached' : latestReceipt ? 'Confirmed receipt available' : 'No validated receipt on this device'}</dd></div>
            ${latestReceipt ? `<div><dt>Fee</dt><dd>${feeWei !== undefined ? escapeHtml(formatNativeAmount(feeWei)) : 'Unavailable'}</dd></div>` : ''}
          </dl>
          <div class="receipt-card__actions">${button('Download receipt JSON', { className: 'js-proof-download', icon: 'download' })}${knownTransaction ? button('Open transaction', { href: `${chain.explorerUrl}/tx/${plan.transactionHash}`, variant: 'quiet', icon: 'external' }) : ''}</div>
        </article>
        ${transactionRows ? `<section class="proof-section"><div class="section-heading"><h2>Known transactions</h2><p>Receipts validated for this plan on this device.</p></div><div class="known-transactions">${transactionRows}</div></section>` : ''}
        <section class="proof-section"><div class="section-heading"><h2>Plan timing</h2><p>These dates come from the latest plan observation.</p></div>${policyRows(plan)}</section>
        <details class="proof-technical"><summary>How this proof is checked</summary><div class="proof-technical__content"><p>The current plan state comes from a chain read. Transaction history appears only when a receipt has been validated on this device; a deadline passing is not itself a transaction.</p><dl class="mini-definition"><div><dt>Source verification</dt><dd>${sourceVerified ? 'Verified for this contract' : 'Not verified for this contract'}</dd></div><div><dt>Contract</dt><dd><code>${escapeHtml(plan.contract)}</code></dd></div>${plan.transactionHash ? `<div><dt>Known transaction hash</dt><dd><code>${escapeHtml(plan.transactionHash)}</code></dd></div>` : ''}${latestReceipt?.confirmations ? `<div><dt>Observed confirmations</dt><dd>${escapeHtml(latestReceipt.confirmations)}</dd></div>` : ''}</dl></div></details>
      </div>
      <aside class="proof-aside" aria-label="Contract reference"><div class="side-panel side-panel--light proof-reference"><span class="proof-reference__label">Contract &amp; source</span><h2>${escapeHtml(chain.name)}</h2><dl class="mini-definition"><div><dt>Contract</dt><dd>${escapeHtml(shortAddress(plan.contract))}</dd></div><div><dt>Source</dt><dd>${sourceVerified ? 'Verified' : 'Not verified'}</dd></div></dl><div class="proof-reference__actions"><a class="button button--secondary" href="${escapeHtml(explorerContractUrl)}" target="_blank" rel="noreferrer">${icon('external')}<span>View on explorer</span></a>${sourceUrl && sourceUrl !== explorerContractUrl ? `<a class="button button--quiet" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${icon('external')}<span>Verified source</span></a>` : ''}</div></div><details class="plan-advanced proof-advanced"><summary>Full addresses</summary><div class="plan-advanced__content">${addressBlock('Contract', plan.contract)}${addressBlock('Owner', plan.owner)}${addressBlock('Recipient', plan.successor)}</div></details></aside>
    </div>
  </div>`;
}
