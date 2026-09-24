import testnetDeployment from '../../deployments/968.json';
import mainnetDeployment from '../../deployments/677.json';
import localDeployment from '../../deployments/31337.json';
import type { ChainId } from '../domain/types';

export type DeploymentManifest = {
  schemaVersion: 'dapp.deployment.v1';
  chainId: ChainId;
  network: 'testnet' | 'mainnet' | 'local';
  rpcUrl: string;
  explorerUrl: string;
  contractAddress: `0x${string}` | null;
  deploymentTx: `0x${string}` | null;
  deploymentBlock: string | null;
  deploymentTimestamp: string | null;
  deployer: `0x${string}` | null;
  protocolVersion: string;
  runtimeCodeHash: `0x${string}` | null;
  abiSha256: string | null;
  gitCommit: string | null;
  sourceSha256: string | null;
  compilerVersion: string | null;
  evmVersion: 'paris';
  optimizerRuns: 200;
  viaIr: false;
  verifiedSourceUrl: string | null;
  mainnetWritesEnabled: boolean;
  smokeTestStatus: 'not-run' | 'passed';
  verificationStatus: 'verified' | 'unverified' | 'not-deployed';
};

export const chains: Record<ChainId, {
  id: ChainId;
  name: string;
  shortName: string;
  symbol: string;
  rpcUrl: string;
  explorerUrl: string;
  faucetUrl?: string;
}> = {
  968: { id: 968, name: 'BOT Testnet', shortName: 'Testnet', symbol: 'test BOT', rpcUrl: 'https://rpc.bohr.life', explorerUrl: 'https://scan.bohr.life', faucetUrl: 'https://faucet.botchain.ai/basic' },
  677: { id: 677, name: 'BOT Chain Mainnet', shortName: 'Mainnet', symbol: 'BOT', rpcUrl: 'https://rpc.botchain.ai', explorerUrl: 'https://scan.botchain.ai' },
  31337: { id: 31337, name: 'Local Anvil', shortName: 'Local', symbol: 'BOT', rpcUrl: localDeployment.rpcUrl, explorerUrl: localDeployment.explorerUrl },
};

export const manifests: Record<ChainId, DeploymentManifest> = {
  968: testnetDeployment as DeploymentManifest,
  677: mainnetDeployment as DeploymentManifest,
  31337: localDeployment as DeploymentManifest,
};

export const MAINNET_READY = Boolean(
  manifests[677].contractAddress
  && manifests[677].verificationStatus === 'verified'
  && manifests[677].smokeTestStatus === 'passed'
  && manifests[677].mainnetWritesEnabled,
);

export const DEFAULT_CHAIN: ChainId = MAINNET_READY ? 677 : 968;
export const PROTOCOL_VERSION = '3.0.0';

export function chainName(chainId: number | undefined): string {
  return chainId && chainId in chains ? chains[chainId as ChainId].name : 'Unknown network';
}

export function isSupportedChain(chainId: number | undefined): chainId is ChainId {
  return chainId === 968 || chainId === 677 || chainId === 31337;
}
