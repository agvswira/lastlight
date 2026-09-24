#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, isAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const index = process.argv.indexOf('--network');
const network = index >= 0 ? process.argv[index + 1] : undefined;
const configs = {
  testnet: {
    chainId: 968,
    rpcEnv: 'BOT_TESTNET_RPC_URL',
    fallbackRpc: 'https://rpc.bohr.life',
    manifest: 'deployments/968.json',
    txBudgetEnv: 'DEPLOY_MAX_TX_COST_WEI',
    totalBudgetEnv: 'DEPLOY_MAX_TOTAL_SPEND_WEI',
  },
  mainnet: {
    chainId: 677,
    rpcEnv: 'BOT_MAINNET_RPC_URL',
    fallbackRpc: 'https://rpc.botchain.ai',
    manifest: 'deployments/677.json',
    txBudgetEnv: 'MAINNET_MAX_TX_COST_WEI',
    totalBudgetEnv: 'MAINNET_MAX_TOTAL_SPEND_WEI',
  },
};
if (!network || !configs[network]) throw new Error('Choose --network testnet or --network mainnet.');
const config = configs[network];

if (process.env.DEPLOY_APPROVED !== 'true') {
  throw new Error('Deployment is guarded. Set DEPLOY_APPROVED=true only after the owner has approved network, account, artifact, and budget.');
}

const privateKey = process.env.DEPLOY_PRIVATE_KEY?.trim();
if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
  throw new Error('DEPLOY_PRIVATE_KEY must be a 32-byte 0x-prefixed secret supplied outside the repository.');
}
if (privateKey.toLowerCase() === '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') {
  throw new Error('The default Anvil key is not allowed for a public-chain deployment.');
}

const manifest = JSON.parse(await readFile(config.manifest, 'utf8'));
if (manifest.chainId !== config.chainId || manifest.network !== network) {
  throw new Error('Manifest ' + config.manifest + ' does not describe ' + network + ' chain ' + config.chainId + '.');
}
if (manifest.contractAddress) throw new Error('Manifest already has a deployment: ' + manifest.contractAddress);

const build = spawnSync('forge', ['build'], { stdio: 'inherit', encoding: 'utf8' });
if (build.status !== 0) throw new Error('Foundry build failed. No deployment broadcast was attempted.');
const artifact = JSON.parse(await readFile('contracts/out/LastlightVault.sol/LastlightVault.json', 'utf8'));
const source = await readFile('contracts/src/LastlightVault.sol');
const foundryConfig = await readFile('foundry.toml');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashHex = (value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(label + ' is missing from the Foundry artifact.');
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) throw new Error(label + ' is not valid hex bytecode.');
  return sha256(Buffer.from(normalized, 'hex'));
};
const artifactIdentity = {
  abiSha256: sha256(JSON.stringify(artifact.abi ?? [])),
  bytecodeSha256: hashHex(artifact.bytecode?.object, 'Creation bytecode'),
  runtimeBytecodeSha256: hashHex(artifact.deployedBytecode?.object, 'Runtime bytecode'),
  sourceSha256: sha256(source),
};

function expectedHash(name, actual) {
  const expected = process.env[name]?.trim().toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(name + ' must be a 64-character SHA-256 value from the reviewed release artifact.');
  if (expected !== actual) throw new Error(name + ' does not match the reviewed artifact.');
}
expectedHash('DEPLOY_EXPECTED_ABI_SHA256', artifactIdentity.abiSha256);
expectedHash('DEPLOY_EXPECTED_BYTECODE_SHA256', artifactIdentity.bytecodeSha256);
expectedHash('DEPLOY_EXPECTED_RUNTIME_BYTECODE_SHA256', artifactIdentity.runtimeBytecodeSha256);
expectedHash('DEPLOY_EXPECTED_SOURCE_SHA256', artifactIdentity.sourceSha256);
expectedHash('DEPLOY_EXPECTED_FOUNDRY_CONFIG_SHA256', sha256(foundryConfig));

const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
if (gitStatus.status === 0 && gitStatus.stdout.trim()) {
  throw new Error('The release tree is dirty. Commit or remove release changes before broadcasting.');
}

const account = privateKeyToAccount(privateKey);
const deployer = getAddress(account.address);
const expectedDeployer = process.env.DEPLOY_EXPECTED_DEPLOYER?.trim();
if (!expectedDeployer || !isAddress(expectedDeployer)) throw new Error('DEPLOY_EXPECTED_DEPLOYER must be the approved deployment account.');
if (getAddress(expectedDeployer) !== deployer) throw new Error('Approved deployer ' + expectedDeployer + ' does not match the supplied signer.');

function weiEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(name + ' must be a non-negative integer amount in wei.');
  return BigInt(value);
}
const maxTxCostWei = weiEnv(config.txBudgetEnv);
const maxTotalSpendWei = weiEnv(config.totalBudgetEnv);
if (maxTotalSpendWei < maxTxCostWei) throw new Error(config.totalBudgetEnv + ' must be at least ' + config.txBudgetEnv + '.');

const rpcUrl = process.env[config.rpcEnv]?.trim() || manifest.rpcUrl || config.fallbackRpc;
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('RPC HTTP ' + response.status);
  const body = await response.json();
  if (body.error) throw new Error(method + ': ' + JSON.stringify(body.error));
  return body.result;
}

const actualChainId = Number.parseInt(await rpc('eth_chainId'), 16);
if (actualChainId !== config.chainId) throw new Error('RPC returned chain ' + actualChainId + '; expected ' + config.chainId + '. No broadcast was attempted.');

const balanceWei = BigInt(await rpc('eth_getBalance', [deployer, 'latest']));
const gasEstimate = BigInt(await rpc('eth_estimateGas', [{ from: deployer, data: artifact.bytecode.object }, 'latest']));
const gasPriceWei = BigInt(await rpc('eth_gasPrice'));
const estimatedFeeWei = gasEstimate * gasPriceWei;
if (balanceWei < estimatedFeeWei) {
  throw new Error('Deployer balance ' + balanceWei + ' wei is below the estimated deployment fee ' + estimatedFeeWei + ' wei.');
}
if (estimatedFeeWei > maxTxCostWei || estimatedFeeWei > maxTotalSpendWei) {
  throw new Error('Estimated deployment fee ' + estimatedFeeWei + ' wei exceeds the approved spend cap.');
}
console.log(JSON.stringify({
  network,
  chainId: config.chainId,
  rpcUrl,
  deployer,
  artifactIdentity,
  gasEstimate: gasEstimate.toString(),
  gasPriceWei: gasPriceWei.toString(),
  estimatedFeeWei: estimatedFeeWei.toString(),
  balanceWei: balanceWei.toString(),
  approvedTxBudgetWei: maxTxCostWei.toString(),
  approvedTotalBudgetWei: maxTotalSpendWei.toString(),
  preflight: 'passed',
}, null, 2));

async function createTemporaryKeystore(rawPrivateKey) {
  const directory = await mkdtemp(join(tmpdir(), 'lastlight-deploy-'));
  const password = randomBytes(32).toString('hex');
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derivedKey = scryptSync(Buffer.from(password, 'utf8'), salt, 32, { N: 8192, r: 8, p: 1 });
  const cipher = createCipheriv('aes-128-ctr', derivedKey.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(rawPrivateKey.slice(2), 'hex')), cipher.final()]);
  const keystore = {
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n: 8192, p: 1, r: 8, salt: salt.toString('hex') },
      mac: keccak256('0x' + Buffer.concat([derivedKey.subarray(16, 32), ciphertext]).toString('hex')).slice(2),
    },
    id: randomUUID(),
    version: 3,
  };
  const keystorePath = join(directory, 'signer');
  const passwordPath = join(directory, 'password');
  await writeFile(keystorePath, JSON.stringify(keystore), { mode: 0o600 });
  await writeFile(passwordPath, password, { mode: 0o600 });
  return { directory, keystorePath, passwordPath };
}

const signerFiles = await createTemporaryKeystore(privateKey);
let result;
try {
  result = spawnSync('forge', [
    'script',
    'contracts/script/Deploy.s.sol:DeployLastlightVault',
    '--rpc-url',
    rpcUrl,
    '--keystore',
    signerFiles.keystorePath,
    '--password-file',
    signerFiles.passwordPath,
    '--broadcast',
    '--slow',
  ], { stdio: 'inherit', encoding: 'utf8' });
} finally {
  await rm(signerFiles.directory, { recursive: true, force: true });
}
if (result.status !== 0) process.exit(result.status ?? 1);

const broadcastCandidates = [
  'broadcast/Deploy.s.sol/' + config.chainId + '/run-latest.json',
  'broadcast/contracts/script/Deploy.s.sol/' + config.chainId + '/run-latest.json',
];
let broadcastPath = process.env.BROADCAST_FILE;
if (!broadcastPath) {
  for (const candidate of broadcastCandidates) {
    try {
      await readFile(candidate);
      broadcastPath = candidate;
      break;
    } catch { /* try the next Foundry layout */ }
  }
}
if (!broadcastPath) throw new Error('Broadcast completed but no run-latest.json was found in the expected Foundry output paths.');
const broadcast = JSON.parse(await readFile(broadcastPath, 'utf8'));
const deployment = [...(broadcast.transactions || [])].reverse().find((transaction) => transaction.contractName === 'LastlightVault' && transaction.contractAddress);
if (!deployment?.contractAddress || !isAddress(deployment.contractAddress)) {
  throw new Error('Broadcast completed but no LastlightVault CREATE transaction was found in ' + broadcastPath + '.');
}
if (!deployment.hash) throw new Error('Broadcast entry in ' + broadcastPath + ' has no transaction hash.');
const deployedAddress = getAddress(deployment.contractAddress);

const receipt = await rpc('eth_getTransactionReceipt', [deployment.hash]);
if (!receipt) throw new Error('Deployment receipt is not available yet for ' + deployment.hash + '. Keep the manifest pending and reconcile before retrying.');
if (receipt.status && receipt.status !== '0x1') throw new Error('Deployment transaction ' + deployment.hash + ' reverted.');
if (receipt.from && getAddress(receipt.from) !== deployer) throw new Error('Deployment receipt sender ' + receipt.from + ' does not match the approved deployer ' + deployer + '.');
if (receipt.contractAddress && getAddress(receipt.contractAddress) !== deployedAddress) throw new Error('Deployment receipt address does not match the Foundry broadcast.');
if (!receipt.blockNumber) throw new Error('Deployment receipt has no block number; keep the manifest pending and reconcile before retrying.');
const deploymentBlock = BigInt(receipt.blockNumber);
const deploymentBlockRecord = await rpc('eth_getBlockByNumber', ['0x' + deploymentBlock.toString(16), false]);
if (!deploymentBlockRecord?.timestamp) throw new Error('Deployment block has no timestamp; keep the manifest pending and reconcile before retrying.');
const deploymentTimestamp = new Date(Number(BigInt(deploymentBlockRecord.timestamp)) * 1000);
if (Number.isNaN(deploymentTimestamp.getTime())) throw new Error('Deployment block timestamp is invalid.');
const runtimeCode = await rpc('eth_getCode', [deployedAddress, 'latest']);
if (!runtimeCode || runtimeCode === '0x') throw new Error('Deployment receipt exists but the configured address has no runtime bytecode.');
const actualRuntimeBytecodeSha256 = hashHex(runtimeCode, 'Deployed runtime bytecode');
if (actualRuntimeBytecodeSha256 !== artifactIdentity.runtimeBytecodeSha256) {
  throw new Error('Deployed runtime bytecode does not match the reviewed artifact.');
}

const gasUsedWei = BigInt(receipt.gasUsed);
const effectiveGasPriceWei = BigInt(receipt.effectiveGasPrice || gasPriceWei);
const actualFeeWei = gasUsedWei * effectiveGasPriceWei;
if (actualFeeWei > maxTxCostWei || actualFeeWei > maxTotalSpendWei) {
  throw new Error('Actual deployment fee ' + actualFeeWei + ' wei exceeded the approved spend cap; reconcile manually before updating the manifest.');
}

let gitCommit = null;
try {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status === 0) gitCommit = git.stdout.trim();
} catch { /* a source archive may not have git metadata */ }
const sourceVerified = process.env.SOURCE_VERIFIED === 'true';
const verifiedSourceUrl = process.env.VERIFIED_SOURCE_URL || null;
if (sourceVerified && !verifiedSourceUrl) throw new Error('SOURCE_VERIFIED=true requires VERIFIED_SOURCE_URL from the actual explorer verification result.');
const nextManifest = {
  ...manifest,
  contractAddress: deployedAddress,
  deploymentTx: receipt.transactionHash || deployment.hash,
  deploymentBlock: deploymentBlock.toString(),
  deploymentTimestamp: deploymentTimestamp.toISOString(),
  deployer,
  protocolVersion: '3.0.0',
  runtimeCodeHash: keccak256(runtimeCode),
  abiSha256: artifactIdentity.abiSha256,
  gitCommit,
  sourceSha256: artifactIdentity.sourceSha256,
  compilerVersion: '0.8.30',
  verifiedSourceUrl,
  mainnetWritesEnabled: false,
  smokeTestStatus: 'not-run',
  verificationStatus: sourceVerified ? 'verified' : 'unverified',
};
await writeFile(config.manifest, JSON.stringify(nextManifest, null, 2) + '\n');
console.log('Deployment manifest updated from ' + broadcastPath + '. Source verification: ' + nextManifest.verificationStatus + '. Smoke lifecycle remains pending.');
