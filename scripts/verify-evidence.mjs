#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { createPublicClient, decodeEventLog, defineChain, http } from 'viem';

const manifestRoot = process.env.LASTLIGHT_MANIFEST_ROOT ?? 'deployments';
const evidenceRoot = process.env.LASTLIGHT_EVIDENCE_ROOT ?? 'evidence';
const abiPath = process.env.LASTLIGHT_ABI_PATH ?? 'src/generated/lastlightVaultAbi.json';
const manifestFiles = ['968.json', '677.json', '31337.json'].map((file) => `${manifestRoot}/${file}`);
const manifests = new Map();
let failed = false;

for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifests.set(manifest.chainId, manifest);
  const required = ['schemaVersion', 'chainId', 'network', 'rpcUrl', 'explorerUrl', 'contractAddress', 'deploymentTx', 'deploymentBlock', 'deploymentTimestamp', 'deployer', 'protocolVersion', 'runtimeCodeHash', 'abiSha256', 'gitCommit', 'sourceSha256', 'compilerVersion', 'evmVersion', 'optimizerRuns', 'viaIr', 'verifiedSourceUrl', 'mainnetWritesEnabled', 'smokeTestStatus', 'verificationStatus'];
  const missing = required.filter((key) => !(key in manifest));
  if (missing.length) { failed = true; console.error(`${file}: missing ${missing.join(', ')}`); continue; }
  if (!['verified', 'unverified', 'not-deployed'].includes(manifest.verificationStatus)) { failed = true; console.error(`${file}: invalid verificationStatus`); }
  if (manifest.verificationStatus === 'not-deployed' && (manifest.contractAddress || manifest.deploymentTx || manifest.deploymentBlock || manifest.deploymentTimestamp)) { failed = true; console.error(`${file}: not-deployed manifest must not contain deployment identity`); }
  if (manifest.contractAddress && (!manifest.deploymentTx || !manifest.deploymentBlock || !manifest.deploymentTimestamp || !manifest.runtimeCodeHash || !manifest.abiSha256 || !manifest.deployer)) { failed = true; console.error(`${file}: deployed manifest is missing receipt, timestamp, or artifact identity`); }
  if (manifest.deploymentTimestamp !== null && Number.isNaN(Date.parse(manifest.deploymentTimestamp))) { failed = true; console.error(`${file}: deploymentTimestamp must be an ISO date`); }
  if (manifest.verificationStatus === 'verified' && !manifest.verifiedSourceUrl) { failed = true; console.error(`${file}: verified deployment is missing verifiedSourceUrl`); }
  if (manifest.mainnetWritesEnabled && (manifest.chainId !== 677 || manifest.verificationStatus !== 'verified' || !manifest.verifiedSourceUrl || !manifest.contractAddress || manifest.smokeTestStatus !== 'passed')) { failed = true; console.error(`${file}: mainnet writes require a verified deployment, source URL, and passed smoke test`); }
  console.log(`${file}: ${manifest.verificationStatus}`);
}

async function jsonFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.name.endsWith('.json')) files.push(path);
  }
  return files.sort();
}

const evidenceRecords = [];
for (const directory of [`${evidenceRoot}/local`, `${evidenceRoot}/testnet`, `${evidenceRoot}/mainnet`]) {
  for (const file of await jsonFiles(directory)) {
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch {
      failed = true;
      console.error(`${file}: invalid JSON`);
      continue;
    }
    if (!record.kind) continue;
    if (!['transaction', 'observation', 'simulation'].includes(record.kind)) {
      failed = true;
      console.error(`${file}: unknown evidence kind ${record.kind}`);
      continue;
    }
    if (record.kind === 'transaction') {
      const required = ['runId', 'chainId', 'contract', 'sourceBuildHash', 'sender', 'method', 'args', 'hash', 'nonce', 'receiptStatus', 'blockNumber', 'blockHash', 'blockTimestamp', 'confirmations', 'eventName', 'eventArgs', 'feeWei', 'explorerUrl', 'pre', 'post'];
      const missing = required.filter((key) => !(key in record));
      if (missing.length) { failed = true; console.error(`${file}: transaction evidence is incomplete: ${missing.join(', ')}`); }
    }
    if (record.kind === 'observation') {
      const required = ['runId', 'chainId', 'contract', 'sourceBuildHash', 'vaultId', 'blockNumber', 'blockHash', 'blockTimestamp', 'status', 'checkInBy', 'claimableAt', 'amount'];
      const missing = required.filter((key) => !(key in record));
      if (missing.length) { failed = true; console.error(`${file}: observation evidence is incomplete: ${missing.join(', ')}`); }
    }
    if (record.kind === 'simulation') {
      const required = ['runId', 'chainId', 'contract', 'sourceBuildHash', 'caller', 'method', 'calldata', 'blockTag', 'blockHash', 'outcome'];
      const missing = required.filter((key) => !(key in record));
      if (missing.length) { failed = true; console.error(`${file}: simulation evidence is incomplete: ${missing.join(', ')}`); }
    }
    if ((record.kind === 'observation' || record.kind === 'simulation') && record.hash) { failed = true; console.error(`${file}: ${record.kind} evidence must not contain a transaction hash`); }
    evidenceRecords.push({ file, record });
    console.log(`${file}: ${record.kind}`);
  }
}

const abi = JSON.parse(await readFile(abiPath, 'utf8'));
const statusNames = ['ACTIVE', 'GRACE', 'CLAIMABLE', 'CANCELLED', 'CLAIMED'];
const clients = new Map();

function clientFor(chainId) {
  if (clients.has(chainId)) return clients.get(chainId);
  const manifest = manifests.get(chainId);
  const rpcUrl = chainId === 968
    ? process.env.BOT_TESTNET_RPC_URL ?? manifest?.rpcUrl ?? 'https://rpc.bohr.life'
    : chainId === 677
      ? process.env.BOT_MAINNET_RPC_URL ?? manifest?.rpcUrl ?? 'https://rpc.botchain.ai'
      : manifest?.rpcUrl;
  if (!rpcUrl) throw new Error(`No RPC URL is configured for chain ${chainId}.`);
  const chain = defineChain({
    id: chainId,
    name: manifest?.network ?? `chain ${chainId}`,
    nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
  clients.set(chainId, client);
  return client;
}

function asBigInt(value, label) {
  try { return BigInt(value); } catch { throw new Error(`${label} is not an integer: ${String(value)}`); }
}

function normalized(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^0x[0-9a-f]{40,}$/i.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function assertEqual(actual, expected, label) {
  if (!sameValue(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(normalized(expected))}, got ${JSON.stringify(normalized(actual))}`);
}

function assertManifestIdentity(record) {
  const manifest = manifests.get(record.chainId);
  if (!manifest) throw new Error(`No manifest is configured for chain ${record.chainId}.`);
  if (!manifest.contractAddress) throw new Error(`Evidence requires a deployed manifest for chain ${record.chainId}.`);
  if (manifest.contractAddress.toLowerCase() !== String(record.contract).toLowerCase()) throw new Error('Evidence contract does not match the deployment manifest.');
  const knownBuildHashes = [manifest.gitCommit, manifest.sourceSha256, manifest.runtimeCodeHash].filter(Boolean).map((value) => String(value).toLowerCase());
  if (knownBuildHashes.length && !knownBuildHashes.includes(String(record.sourceBuildHash).toLowerCase())) throw new Error('Evidence sourceBuildHash does not match the deployment manifest.');
  return manifest;
}

async function readViewAt(client, record, blockNumber) {
  const raw = await client.readContract({
    address: record.contract,
    abi,
    functionName: 'getVaultView',
    args: [asBigInt(record.vaultId, 'vaultId')],
    blockNumber,
  });
  const view = Array.isArray(raw) ? raw[0] : raw;
  if (!view?.vault) throw new Error('getVaultView returned no vault.');
  return view;
}

function snapshotFromView(view) {
  return {
    status: statusNames[Number(view.status)] ?? 'UNKNOWN',
    checkInBy: view.checkInBy,
    claimableAt: view.claimableAt,
    amount: view.vault.amount,
    owner: view.vault.owner,
    successor: view.vault.successor,
    settlement: Number(view.vault.settlement),
  };
}

function compareSnapshot(actual, expected, label) {
  for (const key of ['status', 'checkInBy', 'claimableAt', 'amount', 'owner', 'successor', 'settlement']) {
    if (expected?.[key] !== undefined && expected?.[key] !== null) assertEqual(actual[key], expected[key], `${label}.${key}`);
  }
}

async function verifyTransaction(file, record) {
  assertManifestIdentity(record);
  const client = clientFor(record.chainId);
  const receipt = await client.getTransactionReceipt({ hash: record.hash });
  assertEqual(receipt.transactionHash, record.hash, `${file} transactionHash`);
  assertEqual(receipt.status, record.receiptStatus, `${file} receiptStatus`);
  assertEqual(receipt.from, record.sender, `${file} sender`);
  assertEqual(receipt.to, record.contract, `${file} target`);
  assertEqual(receipt.blockNumber, asBigInt(record.blockNumber, 'blockNumber'), `${file} blockNumber`);
  assertEqual(receipt.blockHash, record.blockHash, `${file} blockHash`);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  assertEqual(block.hash, record.blockHash, `${file} canonical blockHash`);
  assertEqual(block.timestamp, asBigInt(record.blockTimestamp, 'blockTimestamp'), `${file} blockTimestamp`);
  const currentBlock = await client.getBlockNumber();
  const confirmations = currentBlock - receipt.blockNumber + 1n;
  if (record.confirmations !== null && record.confirmations !== undefined && confirmations < asBigInt(record.confirmations, 'confirmations')) throw new Error(`${file} has fewer confirmations than recorded.`);
  if (record.feeWei !== null && record.feeWei !== undefined && receipt.effectiveGasPrice !== undefined) assertEqual(receipt.gasUsed * receipt.effectiveGasPrice, record.feeWei, `${file} feeWei`);
  const transaction = await client.getTransaction({ hash: record.hash });
  if (record.nonce !== null && record.nonce !== undefined) assertEqual(transaction.nonce, Number(record.nonce), `${file} nonce`);

  let decodedEvent;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== String(record.contract).toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === record.eventName) { decodedEvent = decoded; break; }
    } catch { /* inspect the next contract log */ }
  }
  if (!decodedEvent) throw new Error(`${file} did not contain the recorded ${record.eventName} event.`);
  assertEqual(decodedEvent.args, record.eventArgs, `${file} eventArgs`);

  if (record.vaultId !== null && record.vaultId !== undefined && record.post) {
    const view = await readViewAt(client, record, receipt.blockNumber);
    compareSnapshot(snapshotFromView(view), record.post, `${file} post`);
  }
}

async function verifyObservation(file, record) {
  assertManifestIdentity(record);
  const client = clientFor(record.chainId);
  const blockNumber = asBigInt(record.blockNumber, 'blockNumber');
  const block = await client.getBlock({ blockNumber });
  assertEqual(block.hash, record.blockHash, `${file} blockHash`);
  assertEqual(block.timestamp, asBigInt(record.blockTimestamp, 'blockTimestamp'), `${file} blockTimestamp`);
  const view = await readViewAt(client, record, blockNumber);
  compareSnapshot(snapshotFromView(view), record, file);
}

function likelyExecutionRevert(error) {
  const message = [error?.name, error?.shortMessage, error?.message, error?.details].filter(Boolean).join(' ').toLowerCase();
  if (/header not found|missing trie|historical|timeout|fetch|network|unsupported|method not found|connection/.test(message)) return false;
  return /revert|panic|custom error/.test(message);
}

async function verifySimulation(file, record) {
  assertManifestIdentity(record);
  const client = clientFor(record.chainId);
  const blockNumber = asBigInt(record.blockTag, 'blockTag');
  const block = await client.getBlock({ blockNumber });
  assertEqual(block.hash, record.blockHash, `${file} blockHash`);
  if (record.outcome !== 'reverted') throw new Error(`${file} expected a reverted simulation, got ${record.outcome}.`);
  try {
    await client.call({ to: record.contract, data: record.calldata, account: record.caller, blockNumber });
  } catch (error) {
    if (likelyExecutionRevert(error)) return;
    throw new Error(`${file} simulation could not be canonically replayed: ${error?.shortMessage ?? error?.message ?? String(error)}`);
  }
  throw new Error(`${file} simulation succeeded at its recorded block.`);
}

for (const { file, record } of evidenceRecords) {
  try {
    if (record.kind === 'transaction') await verifyTransaction(file, record);
    else if (record.kind === 'observation') await verifyObservation(file, record);
    else await verifySimulation(file, record);
    console.log(`${file}: canonical verification passed`);
  } catch (error) {
    failed = true;
    console.error(`${file}: canonical verification failed — ${error?.message ?? String(error)}`);
  }
}

if (!evidenceRecords.length) console.log('canonical evidence: none present; manifest/schema checks passed');
if (failed) process.exitCode = 1;
