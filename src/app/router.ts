export type RouteName = 'home' | 'create' | 'plans' | 'plan' | 'receive' | 'proof' | 'launch' | 'component-gallery' | 'not-found';

export type Route = {
  name: RouteName;
  section?: 'how-it-works';
  chainId?: number;
  contract?: string;
  vaultId?: bigint;
};

function parsePlansChain(query: string): number | null {
  const value = new URLSearchParams(query).get('chain');
  if (value === null || !/^\d+$/.test(value)) return null;
  const chainId = Number(value);
  return Number.isSafeInteger(chainId) && (chainId === 968 || chainId === 677 || chainId === 31337) ? chainId : null;
}

export function parseRoute(hash = window.location.hash): Route {
  const [raw, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const requestedSection = new URLSearchParams(query).get('section');
  if (!raw || raw === '/') return { name: 'home', ...(requestedSection === 'how-it-works' ? { section: 'how-it-works' as const } : {}) };
  const segments = raw.split('/').filter(Boolean);
  const name = segments[0];
  if (import.meta.env.DEV && name === '__components') return { name: 'component-gallery' };
  if (name === 'demo') return { name: 'create' };
  if (name === 'about') return { name: 'home', section: 'how-it-works' };
  if (name === 'create' || name === 'launch') {
    return { name };
  }
  if (name === 'plans') {
    if (new URLSearchParams(query).has('chain')) {
      const chainId = parsePlansChain(query);
      if (chainId === null) return { name: 'not-found' };
      return { name, chainId };
    }
    return { name };
  }
  if (name === 'plan' || name === 'receive' || name === 'proof') {
    const chainId = Number(segments[1]);
    const contract = segments[2];
    const idText = segments[3];
    if (!Number.isInteger(chainId) || !contract || !/^0x[0-9a-fA-F]{40}$/.test(contract) || !idText || !/^\d+$/.test(idText)) return { name: 'not-found' };
    try {
      const vaultId = BigInt(idText);
      if (vaultId < 1n || vaultId > 2n ** 256n - 1n) return { name: 'not-found' };
      return { name, chainId, contract, vaultId };
    } catch { return { name: 'not-found' }; }
  }
  return { name: 'not-found' };
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}
