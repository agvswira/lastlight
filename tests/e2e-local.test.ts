import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const root = process.cwd();
const rpcPort = Number(process.env.LASTLIGHT_ANVIL_PORT ?? 18545);
const webPort = Number(process.env.LASTLIGHT_E2E_PORT ?? 4175);
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const baseUrl = `http://127.0.0.1:${webPort}`;
const mnemonic = 'test test test test test test test test test test test junk';
const bundledAnvilPath = '/tmp/lastlight-foundry/versions/foundry-rs/foundry/v1.8.3/anvil';
const anvilPath = process.env.ANVIL_PATH ?? (existsSync(bundledAnvilPath) ? bundledAnvilPath : 'anvil');
const artifactPath = 'contracts/out/LastlightVault.sol/LastlightVault.json';
const manifestPath = 'deployments/31337.json';

type RpcResponse<T> = { result?: T; error?: { code?: number; message?: string } };

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  assert.equal(response.ok, true, `RPC HTTP ${response.status} for ${method}`);
  const body = await response.json() as RpcResponse<T>;
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  return body.result as T;
}

async function setAutomine(enabled: boolean): Promise<void> {
  await rpc(rpcUrl, 'evm_setAutomine', [enabled]);
}

async function waitForRpc(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      if (await rpc<string>(rpcUrl, 'eth_chainId') === '0x7a69') return;
    } catch { /* Anvil is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Anvil did not start at ${rpcUrl}.`);
}

async function waitForServer(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite did not start at ${baseUrl}.`);
}

async function settleVisuals(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(850);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

function killProcess(process: ChildProcess | undefined): void {
  if (process && !process.killed) process.kill('SIGTERM');
}

async function installTestProvider(page: Page, account: Address): Promise<void> {
  const script = `(() => {
    const rpcEndpoint = ${JSON.stringify(rpcUrl)};
    let activeAccount = ${JSON.stringify(account)};
    const listeners = new Map();
    const emit = (event, value) => listeners.get(event)?.forEach((listener) => listener(value));
    const callRpc = async (method, params = []) => {
      const response = await fetch(rpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const body = await response.json();
      if (body.error) {
        const error = new Error(body.error.message || 'Injected provider RPC error');
        error.code = body.error.code;
        throw error;
      }
      return body.result;
    };
    const provider = {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
        if (method === 'eth_chainId') return '0x7a69';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction' && window.__lastlightTestRejectNextSend) {
          delete window.__lastlightTestRejectNextSend;
          const error = new Error('User rejected the request');
          error.code = 4001;
          throw error;
        }
        const result = await callRpc(method, params);
        if (method === 'eth_sendTransaction') {
          await callRpc('evm_mine');
          setTimeout(() => { void callRpc('evm_mine'); }, 4_500);
        }
        return result;
      },
      on: (event, listener) => {
        const eventListeners = listeners.get(event) || new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      removeListener: (event, listener) => listeners.get(event)?.delete(listener),
    };
    Object.defineProperty(window, 'ethereum', { configurable: true, writable: true, value: provider });
    window.__lastlightTestRejectNextSend = false;
    window.__lastlightTestSetAccount = (next) => {
      activeAccount = next.toLowerCase();
      emit('accountsChanged', [activeAccount]);
    };
  })()`;
  await page.addInitScript({ content: script });
}

async function readVault(publicClient: ReturnType<typeof createPublicClient>, address: Address, vaultId: bigint): Promise<any> {
  const result = await publicClient.readContract({ address, abi: (JSON.parse(await readFile(artifactPath, 'utf8')) as { abi: any[] }).abi, functionName: 'getVaultView', args: [vaultId] } as any) as any;
  return Array.isArray(result) ? result[0] : result.vault;
}

test('browser create and claim flow uses a compiled vault on Anvil', async () => {
  if (anvilPath === 'anvil') assert.equal(spawnSync('which', ['anvil'], { encoding: 'utf8' }).status, 0, 'Anvil not found; set ANVIL_PATH or install Foundry.');
  else assert.equal(existsSync(anvilPath), true, `Anvil not found at ${anvilPath}; set ANVIL_PATH or install Foundry.`);
  assert.equal(existsSync(artifactPath), true, `Missing ${artifactPath}; run npm run contracts:build first.`);

  let anvil: ChildProcess | undefined;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const originalManifest = await readFile(manifestPath, 'utf8');

  try {
    anvil = spawn(anvilPath, ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--accounts', '3', '--balance', '1000', '--mnemonic', mnemonic, '--silent'], { cwd: root, stdio: 'ignore' });
    await waitForRpc();

    const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const successor = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const successor2 = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const accounts = await rpc<string[]>(rpcUrl, 'eth_accounts');
    assert.equal(accounts[0].toLowerCase(), owner.address.toLowerCase());
    assert.equal(accounts[1].toLowerCase(), successor.address.toLowerCase());

    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { abi: any[]; bytecode: { object: `0x${string}` } };
    const chain = defineChain({ id: 31337, name: 'Local Anvil', nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
    const deploymentHash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
    const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    assert.ok(deploymentReceipt.contractAddress, 'Anvil did not return the deployed contract address.');
    const contractAddress = deploymentReceipt.contractAddress;
    const runtimeBytecode = await publicClient.getBytecode({ address: contractAddress });
    assert.ok(runtimeBytecode && runtimeBytecode !== '0x', 'The deployed vault has no runtime bytecode.');
    const source = await readFile('contracts/src/LastlightVault.sol');
    const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
    Object.assign(manifest, {
      rpcUrl,
      explorerUrl: rpcUrl,
      contractAddress,
      deploymentTx: deploymentHash,
      deploymentBlock: deploymentReceipt.blockNumber.toString(),
      deploymentTimestamp: new Date(Number((await publicClient.getBlock({ blockNumber: deploymentReceipt.blockNumber })).timestamp) * 1000).toISOString(),
      deployer: owner.address,
      runtimeCodeHash: keccak256(runtimeBytecode),
      abiSha256: createHash('sha256').update(JSON.stringify(artifact.abi)).digest('hex'),
      gitCommit: null,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      compilerVersion: '0.8.30',
      verifiedSourceUrl: null,
      mainnetWritesEnabled: false,
      smokeTestStatus: 'passed',
      verificationStatus: 'verified',
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    await setAutomine(false);
    try {
      const seedNonce = await publicClient.getTransactionCount({ address: owner.address });
      const seedPlanHashes = await Promise.all(Array.from({ length: 50 }, (_, index) => walletClient.writeContract({
        address: contractAddress,
        abi: artifact.abi,
        functionName: 'createVault',
        args: [successor2.address, 365n * 24n * 60n * 60n, 30n * 24n * 60n * 60n],
        value: 1n,
        nonce: seedNonce + index,
      } as any)));
      await rpc(rpcUrl, 'evm_mine');
      await Promise.all(seedPlanHashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
    } finally {
      await setAutomine(true);
    }
    const createdVaultId = 51n;
    assert.equal(await publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: 'nextVaultId' } as any), createdVaultId);

    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(webPort)], { cwd: root, stdio: 'ignore' });
    await waitForServer();
    const installedChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/lunarch/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
    browser = await chromium.launch({ executablePath: existsSync(installedChromium) ? installedChromium : undefined, headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await installTestProvider(page, owner.address);

    await page.goto(`${baseUrl}/#/create`, { waitUntil: 'networkidle' });
    await page.locator('#network-select').selectOption('31337');
    await page.getByRole('button', { name: /Connect wallet/ }).click();
    await page.locator('#connect-wallet').filter({ hasText: '0xf39f' }).waitFor({ timeout: 5_000 });
    await page.locator('#recipient-address').fill(successor.address);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.locator('#inactivity-days').selectOption('custom');
    await page.locator('#grace-days').selectOption('custom');
    await page.locator('[data-custom-unit="inactivityPeriod"]').selectOption('seconds');
    await page.locator('[data-custom-period="inactivityPeriod"]').fill('180');
    await page.locator('[data-custom-unit="gracePeriod"]').selectOption('seconds');
    await page.locator('[data-custom-period="gracePeriod"]').fill('180');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#plan-amount').fill('0.001');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('[data-ack="0"]').check();
    await page.locator('[data-ack="1"]').check();
    await page.evaluate(() => { (window as unknown as { __lastlightTestRejectNextSend: boolean }).__lastlightTestRejectNextSend = true; });
    await page.getByRole('button', { name: 'Create & fund plan' }).click();
    await page.getByText('Cancelled in your wallet. The plan has not changed.').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('body').innerText(), /Review before you commit/);
    await page.getByRole('button', { name: 'Back' }).click();
    assert.equal(await page.locator('#plan-amount').inputValue(), '0.001');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create & fund plan' }).click();
    try {
      await page.waitForURL((url) => url.hash.startsWith(`#/plan/31337/${contractAddress}/${createdVaultId}`), { timeout: 30_000 });
    } catch (error) {
      if (process.env.LASTLIGHT_E2E_DEBUG) {
        console.error('local e2e create page:', await page.locator('body').innerText());
        console.error('local e2e block:', await rpc<string>(rpcUrl, 'eth_blockNumber'));
        const localStorageDump = await page.evaluate(() => ({ ...localStorage }));
        console.error('local e2e local storage:', localStorageDump);
        const transactionRecord = Object.entries(localStorageDump).find(([key]) => key.includes(':tx:create:'))?.[1];
        const transactionHash = transactionRecord ? (JSON.parse(transactionRecord) as { hash?: string }).hash : undefined;
        if (transactionHash) console.error('local e2e receipt:', await rpc(rpcUrl, 'eth_getTransactionReceipt', [transactionHash]));
      }
      throw error;
    }
    await page.getByRole('heading', { name: `BOT continuity plan #${createdVaultId}` }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator('body').innerText(), /On track/);
    await mkdir('evidence/local/screenshots', { recursive: true });
    await settleVisuals(page);
    await page.screenshot({ path: 'evidence/local/screenshots/anvil-plan-active.png', fullPage: true });

    const createdVault = await readVault(publicClient, contractAddress, createdVaultId);
    assert.equal(createdVault.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(createdVault.successor.toLowerCase(), successor.address.toLowerCase());
    assert.equal(createdVault.amount, 1_000_000_000_000_000n);

    const heartbeatTrigger = page.locator('[data-plan-action="heartbeat"]');
    await heartbeatTrigger.focus();
    await heartbeatTrigger.click();
    await page.locator('dialog.action-dialog').waitFor();
    assert.equal(await page.locator('dialog.action-dialog:focus-within').count(), 1);
    await page.locator('dialog.action-dialog').press('Escape');
    await page.locator('dialog.action-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-plan-action')), 'heartbeat');

    await heartbeatTrigger.click();
    await page.locator('dialog.action-dialog').waitFor();
    await page.locator('dialog.action-dialog .dialog-actions button[value="cancel"]').click();
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-plan-action')), 'heartbeat');

    await heartbeatTrigger.click();
    await page.locator('dialog [data-dialog-confirm]').click();
    await page.getByText('Transaction confirmed').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('body').innerText(), /On track/);
    const heartbeatedVault = await readVault(publicClient, contractAddress, createdVaultId);
    assert.ok(heartbeatedVault.lastHeartbeat >= createdVault.lastHeartbeat);

    await page.locator('[data-plan-action="change-successor"]').click();
    await page.locator('#action-new-successor').fill(successor2.address);
    await page.locator('dialog [data-dialog-confirm]').click();
    await page.getByText('Transaction confirmed').waitFor({ timeout: 30_000 });
    const replacedVault = await readVault(publicClient, contractAddress, createdVaultId);
    assert.equal(replacedVault.successor.toLowerCase(), successor2.address.toLowerCase());
    assert.equal(replacedVault.lastHeartbeat, heartbeatedVault.lastHeartbeat);
    assert.equal(replacedVault.inactivityPeriod, heartbeatedVault.inactivityPeriod);
    assert.equal(replacedVault.gracePeriod, heartbeatedVault.gracePeriod);

    assert.equal(await publicClient.readContract({ address: contractAddress, abi: artifact.abi, functionName: 'nextVaultId' } as any), createdVaultId + 1n);

    let failedVaultView = false;
    const vaultViewSelector = keccak256(toBytes('getVaultView(uint256)')).slice(0, 10).toLowerCase();
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!failedVaultView && request.url().startsWith(rpcUrl) && request.method() === 'POST') {
        try {
          const body = JSON.parse(request.postData() ?? '{}') as { id?: number; method?: string; params?: Array<{ data?: string }> };
          const data = body.params?.[0]?.data?.toLowerCase();
          if (body.method === 'eth_call' && data?.startsWith(vaultViewSelector)) {
            failedVaultView = true;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Injected row read failure' } }),
            });
            return;
          }
        } catch { /* Continue real RPC traffic when a provider payload is not JSON. */ }
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/#/plans`, { waitUntil: 'networkidle' });
    const connectWallet = page.locator('#connect-wallet');
    await connectWallet.waitFor({ timeout: 15_000 });
    if ((await connectWallet.innerText()).includes('Connect wallet')) await connectWallet.click();
    await page.locator('#connect-wallet').filter({ hasText: '0xf39f' }).waitFor({ timeout: 5_000 });
    await page.locator('.plan-row--error').waitFor({ timeout: 15_000 });
    assert.equal(failedVaultView, true);
    assert.match(await page.locator('.live-plan-list .loaded-count').innerText(), /Showing 19 of 51 · Priorities reflect loaded plans/);
    await page.unroute('**/*');

    await page.locator('[data-retry-plan]').first().click();
    await page.locator('.plan-row--error').waitFor({ state: 'detached', timeout: 15_000 });
    assert.match(await page.locator('.live-plan-list .loaded-count').innerText(), /Showing 20 of 51 · Priorities reflect loaded plans/);
    let historicalSnapshotFailure = false;
    const ownerIdsSelector = keccak256(toBytes('getVaultIdsByOwner(address,uint256,uint256)')).slice(0, 10).toLowerCase();
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!historicalSnapshotFailure && request.url().startsWith(rpcUrl) && request.method() === 'POST') {
        try {
          const body = JSON.parse(request.postData() ?? '{}') as { id?: number; method?: string; params?: Array<{ data?: string }> };
          const data = body.params?.[0]?.data?.toLowerCase();
          const offset = data?.startsWith(ownerIdsSelector) ? BigInt(`0x${data.slice(-128, -64)}`) : undefined;
          if (body.method === 'eth_call' && data?.startsWith(ownerIdsSelector) && offset !== undefined && offset > 0n) {
            historicalSnapshotFailure = true;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'historical state unavailable for requested block' } }),
            });
            return;
          }
        } catch { /* Continue real RPC traffic when a provider payload is not JSON. */ }
      }
      await route.continue();
    });
    await page.getByRole('button', { name: /Load more 20/ }).click();
    await page.getByText('Showing 40 of 51 · Priorities reflect loaded plans', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(historicalSnapshotFailure, true);
    await page.unroute('**/*');
    await page.getByRole('button', { name: /Load more 20/ }).click();
    await page.getByText('Showing 51 of 51 · Priorities reflect loaded plans', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.live-plan-list .plan-row').count(), 51);

    await page.goto(`${baseUrl}/#/plan/31337/${contractAddress}/1`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'BOT continuity plan #1' }).waitFor({ timeout: 15_000 });
    await page.locator('[data-plan-action="cancel"]').click();
    await page.locator('dialog [data-dialog-confirm]').click();
    await page.getByText('Transaction confirmed').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('body').innerText(), /Closed by owner/);
    const closedSeedPlan = await readVault(publicClient, contractAddress, 1n);
    assert.equal(closedSeedPlan.amount, 0n);
    assert.equal(Number(closedSeedPlan.settlement), 1);
    assert.equal(closedSeedPlan.settlementRecipient.toLowerCase(), owner.address.toLowerCase());

    await page.evaluate((nextAccount) => (window as unknown as { __lastlightTestSetAccount: (next: string) => void }).__lastlightTestSetAccount(nextAccount), successor2.address);
    await page.evaluate((nextHash) => { window.location.hash = nextHash; }, `#/receive/31337/${contractAddress}/${createdVaultId}`);
    await page.getByRole('heading', { name: 'A plan names your wallet.' }).waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('[data-plan-action="claim"]').count(), 0);
    await settleVisuals(page);
    await page.screenshot({ path: 'evidence/local/screenshots/anvil-recipient-waiting.png', fullPage: true });
    await page.evaluate((nextAccount) => (window as unknown as { __lastlightTestSetAccount: (next: string) => void }).__lastlightTestSetAccount(nextAccount), owner.address);
    await page.evaluate((nextHash) => { window.location.hash = nextHash; }, `#/plan/31337/${contractAddress}/${createdVaultId}`);
    await page.getByRole('heading', { name: `BOT continuity plan #${createdVaultId}` }).waitFor({ timeout: 15_000 });

    await page.route('**/*', (route) => route.request().url().startsWith(rpcUrl) ? route.abort() : route.continue());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'We couldn’t refresh this plan.' }).waitFor({ timeout: 15_000 });
    await page.unroute('**/*');
    await page.getByRole('button', { name: /Retry read/ }).click();
    await page.getByRole('heading', { name: `BOT continuity plan #${createdVaultId}` }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.locator('#connect-wallet').filter({ hasText: '0xf39f' }).waitFor({ timeout: 5_000 });

    await page.evaluate(() => {
      const realNow = Date.now;
      (window as unknown as { __lastlightRestoreClock?: () => void }).__lastlightRestoreClock = () => { Date.now = realNow; };
      Date.now = () => realNow() + 365 * 24 * 60 * 60 * 1000;
    });
    assert.match(await page.locator('body').innerText(), /On track/);
    assert.doesNotMatch(await page.locator('body').innerText(), /Your control has ended/);
    await page.evaluate(() => (window as unknown as { __lastlightRestoreClock?: () => void }).__lastlightRestoreClock?.());

    await rpc(rpcUrl, 'evm_increaseTime', [181]);
    await rpc(rpcUrl, 'evm_mine');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: `BOT continuity plan #${createdVaultId}` }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.locator('#connect-wallet').filter({ hasText: '0xf39f' }).waitFor({ timeout: 5_000 });
    assert.match(await page.locator('body').innerText(), /You still have time to check in/);
    await page.evaluate(() => {
      const realNow = Date.now;
      (window as unknown as { __lastlightRestoreClock?: () => void }).__lastlightRestoreClock = () => { Date.now = realNow; };
      Date.now = () => realNow() + 181 * 1000;
    });
    const reminderTrigger = page.locator('[data-download-calendar]');
    await reminderTrigger.focus();
    await reminderTrigger.click();
    const reminderPicker = page.locator('#reminder-picker');
    await reminderPicker.waitFor();
    assert.match(await reminderPicker.innerText(), /default reminder has passed/i);
    assert.equal(await reminderPicker.locator('input[type="datetime-local"]').count(), 1);
    let cancelDownloaded = false;
    const onDownload = () => { cancelDownloaded = true; };
    page.on('download', onDownload);
    await reminderPicker.locator('.dialog-actions button[value="cancel"]').click();
    await reminderPicker.waitFor({ state: 'detached' });
    await page.waitForTimeout(100);
    page.off('download', onDownload);
    assert.equal(cancelDownloaded, false);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-download-calendar')), 'owner');
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      Object.defineProperty(window, '__lastlightOriginalCreateObjectURL', { configurable: true, value: original });
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: null,
      });
    });
    let fallbackDownloaded = false;
    const onFallbackDownload = () => { fallbackDownloaded = true; };
    page.on('download', onFallbackDownload);
    await reminderTrigger.click();
    await reminderPicker.waitFor();
    await reminderPicker.getByRole('button', { name: 'Download reminder' }).click();
    await page.getByText('Download unavailable', { exact: true }).waitFor();
    await reminderPicker.waitFor({ state: 'detached' });
    page.off('download', onFallbackDownload);
    assert.equal(fallbackDownloaded, false);
    assert.equal(await page.getByRole('button', { name: 'Copy details' }).count(), 1);
    await page.evaluate(() => {
      const original = (window as unknown as { __lastlightOriginalCreateObjectURL?: typeof URL.createObjectURL }).__lastlightOriginalCreateObjectURL;
      if (original) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: original });
    });
    await page.locator('#transaction-tray .tray-close').click();
    assert.equal(await page.locator('#transaction-tray').isHidden(), true);
    await page.evaluate(() => (window as unknown as { __lastlightRestoreClock?: () => void }).__lastlightRestoreClock?.());
    await settleVisuals(page);
    await page.screenshot({ path: 'evidence/local/screenshots/anvil-plan-grace.png', fullPage: true });
    await page.locator('[data-plan-action="heartbeat"]').click();
    await page.locator('dialog [data-dialog-confirm]').click();
    await page.getByText('Transaction confirmed').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('body').innerText(), /On track/);

    await rpc(rpcUrl, 'evm_increaseTime', [361]);
    await rpc(rpcUrl, 'evm_mine');
    await page.evaluate((nextAccount) => (window as unknown as { __lastlightTestSetAccount: (next: string) => void }).__lastlightTestSetAccount(nextAccount), successor.address);
    await page.evaluate((nextHash) => { window.location.hash = nextHash; }, `#/receive/31337/${contractAddress}/${createdVaultId}`);
    await page.getByRole('heading', { name: 'A plan for its named recipient.' }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator('body').innerText(), /Ready to claim/);
    assert.equal(await page.locator('[data-plan-action="claim"]').count(), 0);
    await page.evaluate((nextAccount) => (window as unknown as { __lastlightTestSetAccount: (next: string) => void }).__lastlightTestSetAccount(nextAccount), successor2.address);
    await page.getByRole('heading', { name: 'A plan names your wallet.' }).waitFor({ timeout: 15_000 });
    await settleVisuals(page);
    await page.screenshot({ path: 'evidence/local/screenshots/anvil-recipient-claimable.png', fullPage: true });
    await page.locator('[data-plan-action="claim"]').click();
    await page.locator('dialog [data-dialog-confirm]').click();
    await page.getByText(/Transaction confirmed/).waitFor({ timeout: 30_000 });
    assert.match(await page.locator('body').innerText(), /Claimed/);
    await page.evaluate((nextHash) => { window.location.hash = nextHash; }, `#/proof/31337/${contractAddress}/${createdVaultId}`);
    await page.getByRole('heading', { name: 'Claimed' }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator('body').innerText(), /Confirmed after receipt verification/);
    assert.match(await page.locator('body').innerText(), /Fee/);
    assert.match(await page.locator('body').innerText(), /Confirmations/);
    assert.match(await page.locator('body').innerText(), /VaultClaimed/);
    assert.match(await page.locator('body').innerText(), /Validated records on this device/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Claimed' }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator('body').innerText(), /Confirmed after receipt verification/);
    assert.equal(await page.locator('#network-select').inputValue(), '31337');
    await settleVisuals(page);
    await page.screenshot({ path: 'evidence/local/screenshots/anvil-claimed-receipt.png', fullPage: true });

    const claimedVault = await readVault(publicClient, contractAddress, createdVaultId);
    assert.equal(claimedVault.amount, 0n);
    assert.equal(Number(claimedVault.settlement), 2);
  } finally {
    await context?.close();
    await browser?.close();
    killProcess(server);
    killProcess(anvil);
    await writeFile(manifestPath, originalManifest);
  }
});
