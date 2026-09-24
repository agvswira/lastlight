import { downloadText } from './calendar';
import type { Plan } from '../domain/types';
import { chains } from '../app/config';

export type ReceiptExportOptions = { transactionHash?: string; blockNumber?: string; note?: string };

export function buildReceiptPayload(plan: Plan, extra: ReceiptExportOptions = {}): Record<string, unknown> {
  const transactions = (plan.transactions ?? []).map((transaction) => ({
    action: transaction.action ?? null,
    transactionHash: transaction.hash,
    nonce: transaction.nonce ?? null,
    receiptStatus: transaction.receiptStatus ?? null,
    blockNumber: transaction.blockNumber ?? null,
    blockHash: transaction.blockHash ?? null,
    blockTimestamp: transaction.blockTimestamp ?? null,
    confirmations: transaction.confirmations ?? null,
    eventName: transaction.eventName ?? null,
    eventArgs: transaction.eventArgs ?? null,
    gasUsed: transaction.gasUsed ?? null,
    effectiveGasPrice: transaction.effectiveGasPrice ?? null,
    feeWei: transaction.feeWei ?? null,
    explorerUrl: transaction.hash ? `${chains[plan.chainId].explorerUrl}/tx/${transaction.hash}` : null,
  }));
  const latest = transactions[0] ?? null;
  const payload = {
    schemaVersion: 'lastlight.receipt.v1',
    source: plan.source,
    network: plan.chainId,
    contract: plan.contract,
    vaultId: plan.vaultId.toString(),
    state: plan.status,
    owner: plan.owner,
    successor: plan.successor,
    settlementRecipient: plan.settlementRecipient ?? null,
    settlement: plan.settlement,
    settledAt: plan.settledAt?.toString() ?? null,
    amountWei: plan.depositedAmount.toString(),
    remainingWei: plan.amount.toString(),
    checkInBy: plan.checkInBy.toString(),
    claimableAt: plan.claimableAt.toString(),
    createdBlock: plan.createdBlock?.toString() ?? null,
    lastHeartbeatBlock: plan.lastHeartbeatBlock?.toString() ?? null,
    successorChangedBlock: plan.successorChangedBlock?.toString() ?? null,
    settledBlock: plan.settledBlock?.toString() ?? null,
    observation: plan.observation ? { blockNumber: plan.observation.blockNumber.toString(), blockTimestamp: plan.observation.blockTimestamp.toString() } : null,
    transactionHash: extra.transactionHash ?? null,
    transactionUrl: extra.transactionHash ? `${chains[plan.chainId].explorerUrl}/tx/${extra.transactionHash}` : null,
    blockNumber: extra.blockNumber ?? null,
    receipt: latest,
    transactions,
    note: extra.note ?? (plan.source === 'recorded' ? 'Recorded view; no transaction is broadcast by this page.' : undefined),
  };
  return payload;
}

export function downloadReceipt(plan: Plan, extra: ReceiptExportOptions = {}): boolean {
  const payload = buildReceiptPayload(plan, extra);
  return downloadText(`lastlight-receipt-${plan.chainId}-${plan.vaultId.toString()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}
