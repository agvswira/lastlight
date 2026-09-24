import { decodeEventLog, type Address, type Hash } from 'viem';
import { getPublicClient } from './client';
import { lastlightVaultAbi } from './abi';
import { manifests } from '../app/config';
import type { ChainId } from '../domain/types';

export type ReceiptCheck = {
  hash: Hash;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hash;
  blockTimestamp?: bigint;
  confirmations?: bigint;
  eventName?: string;
  vaultId?: bigint;
  eventArgs?: Record<string, unknown>;
  transactionIndex?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  feeWei?: bigint;
  nonce?: number;
  targetMatches: boolean;
  senderMatches: boolean;
};

export async function verifyReceipt(chainId: ChainId, hash: Hash, expectedSender?: Address, expectedEvent?: string, expectedVaultId?: bigint, expectedAmount?: bigint, expectedRecipient?: Address): Promise<ReceiptCheck> {
  const client = getPublicClient(chainId);
  const receipt = await client.getTransactionReceipt({ hash });
  const manifestAddress = manifests[chainId].contractAddress?.toLowerCase();
  const targetMatches = Boolean(manifestAddress && receipt.to?.toLowerCase() === manifestAddress);
  const senderMatches = !expectedSender || receipt.from.toLowerCase() === expectedSender.toLowerCase();
  let eventName: string | undefined;
  let vaultId: bigint | undefined;
  let eventArgs: Record<string, unknown> | undefined;
  for (const log of receipt.logs) {
    if (manifestAddress && log.address.toLowerCase() !== manifestAddress) continue;
    try {
      const decoded = decodeEventLog({ abi: lastlightVaultAbi, data: log.data, topics: log.topics });
      eventName = decoded.eventName;
      const args = decoded.args as unknown as Record<string, unknown>;
      eventArgs = args;
      if (typeof args.vaultId === 'bigint') vaultId = args.vaultId;
      break;
    } catch { /* unrelated event */ }
  }
  if (expectedEvent && eventName !== expectedEvent) throw new Error(`Receipt event mismatch: expected ${expectedEvent}, got ${eventName ?? 'none'}.`);
  if (expectedVaultId !== undefined && vaultId !== expectedVaultId) throw new Error(`Receipt vault mismatch: expected ${expectedVaultId.toString()}, got ${vaultId?.toString() ?? 'none'}.`);
  if (expectedAmount !== undefined && eventArgs?.amount !== expectedAmount) throw new Error('Receipt amount did not match the prepared action.');
  if (expectedRecipient && eventArgs?.recipient?.toString().toLowerCase() !== expectedRecipient.toLowerCase()) throw new Error('Receipt payout recipient did not match the prepared action.');
  let blockTimestamp: bigint | undefined;
  try { blockTimestamp = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp; } catch { /* receipt remains useful when historical block reads are unavailable */ }
  let confirmations: bigint | undefined;
  try { confirmations = (await client.getBlockNumber()) - receipt.blockNumber + 1n; } catch { /* optional */ }
  let nonce: number | undefined;
  try { nonce = (await client.getTransaction({ hash })).nonce; } catch { /* optional */ }
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice;
  const feeWei = gasUsed !== undefined && effectiveGasPrice !== undefined ? gasUsed * effectiveGasPrice : undefined;
  return {
    hash,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestamp,
    confirmations,
    eventName,
    vaultId,
    eventArgs,
    transactionIndex: receipt.transactionIndex,
    gasUsed,
    effectiveGasPrice,
    feeWei,
    nonce,
    targetMatches,
    senderMatches,
  };
}
