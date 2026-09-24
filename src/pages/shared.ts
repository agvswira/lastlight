import { chains, manifests } from '../app/config';
import { button, diagnosticDetails, escapeHtml, icon, statusPill } from '../components/ui';
import { displayObservedTimestamp, formatDate, formatDateUtc, formatDuration, statusLabel, statusKicker, formatRelativeDeadline } from '../domain/policy';
import { formatNativeAmount } from '../domain/amount';
import { shortAddress } from '../domain/address';
import type { Plan, RehearsalView } from '../domain/types';

export function pageIntro(eyebrow: string, title: string, copy: string, className = ''): string {
  return `<div class="page-intro ${className}"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(copy)}</p></div>`;
}

export function networkBadge(chainId: number): string {
  const chain = chains[chainId as keyof typeof chains];
  return `<span class="network-badge"><span class="network-badge__dot"></span>${escapeHtml(chain?.name ?? 'Unknown network')}</span>`;
}

export function policyRows(plan: Pick<Plan, 'inactivityPeriod' | 'gracePeriod' | 'checkInBy' | 'claimableAt'> | RehearsalView): string {
  return `<dl class="policy-list"><div><dt>Check-in interval</dt><dd>${escapeHtml(formatDuration(Number(plan.inactivityPeriod)))}</dd></div><div><dt>Extra time</dt><dd>${escapeHtml(formatDuration(Number(plan.gracePeriod)))}</dd></div><div><dt>Check in by · R</dt><dd>${escapeHtml(formatDate(plan.checkInBy, true, true))}</dd></div><div><dt>Final deadline · D</dt><dd>${escapeHtml(formatDate(plan.claimableAt, true, true))}</dd></div></dl>`;
}

export function planMeta(plan: Plan): string {
  return `<div class="plan-meta"><span>Plan #${escapeHtml(plan.vaultId)}</span><span>${networkBadge(plan.chainId)}</span><span>${escapeHtml(plan.source === 'recorded' ? 'Recorded proof' : 'Chain observation')}</span></div>`;
}

export function addressBlock(label: string, address: string, copy = true): string {
  return `<div class="address-block"><span>${escapeHtml(label)}</span><code>${escapeHtml(address)}</code>${copy ? `<button class="text-copy js-copy" data-copy="${escapeHtml(address)}" type="button">${icon('copy')}<span>Copy</span></button>` : ''}</div>`;
}

export function readinessRow(label: string, value: string, tone: 'good' | 'warn' | 'neutral' = 'neutral', detail = ''): string {
  return `<li class="readiness-row readiness-row--${tone}"><span class="readiness-icon">${tone === 'good' ? icon('check') : tone === 'warn' ? icon('warning') : icon('clock')}</span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(value)}${detail ? ` · ${escapeHtml(detail)}` : ''}</small></span></li>`;
}

export function proofStrip(): string {
  const manifest = manifests[968];
  const deployed = Boolean(manifest.contractAddress);
  return `<section class="proof-strip"><div><p class="eyebrow">Proof status</p><h2>${deployed ? 'Testnet deployment configured' : 'Deployment pending'}</h2><p>${deployed ? 'The testnet proof route reads the allowlisted contract and keeps source verification separate.' : 'The public experience is ready for a verified deployment. No address is invented here.'}</p></div><div class="proof-strip__status"><span class="status-dot status-dot--${deployed ? 'success' : 'warning'}"></span><span>${deployed ? escapeHtml(manifest.contractAddress!) : 'Testnet contract not configured'}</span></div><a class="button button--secondary" href="#/?section=how-it-works">How it works ${icon('arrow')}</a></section>`;
}

export function planCard(plan: Plan, href: string, note = '', fallbackLabel?: string): string {
  const tone = plan.status === 'ACTIVE' ? 'active' : plan.status === 'GRACE' ? 'grace' : plan.status === 'CLAIMABLE' ? 'claimable' : 'terminal';
  const displayNow = Number(displayObservedTimestamp(plan.observation, plan.lastHeartbeat));
  const deadline = plan.status === 'CLAIMABLE' ? 'Claim is open' : formatRelativeDeadline(plan.claimableAt, displayNow);
  return `<article class="plan-row plan-row--${tone}"><div class="plan-row__main"><div class="plan-row__top"><span class="plan-row__number">Plan #${escapeHtml(plan.vaultId)}</span>${statusPill(statusLabel(plan.status), tone)}</div><h3>${escapeHtml(plan.label ?? plan.recordedLabel ?? fallbackLabel ?? `BOT continuity plan #${plan.vaultId.toString()}`)}</h3><p>${escapeHtml(formatNativeAmount(plan.depositedAmount))} · ${escapeHtml(deadline)}</p>${note ? `<small class="plan-row__note">${escapeHtml(note)}</small>` : ''}</div><a class="button button--quiet plan-row__open" href="${escapeHtml(href)}">Open ${icon('arrow')}</a></article>`;
}

export function inlineNotice(title: string, message: string, tone: 'info' | 'warning' | 'success' | 'danger' = 'info', diagnostic?: unknown): string {
  return `<aside class="inline-notice inline-notice--${tone}" role="status"><span class="inline-notice__icon">${icon(tone === 'warning' || tone === 'danger' ? 'warning' : tone === 'success' ? 'check' : 'clock')}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${diagnosticDetails(diagnostic)}</div></aside>`;
}

export function deploymentTable(): string {
  return `<div class="table-wrap"><table class="deployment-table"><thead><tr><th>Network</th><th>Contract</th><th>Source</th><th>Status</th></tr></thead><tbody>${Object.values(manifests).filter((manifest) => manifest.chainId !== 31337).map((manifest) => { const address = manifest.contractAddress; const status = address ? manifest.verificationStatus : 'not-deployed'; const source = address ? (manifest.verifiedSourceUrl ?? 'Verification URL unavailable') : 'Not available until deployment'; return `<tr><th>${escapeHtml(chains[manifest.chainId].name)}</th><td>${address ? `<a href="${escapeHtml(`${chains[manifest.chainId].explorerUrl}/address/${address}`)}" target="_blank" rel="noreferrer"><code>${escapeHtml(address)}</code> ${icon('external')}</a>` : '<code>Not deployed</code>'}</td><td>${escapeHtml(source)}</td><td>${statusPill(address ? status : 'Not deployed', address ? (status === 'verified' ? 'active' : 'neutral') : 'neutral')}</td></tr>`; }).join('')}</tbody></table></div>`;
}
