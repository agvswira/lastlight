import { getPublicClient, hasDeployment } from './client';
import { lastlightVaultAbi } from './abi';
import { manifests } from '../app/config';
import type { ChainId, Plan, ReceiptEvidence } from '../domain/types';
import { statusAt } from '../domain/policy';
import { loadLabel, loadTransactions } from '../storage/local';

export type ReadBlock = {
  blockNumber: bigint;
  blockTimestamp: bigint;
  blockHash: `0x${string}`;
};

export async function readObservedBlock(chainId: ChainId): Promise<ReadBlock> {
  const block = await getPublicClient(chainId).getBlock({ blockTag: 'latest' });
  if (block.number === null) throw new Error('The RPC returned a latest block without a block number.');
  return { blockNumber: block.number, blockTimestamp: block.timestamp, blockHash: block.hash };
}

export async function readNativeBalance(chainId: ChainId, account: `0x${string}`): Promise<bigint> {
  return getPublicClient(chainId).getBalance({ address: account });
}

export async function readPlanIds(chainId: ChainId, account: `0x${string}`, role: 'owner' | 'successor', offset = 0n, limit = 20n, snapshot?: ReadBlock): Promise<{ ids: bigint[]; total: bigint; observedBlock: ReadBlock }> {
  if (!hasDeployment(chainId)) return { ids: [], total: 0n, observedBlock: snapshot ?? { blockNumber: 0n, blockTimestamp: 0n, blockHash: '0x' } };
  const address = manifests[chainId].contractAddress;
  if (!address) return { ids: [], total: 0n, observedBlock: snapshot ?? { blockNumber: 0n, blockTimestamp: 0n, blockHash: '0x' } };
  const client = getPublicClient(chainId);
  const observedBlock = snapshot ?? await readObservedBlock(chainId);
  const functionName = role === 'owner' ? 'getVaultIdsByOwner' : 'getVaultIdsBySuccessor';
  const result = await client.readContract({ address, abi: lastlightVaultAbi, functionName, args: [account, offset, limit], blockNumber: observedBlock.blockNumber } as any) as readonly [bigint[], bigint] | { ids?: bigint[]; total?: bigint };
  let ids: bigint[] | undefined;
  let total: bigint | undefined;
  if (Array.isArray(result)) {
    ids = result[0];
    total = result[1];
  } else {
    const named = result as { ids?: bigint[]; total?: bigint };
    ids = named.ids;
    total = named.total;
  }
  return { ids: ids ?? [], total: total ?? 0n, observedBlock };
}

export async function readPlan(chainId: ChainId, vaultId: bigint, snapshot?: ReadBlock): Promise<Plan | null> {
  if (!hasDeployment(chainId)) return null;
  const address = manifests[chainId].contractAddress;
  if (!address) return null;
  const client = getPublicClient(chainId);
  const observedBlock = snapshot ?? await readObservedBlock(chainId);
  const result = await client.readContract({ address, abi: lastlightVaultAbi, functionName: 'getVaultView', args: [vaultId], blockNumber: observedBlock.blockNumber });
  const view = (Array.isArray(result) ? result[0] : result) as any;
  if (!view?.vault) throw new Error('The deployment returned an invalid vault view.');
  if (typeof view.observedBlock !== 'bigint' || view.observedBlock !== observedBlock.blockNumber) {
    throw new Error('The RPC returned a plan view from a different observation block. Retry the read.');
  }
  if (typeof view.observedAt !== 'bigint' || view.observedAt !== observedBlock.blockTimestamp) {
    throw new Error('The RPC returned a plan view with a different block timestamp. Retry the read.');
  }
  const vault = view.vault;
  const localTransactions = loadTransactions();
  const knownTransaction = localTransactions.find((entry) => entry.transaction.status === 'confirmed'
    && entry.transaction.hash
    && entry.transaction.chainId === chainId
    && entry.transaction.contract?.toLowerCase() === address.toLowerCase()
    && entry.transaction.vaultId === vaultId.toString());
  const knownTransactions: ReceiptEvidence[] = localTransactions
    .filter((entry) => entry.transaction.status === 'confirmed'
      && entry.transaction.hash
      && entry.transaction.chainId === chainId
      && entry.transaction.contract?.toLowerCase() === address.toLowerCase()
      && entry.transaction.vaultId === vaultId.toString())
    .map(({ transaction }) => ({
      action: transaction.action,
      hash: transaction.hash!,
      nonce: transaction.nonce,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
      blockTimestamp: transaction.blockTimestamp,
      confirmations: transaction.confirmations,
      receiptStatus: transaction.receiptStatus,
      eventName: transaction.eventName,
      eventArgs: transaction.eventArgs,
      gasUsed: transaction.gasUsed,
      effectiveGasPrice: transaction.effectiveGasPrice,
      feeWei: transaction.feeWei,
    }));
  const transactionBlock = knownTransaction?.transaction.blockNumber ?? knownTransaction?.transaction.message?.match(/block (\d+)/i)?.[1];
  let transactionBlockNumber: bigint | undefined;
  try { if (transactionBlock) transactionBlockNumber = BigInt(transactionBlock); } catch { /* corrupted local metadata does not block a chain read */ }
  const statusNames = ['ACTIVE', 'GRACE', 'CLAIMABLE', 'CANCELLED', 'CLAIMED'] as const;
  const status = statusNames[Number(view.status)] ?? 'ACTIVE';
  const optionalBlockValue = (value: unknown): bigint | undefined => typeof value === 'bigint' && value > 0n ? value : undefined;
  const optionalTimeValue = (value: unknown): bigint | undefined => typeof value === 'bigint' && value > 0n ? value : undefined;
  return {
    chainId, contract: address, vaultId,
    owner: vault.owner, successor: vault.successor, previousSuccessor: vault.previousSuccessor,
    settlementRecipient: vault.settlementRecipient, depositedAmount: vault.depositedAmount, amount: vault.amount,
    createdAt: vault.createdAt, lastHeartbeat: vault.lastHeartbeat, inactivityPeriod: vault.inactivityPeriod,
    gracePeriod: vault.gracePeriod, settledAt: optionalTimeValue(vault.settledAt), createdBlock: optionalBlockValue(vault.createdBlock),
    lastHeartbeatBlock: optionalBlockValue(vault.lastHeartbeatBlock), successorChangedBlock: optionalBlockValue(vault.successorChangedBlock), settledBlock: optionalBlockValue(vault.settledBlock),
    settlement: ['NONE', 'CANCELLED', 'CLAIMED'][Number(vault.settlement)] as Plan['settlement'],
    status, checkInBy: view.checkInBy, claimableAt: view.claimableAt, source: 'chain',
    observation: { blockNumber: BigInt(view.observedBlock ?? observedBlock.blockNumber), blockHash: observedBlock.blockHash, blockTimestamp: BigInt(view.observedAt ?? observedBlock.blockTimestamp), receivedAtMonotonicMs: performance.now() },
    transactionHash: knownTransaction?.transaction.hash,
    transactionBlockNumber,
    transactions: knownTransactions.length ? knownTransactions : undefined,
    label: loadLabel(chainId, address, vaultId.toString()),
  };
}

export function statusFromPlan(plan: Pick<Plan, 'status' | 'lastHeartbeat' | 'inactivityPeriod' | 'gracePeriod'>, now: number): Plan['status'] {
  if (plan.status === 'CANCELLED' || plan.status === 'CLAIMED') return plan.status;
  return statusAt(now - Number(plan.lastHeartbeat), Number(plan.inactivityPeriod), Number(plan.gracePeriod));
}
