import '../styles/component-gallery.css';
import { cloneDemoPlan } from '../app/demo-data';
import { renderActionDialog } from '../components/action-dialog';
import { renderHorizon } from '../components/horizon';
import { getRehearsalView, statusLabel } from '../domain/policy';
import type { Plan } from '../domain/types';
import { button, escapeHtml, icon, statusPill, formatStatusTone } from '../components/ui';

function galleryPlan(status: Plan['status'], elapsed: number): Plan {
  const now = Math.floor(Date.now() / 1000);
  const heartbeat = BigInt(now - elapsed);
  const inactivity = 180n;
  const grace = 180n;
  return cloneDemoPlan({
    label: `Gallery · ${statusLabel(status)}`,
    lastHeartbeat: heartbeat,
    checkInBy: heartbeat + inactivity,
    claimableAt: heartbeat + inactivity + grace,
    status,
    amount: status === 'CLAIMED' || status === 'CANCELLED' ? 0n : cloneDemoPlan().depositedAmount,
    settlement: status === 'CLAIMED' ? 'CLAIMED' : status === 'CANCELLED' ? 'CANCELLED' : 'NONE',
    settledAt: status === 'CLAIMED' || status === 'CANCELLED' ? BigInt(now) : undefined,
    settlementRecipient: status === 'CLAIMED' ? cloneDemoPlan().successor : undefined,
    observation: {
      blockNumber: 123n,
      blockHash: '0x' as `0x${string}`,
      blockTimestamp: BigInt(now),
      receivedAtMonotonicMs: performance.now(),
    },
  });
}

export function renderComponentGallery(): string {
  const base = Math.floor(Date.now() / 1000);
  const rehearsalViews = [
    getRehearsalView(base, 90, 30, 45),
    getRehearsalView(base, 90, 30, 100),
    getRehearsalView(base, 90, 30, 130),
  ];
  const planViews = [
    galleryPlan('ACTIVE', 30),
    galleryPlan('GRACE', 200),
    galleryPlan('CLAIMABLE', 400),
    galleryPlan('CLAIMED', 400),
    galleryPlan('CANCELLED', 400),
  ];
  const dialog = renderActionDialog({
    id: 'gallery-action-dialog',
    title: 'Check in to reset the horizon?',
    description: 'Review the exact plan, destination, and estimated network fee before signing.',
    actionLabel: 'Review in wallet',
    rows: [['Plan', '#7 · BOT Testnet'], ['Action', 'Heartbeat'], ['New deadline', '12 Jun 2027, 09:00']],
    fee: '0.0004 BOT',
    warning: 'A signature is not inclusion. Leave time for the transaction to be mined before D.',
  }).replace('<dialog ', '<dialog open ');
  return `<div class="component-gallery"><section class="shell-width component-gallery__header"><p class="eyebrow">Development only</p><h1>Component gallery</h1><p>Static review surface for the shared timeline, status language, controls, and transaction confirmation dialog. No wallet or RPC calls are made here.</p><a class="button button--secondary" href="#/?section=how-it-works">${icon('arrow')}<span>Back to product</span></a></section><section class="shell-width component-gallery__section"><div class="section-heading"><p class="eyebrow">Horizon states</p><h2>One visual grammar, three rehearsal moments.</h2></div><div class="component-gallery__grid component-gallery__grid--horizons">${rehearsalViews.map((view, index) => `<article class="component-gallery__card"><div class="component-gallery__label">${escapeHtml(statusLabel(view.status))} · rehearsal</div>${renderHorizon({ view, title: 'Continuity horizon', titleId: `gallery-rehearsal-${index}`, compact: true, sourceLabel: 'Interactive rehearsal', actionText: 'No transactions' })}</article>`).join('')}</div></section><section class="shell-width component-gallery__section"><div class="section-heading"><p class="eyebrow">Plan states</p><h2>Readiness and terminal outcomes stay distinct.</h2></div><div class="component-gallery__grid component-gallery__grid--plans">${planViews.map((plan, index) => `<article class="component-gallery__card"><div class="component-gallery__card-top"><strong>${escapeHtml(plan.label)}</strong>${statusPill(statusLabel(plan.status), formatStatusTone(plan.status))}</div>${renderHorizon({ view: plan, title: 'Plan horizon', titleId: `gallery-plan-${index}`, compact: true, sourceLabel: 'Recorded component state', actionText: statusLabel(plan.status) })}</article>`).join('')}</div></section><section class="shell-width component-gallery__section component-gallery__controls"><div class="section-heading"><p class="eyebrow">Controls and feedback</p><h2>Actions explain their consequence.</h2></div><div class="component-gallery__control-row">${button('Primary action', { icon: 'arrow' })}${button('Secondary action', { variant: 'secondary', icon: 'check' })}${button('Quiet action', { variant: 'quiet', icon: 'download' })}${button('Danger action', { variant: 'danger', icon: 'warning' })}</div><div class="component-gallery__feedback"><span class="draft-status"><span class="draft-status__dot"></span>Draft saved locally</span><span class="mode-badge mode-badge--small">${statusPill('No transactions', 'neutral')}</span></div></section><section class="shell-width component-gallery__section"><div class="section-heading"><p class="eyebrow">Confirmation dialog</p><h2>Review the intent before the wallet opens.</h2></div><div class="component-gallery__dialog-preview">${dialog}</div></section></div>`;
}
