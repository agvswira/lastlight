#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { toFunctionSelector } from 'viem';

const networks = {
  testnet: { url: process.env.BOT_TESTNET_RPC_URL || 'https://rpc.bohr.life', chainId: 968 },
  mainnet: { url: process.env.BOT_MAINNET_RPC_URL || 'https://rpc.botchain.ai', chainId: 677 },
};

const requested = process.argv[process.argv.indexOf('--network') + 1] || 'testnet';
if (!networks[requested]) throw new Error(`Unknown network: ${requested}`);
const network = networks[requested];
let manifest;
try { manifest = JSON.parse(await readFile(`deployments/${network.chainId}.json`, 'utf8')); } catch { manifest = undefined; }

async function rpc(method, params = []) {
  const response = await fetch(network.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

function parseHexInteger(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${label} was not a hex integer`);
  return BigInt(value);
}

async function readLatestProgress() {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || typeof block !== 'object') throw new Error('latest block was empty');
  return {
    number: parseHexInteger(block.number, 'latest block number'),
    timestamp: parseHexInteger(block.timestamp, 'latest block timestamp'),
    hash: block.hash,
  };
}

async function checkBlockProgress() {
  const timeoutValue = Number(process.env.PREFLIGHT_PROGRESS_TIMEOUT_MS ?? 5000);
  const pollValue = Number(process.env.PREFLIGHT_PROGRESS_POLL_MS ?? 500);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue >= 0 ? timeoutValue : 5000;
  const pollMs = Number.isFinite(pollValue) && pollValue > 0 ? pollValue : 500;
  const startedAt = Date.now();
  const first = await readLatestProgress();
  let latest = first;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt)))));
    latest = await readLatestProgress();
    if (latest.number > first.number || latest.timestamp > first.timestamp) {
      return {
        method: 'blockProgress',
        critical: true,
        ok: true,
        waitedMs: Date.now() - startedAt,
        initialBlockNumber: `0x${first.number.toString(16)}`,
        latestBlockNumber: `0x${latest.number.toString(16)}`,
        initialTimestamp: `0x${first.timestamp.toString(16)}`,
        latestTimestamp: `0x${latest.timestamp.toString(16)}`,
        initialHash: first.hash,
        latestHash: latest.hash,
      };
    }
  }
  return {
    method: 'blockProgress',
    critical: true,
    ok: false,
    waitedMs: Date.now() - startedAt,
    initialBlockNumber: `0x${first.number.toString(16)}`,
    latestBlockNumber: `0x${latest.number.toString(16)}`,
    initialTimestamp: `0x${first.timestamp.toString(16)}`,
    latestTimestamp: `0x${latest.timestamp.toString(16)}`,
    error: 'The latest block number and timestamp did not advance during the preflight window.',
  };
}

const checks = [
  ['eth_chainId', [], true],
  ['eth_blockNumber', [], true],
  ['eth_getBlockByNumber', ['latest', false], true],
  ['eth_gasPrice', [], true],
  ['eth_getBlockByNumber', ['finalized', false], false],
  ['eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest', address: '0x0000000000000000000000000000000000000001' }], false],
];
const probeAddress = manifest?.contractAddress || process.env.PREFLIGHT_CONTRACT;
const probeAccount = process.env.PREFLIGHT_ADDRESS;
if (probeAddress) {
  checks.push(['eth_getCode', [probeAddress, 'latest'], true]);
  checks.push(['eth_call', [{ to: probeAddress, data: toFunctionSelector('PROTOCOL_VERSION()') }, 'latest'], true]);
}
checks.push(['eth_estimateGas', [{ from: probeAccount || '0x0000000000000000000000000000000000000000', to: probeAddress || '0x0000000000000000000000000000000000000000', value: '0x0' }], false]);
checks.push(['eth_feeHistory', ['0x1', 'latest', [25, 50, 75]], false]);
if (process.env.PREFLIGHT_TX_HASH) checks.push(['eth_getTransactionReceipt', [process.env.PREFLIGHT_TX_HASH], true]);
if (probeAccount) checks.push(['eth_getBalance', [probeAccount, 'latest'], true]);
const results = [];
let criticalFailure = false;
for (const [method, params, critical] of checks) {
  try {
    const result = await rpc(method, params);
    if (method === 'eth_chainId' && Number.parseInt(result, 16) !== network.chainId) throw new Error(`expected chain ${network.chainId}`);
    results.push({ method, critical, ok: true, result });
  } catch (error) {
    results.push({ method, critical, ok: false, error: error instanceof Error ? error.message : String(error) });
    if (critical) criticalFailure = true;
  }
}
try {
  const progress = await checkBlockProgress();
  results.push(progress);
  if (!progress.ok) criticalFailure = true;
} catch (error) {
  results.push({ method: 'blockProgress', critical: true, ok: false, error: error instanceof Error ? error.message : String(error) });
  criticalFailure = true;
}
const report = { schemaVersion: 'lastlight.preflight.v1', network: requested, url: network.url, expectedChainId: network.chainId, checkedAt: new Date().toISOString(), criticalFailure, results };
await mkdir('evidence/local', { recursive: true });
await writeFile(`evidence/local/preflight-${requested}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (criticalFailure) process.exitCode = 1;
