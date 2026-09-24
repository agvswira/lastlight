import { chains, manifests, type DeploymentManifest } from '../app/config';
import { formatDate, formatDateUtc } from '../domain/policy';
import { formatNativeAmount } from '../domain/amount';
import { downloadText } from './calendar';
import type { Plan } from '../domain/types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

export type HandoffSnapshot = Pick<Plan, 'chainId' | 'contract' | 'vaultId' | 'owner' | 'successor' | 'depositedAmount' | 'inactivityPeriod' | 'gracePeriod' | 'lastHeartbeat' | 'claimableAt'> & { observation?: Plan['observation']; label?: string };

export function handoffUrl(plan: Pick<Plan, 'chainId' | 'contract' | 'vaultId'>): string {
  return `${window.location.origin}${window.location.pathname}#/receive/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
}

export function handoffText(plan: HandoffSnapshot): string {
  const chain = chains[plan.chainId];
  const manifest = manifests[plan.chainId];
  const source = sourceReference(plan, manifest, chain);
  return [
    'LASTLIGHT RECIPIENT GUIDE',
    '',
    `Plan ${plan.vaultId.toString()} on ${chain.name}`,
    `Open: ${handoffUrl(plan)}`,
    '',
    `Named recipient: ${plan.successor}`,
    `Owner: ${plan.owner}`,
    `Original allocation: ${formatNativeAmount(plan.depositedAmount)} (${chain.symbol})`,
    `Check-in interval: ${plan.inactivityPeriod.toString()} seconds`,
    `Extra time: ${plan.gracePeriod.toString()} seconds`,
    `Current final deadline snapshot: ${formatDateUtc(plan.claimableAt, true)}`,
    `Observed block snapshot: ${plan.observation?.blockNumber?.toString() ?? 'Unavailable'}`,
    `Observed at: ${plan.observation ? formatDateUtc(plan.observation.blockTimestamp, true) : 'Unavailable'}`,
    '',
    'How to use this plan:',
    '1. Open the link and connect the wallet named above.',
    '2. Check the network and keep native BOT available for gas.',
    '3. Claim is available only after the current chain state reaches the final deadline.',
    '4. Claim is a manual transaction. The funds do not move just because the deadline passes.',
    '',
    'The owner can check in or change the named recipient before the final deadline. This guide is a snapshot; the link always reads the current chain state.',
    'You do not need the owner’s seed phrase.',
    '',
    `Contract: ${plan.contract}`,
    `Explorer: ${chain.explorerUrl}`,
    `Source / code: ${source ?? 'No source verification URL attached to this snapshot'}`,
    `Runtime code hash: ${manifest.runtimeCodeHash ?? 'Not available in this deployment manifest'}`,
    `ABI hash: ${manifest.abiSha256 ?? 'Not available in this deployment manifest'}`,
  ].join('\n');
}

export function handoffHtml(plan: HandoffSnapshot): string {
  const chain = chains[plan.chainId];
  const manifest = manifests[plan.chainId];
  const url = handoffUrl(plan);
  const source = sourceReference(plan, manifest, chain);
  const text = (value: string) => escapeHtml(value);
  const sourceMarkup = source ? `<a href="${text(source)}">${text(source)}</a>` : 'No source verification URL attached to this snapshot';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lastlight recipient guide · Plan ${text(plan.vaultId.toString())}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#20241f;background:#f6f3ec}main{background:#fffdfa;border:1px solid #d6d4ca;border-radius:0;padding:32px}h1{font:42px/1.05 Georgia,serif}code{overflow-wrap:anywhere}li{margin:12px 0}.note{background:#e9e3d8;padding:16px;border-radius:0}dt{color:#5f655d;font-size:13px;margin-top:10px}dd{margin-left:0;overflow-wrap:anywhere}</style></head><body><main><p style="letter-spacing:.12em;text-transform:uppercase;font-size:12px">Lastlight · recipient guide</p><h1>A plan names your wallet.</h1><p>This guide helps you understand a continuity plan without sharing the owner’s seed phrase.</p><dl><dt>Network</dt><dd>${text(chain.name)}</dd><dt>Named recipient</dt><dd><code>${text(plan.successor)}</code></dd><dt>Owner</dt><dd><code>${text(plan.owner)}</code></dd><dt>Allocation</dt><dd>${text(formatNativeAmount(plan.depositedAmount))} (${text(chain.symbol)})</dd><dt>Final deadline snapshot</dt><dd>${text(formatDate(plan.claimableAt, true, true))}</dd><dt>Observed block snapshot</dt><dd>${text(plan.observation?.blockNumber?.toString() ?? 'Unavailable')}</dd><dt>Observed at</dt><dd>${text(plan.observation ? formatDate(plan.observation.blockTimestamp, true, true) : 'Unavailable')}</dd><dt>Contract</dt><dd><code>${text(plan.contract)}</code></dd><dt>Runtime code hash</dt><dd><code>${text(manifest.runtimeCodeHash ?? 'Not available in this deployment manifest')}</code></dd><dt>ABI hash</dt><dd><code>${text(manifest.abiSha256 ?? 'Not available in this deployment manifest')}</code></dd><dt>Source / code</dt><dd>${sourceMarkup}</dd></dl><h2>When it is time</h2><ol><li>Open <a href="${text(url)}">your Lastlight plan</a>.</li><li>Connect the named wallet and check the network and gas.</li><li>Read the current state. The date may move if the owner checks in.</li><li>When the plan is claimable, review the full payout and submit the claim transaction.</li></ol><p class="note">This is a snapshot. The link reads the current chain state. A deadline does not move funds automatically, and you do not need the owner’s seed phrase.</p></main></body></html>`;
}

export function downloadHandoff(plan: HandoffSnapshot): boolean {
  return downloadText(`lastlight-recipient-${plan.chainId}-${plan.vaultId.toString()}.html`, handoffHtml(plan), 'text/html;charset=utf-8');
}

export function downloadHandoffJson(plan: HandoffSnapshot): boolean {
  const verification = handoffVerification(plan);
  const payload = {
    schemaVersion: 'lastlight.handoff.v1',
    locator: { chainId: plan.chainId, contract: plan.contract, vaultId: plan.vaultId.toString(), recipientUrl: handoffUrl(plan) },
    snapshot: { owner: plan.owner, successor: plan.successor, depositedAmountWei: plan.depositedAmount.toString(), inactivityPeriodSeconds: plan.inactivityPeriod.toString(), gracePeriodSeconds: plan.gracePeriod.toString(), lastHeartbeat: plan.lastHeartbeat.toString(), claimableAt: plan.claimableAt.toString(), observedBlock: plan.observation?.blockNumber?.toString() ?? null, observedAt: plan.observation?.blockTimestamp?.toString() ?? null },
    verification,
  };
  return downloadText(`lastlight-locator-${plan.chainId}-${plan.vaultId.toString()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}

function sourceReference(plan: Pick<Plan, 'contract'>, manifest: typeof manifests[Plan['chainId']], chain: typeof chains[Plan['chainId']]): string | null {
  if (manifest.contractAddress?.toLowerCase() !== plan.contract.toLowerCase()) return null;
  const verified = safeHttpUrl(manifest.verifiedSourceUrl);
  if (verified) return verified;
  return `${chain.explorerUrl}/address/${plan.contract}#code`;
}

export function handoffVerification(plan: Pick<Plan, 'chainId' | 'contract'>, deployment: DeploymentManifest = manifests[plan.chainId]): {
  explorerUrl: string | null;
  sourceUrl: string | null;
  runtimeCodeHash: string | null;
  abiSha256: string | null;
  verificationStatus: string;
} {
  const matchesDeployment = deployment.contractAddress?.toLowerCase() === plan.contract.toLowerCase();
  return {
    explorerUrl: matchesDeployment ? `${chains[plan.chainId].explorerUrl}/address/${plan.contract}` : null,
    sourceUrl: matchesDeployment ? sourceReference(plan, deployment, chains[plan.chainId]) : null,
    runtimeCodeHash: matchesDeployment ? deployment.runtimeCodeHash ?? null : null,
    abiSha256: matchesDeployment ? deployment.abiSha256 ?? null : null,
    verificationStatus: matchesDeployment ? deployment.verificationStatus : 'unavailable',
  };
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
