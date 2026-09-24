#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { getAddress, isAddress, keccak256 } from 'viem';

const hash = process.argv[2];
if (!/^0x[0-9a-f]{64}$/i.test(hash ?? '')) throw new Error('Pass the confirmed deployment transaction hash.');
const expectedDeployer = getAddress('0xe604829a9c327b0d924718CfAcEF69BBdC8C0Efc');
const maxCostWei = 100000000000000000n;
const manifestPath = 'deployments/968.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.chainId !== 968 || manifest.network !== 'testnet' || manifest.contractAddress) throw new Error('Testnet manifest is not pending.');
const artifact = JSON.parse(await readFile('contracts/out/LastlightVault.sol/LastlightVault.json', 'utf8'));
const source = await readFile('contracts/src/LastlightVault.sol');
const release = JSON.parse(await readFile('evidence/local/release-prepare.json', 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashCode = (code) => sha256(Buffer.from(code.slice(2), 'hex'));
if (hashCode(artifact.bytecode.object) !== release.artifact.bytecodeSha256 || sha256(source) !== release.sourceHashes['contracts/src/LastlightVault.sol']) {
  throw new Error('Prepared release identity no longer matches the source or creation bytecode.');
}

async function rpc(method, params = []) {
  const response = await fetch(manifest.rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
if (Number(BigInt(await rpc('eth_chainId'))) !== 968) throw new Error('RPC is not BOT Testnet.');
const transaction = await rpc('eth_getTransactionByHash', [hash]);
const receipt = await rpc('eth_getTransactionReceipt', [hash]);
if (!transaction || !receipt) throw new Error('Deployment transaction is not mined yet. Retry after confirmation.');
if (getAddress(transaction.from) !== expectedDeployer || getAddress(receipt.from) !== expectedDeployer) throw new Error('Transaction sender is not the approved deployer.');
if (transaction.to !== null || !transaction.input || transaction.input.toLowerCase() !== artifact.bytecode.object.toLowerCase()) throw new Error('Transaction is not the reviewed contract creation bytecode.');
if (receipt.status !== '0x1' || !isAddress(receipt.contractAddress ?? '')) throw new Error('Deployment failed or has no contract address.');
const actualFeeWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? transaction.gasPrice);
if (actualFeeWei > maxCostWei) throw new Error('Actual deployment fee exceeded the approved 0.10 BOT cap. Reconcile before recording.');
const contractAddress = getAddress(receipt.contractAddress);
const code = await rpc('eth_getCode', [contractAddress, 'latest']);
if (!code || code === '0x' || hashCode(code) !== release.artifact.runtimeBytecodeSha256) throw new Error('Deployed runtime bytecode differs from the reviewed artifact.');
const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
if (!block?.timestamp) throw new Error('Receipt block timestamp unavailable.');
const deploymentTimestamp = new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
const nextManifest = {
  ...manifest,
  contractAddress,
  deploymentTx: hash,
  deploymentBlock: BigInt(receipt.blockNumber).toString(),
  deploymentTimestamp,
  deployer: expectedDeployer,
  runtimeCodeHash: keccak256(code),
  abiSha256: sha256(JSON.stringify(artifact.abi)),
  gitCommit: null,
  sourceSha256: sha256(source),
  compilerVersion: '0.8.30',
  verifiedSourceUrl: null,
  mainnetWritesEnabled: false,
  smokeTestStatus: 'not-run',
  verificationStatus: 'unverified',
};
await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
console.log(JSON.stringify({ contractAddress, deploymentTx: hash, deploymentBlock: nextManifest.deploymentBlock, deploymentTimestamp, actualFeeWei: actualFeeWei.toString(), actualFeeBOT: Number(actualFeeWei) / 1e18, verificationStatus: 'unverified' }, null, 2));
