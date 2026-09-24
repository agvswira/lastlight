import { createWalletClient, custom, defineChain, keccak256, type Address, type Hash } from 'viem';
import { chains, manifests, PROTOCOL_VERSION } from '../app/config';
import { getPublicClient } from './client';
import { generatedAbiSha256, lastlightVaultAbi } from './abi';
import { getInjectedProvider, type Eip1193Provider } from './wallet';
import type { ChainId, FeeEstimate } from '../domain/types';
import { REQUIRED_CONFIRMATIONS } from '../domain/policy';

export type VaultAction =
  | { kind: 'create'; successor: Address; inactivityPeriod: bigint; gracePeriod: bigint; value: bigint }
  | { kind: 'heartbeat'; vaultId: bigint }
  | { kind: 'change-successor'; vaultId: bigint; newSuccessor: Address }
  | { kind: 'cancel'; vaultId: bigint; recipient: Address }
  | { kind: 'claim'; vaultId: bigint; recipient: Address };

export type WriteResult = {
  hash: Hash;
  receipt: Awaited<ReturnType<ReturnType<typeof getPublicClient>['waitForTransactionReceipt']>>;
  chainId: ChainId;
  account: Address;
};

export type WriteHooks = {
  onSubmitted?: (hash: Hash) => void;
  onReplaced?: (hash: Hash, reason: 'cancelled' | 'replaced' | 'repriced') => void;
};

function writeChain(chainId: ChainId) {
  const config = chains[chainId];
  const rpcUrl = manifests[chainId].rpcUrl || config.rpcUrl;
  return defineChain({
    id: chainId,
    name: config.name,
    nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'BOT Explorer', url: config.explorerUrl } },
  });
}

async function assertLiveWriteAllowed(chainId: ChainId, publicClient: ReturnType<typeof getPublicClient>): Promise<Address> {
  const manifest = manifests[chainId];
  if (!manifest.contractAddress || manifest.verificationStatus !== 'verified') throw new Error('No verified Lastlight deployment is configured for this network.');
  if (manifest.protocolVersion !== PROTOCOL_VERSION) throw new Error('The configured deployment uses an incompatible Lastlight protocol version.');
  if (chainId === 677 && (!manifest.mainnetWritesEnabled || manifest.smokeTestStatus !== 'passed')) throw new Error('Mainnet writes are disabled until the verified deployment smoke lifecycle passes.');
  if (!manifest.abiSha256 || (await generatedAbiSha256()).toLowerCase() !== manifest.abiSha256.toLowerCase()) throw new Error('The configured deployment ABI does not match the generated release ABI.');
  const onChainVersion = await publicClient.readContract({ address: manifest.contractAddress, abi: lastlightVaultAbi, functionName: 'PROTOCOL_VERSION' } as any) as string;
  if (onChainVersion !== PROTOCOL_VERSION) throw new Error('The configured contract reports an incompatible Lastlight protocol version.');
  if (manifest.runtimeCodeHash) {
    const bytecode = await publicClient.getBytecode({ address: manifest.contractAddress });
    if (!bytecode || keccak256(bytecode).toLowerCase() !== manifest.runtimeCodeHash.toLowerCase()) throw new Error('The configured contract bytecode does not match the deployment manifest.');
  }
  return manifest.contractAddress;
}

function methodFor(action: VaultAction): { functionName: string; args: readonly unknown[]; value?: bigint } {
  switch (action.kind) {
    case 'create': return { functionName: 'createVault', args: [action.successor, action.inactivityPeriod, action.gracePeriod], value: action.value };
    case 'heartbeat': return { functionName: 'heartbeat', args: [action.vaultId] };
    case 'change-successor': return { functionName: 'changeSuccessor', args: [action.vaultId, action.newSuccessor] };
    case 'cancel': return { functionName: 'cancelVault', args: [action.vaultId, action.recipient] };
    case 'claim': return { functionName: 'claim', args: [action.vaultId, action.recipient] };
  }
}

async function assertWalletNetwork(chainId: ChainId, provider: Eip1193Provider): Promise<void> {
  const walletChain = await provider.request({ method: 'eth_chainId' });
  const walletChainId = typeof walletChain === 'string' ? Number.parseInt(walletChain, walletChain.startsWith('0x') ? 16 : 10) : Number(walletChain);
  if (walletChainId !== chainId) throw new Error(`Wrong network: wallet is on chain ${walletChainId}; expected ${chainId}.`);
}

async function assertWalletAccount(account: Address, provider: Eip1193Provider): Promise<void> {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const activeAccounts = Array.isArray(accounts) ? accounts : [];
  if (!activeAccounts.some((value) => typeof value === 'string' && value.toLowerCase() === account.toLowerCase())) {
    throw new Error(`Wallet account changed: expected ${account}. Reconnect the named wallet before signing.`);
  }
}

function actionIntentKey(chainId: ChainId, account: Address, action: VaultAction): string {
  const method = methodFor(action);
  return `${chainId}:${account.toLowerCase()}:${method.functionName}:${method.args.map(String).join(':')}:${method.value?.toString() ?? '0'}`;
}

export async function estimateVaultAction(chainId: ChainId, account: Address, action: VaultAction, provider: Eip1193Provider = getInjectedProvider() as Eip1193Provider, intentKey = actionIntentKey(chainId, account, action)): Promise<FeeEstimate> {
  if (!provider) throw new Error('Use a wallet browser to estimate transaction fees.');
  const publicClient = getPublicClient(chainId);
  const address = await assertLiveWriteAllowed(chainId, publicClient);
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) throw new Error(`RPC returned chain ${actualChainId}; expected ${chainId}.`);
  await assertWalletNetwork(chainId, provider);
  await assertWalletAccount(account, provider);
  const method = methodFor(action);
  const gasLimit = await publicClient.estimateContractGas({
    address, abi: lastlightVaultAbi, functionName: method.functionName as any, args: method.args as any, value: method.value, account,
  } as any);
  const gasPriceWei = await publicClient.getGasPrice();
  const observedBlock = await publicClient.getBlockNumber();
  return {
    intentKey,
    chainId,
    contract: address,
    account,
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPriceWei.toString(),
    feeWei: (gasLimit * gasPriceWei).toString(),
    valueWei: (method.value ?? 0n).toString(),
    observedBlock: observedBlock.toString(),
  };
}

export async function executeVaultAction(chainId: ChainId, account: Address, action: VaultAction, provider: Eip1193Provider = getInjectedProvider() as Eip1193Provider, hooks: WriteHooks = {}): Promise<WriteResult> {
  if (!provider) throw new Error('Use a wallet browser to make transactions.');
  const publicClient = getPublicClient(chainId);
  const address = await assertLiveWriteAllowed(chainId, publicClient);
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) throw new Error(`RPC returned chain ${actualChainId}; expected ${chainId}.`);
  await assertWalletNetwork(chainId, provider);
  await assertWalletAccount(account, provider);
  const walletClient = createWalletClient({ account, chain: writeChain(chainId), transport: custom(provider as any) });
  const method = methodFor(action);
  const simulation = await publicClient.simulateContract({
    address, abi: lastlightVaultAbi, functionName: method.functionName as any, args: method.args as any, value: method.value, account,
  } as any);
  await assertWalletNetwork(chainId, provider);
  await assertWalletAccount(account, provider);
  const hash = await walletClient.writeContract(simulation.request as any);
  hooks.onSubmitted?.(hash);
  let resolvedHash = hash;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: Number(REQUIRED_CONFIRMATIONS),
    timeout: 120_000,
    onReplaced: (replacement) => {
      resolvedHash = replacement.transactionReceipt.transactionHash;
      hooks.onReplaced?.(resolvedHash, replacement.reason);
    },
  });
  if (receipt.status !== 'success') {
    const error = new Error('The transaction was included but reverted on-chain.');
    Object.assign(error, { code: 'ONCHAIN_REVERTED' });
    throw error;
  }
  return { hash: receipt.transactionHash ?? resolvedHash, receipt, chainId, account };
}
