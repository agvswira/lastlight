import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { rememberWalletDisconnect, rememberWalletProvider, restoreAuthorizedWallet } from '../src/chain/wallet';

test('restores an already authorized wallet silently and respects Disconnect', async () => {
  const values = new Map<string, string>();
  const methods: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === 'eth_accounts') return ['0x1396483BFA097Da425658eDef1fdD373D66Be224'];
      if (method === 'eth_chainId') return '0x2a5';
      throw new Error(`Unexpected wallet request: ${method}`);
    },
  };
  vi.stubGlobal('window', {
    ethereum: provider,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setTimeout,
  });
  try {
    rememberWalletProvider('legacy');
    const restored = await restoreAuthorizedWallet();
    assert.equal(restored?.account, '0x1396483bfa097da425658edef1fdd373d66be224');
    assert.equal(restored?.chainId, 677);
    assert.deepEqual(methods, ['eth_accounts', 'eth_chainId']);
    rememberWalletDisconnect();
    assert.equal(await restoreAuthorizedWallet(), null);
    assert.deepEqual(methods, ['eth_accounts', 'eth_chainId']);
  } finally {
    vi.unstubAllGlobals();
  }
});
