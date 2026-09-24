import { escapeHtml, icon, statusPill } from '../components/ui';
import { chains, manifests, type DeploymentManifest } from '../app/config';
import { shortAddress } from '../domain/address';

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function formatDeploymentDate(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return `${new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

function externalLink(label: string, href: string | null): string {
  return href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)} ${icon('external')}</a>`
    : escapeHtml(label);
}

export function renderLaunch(mainnet: DeploymentManifest = manifests[677]): string {
  const testnet = manifests[968];
  const testnetDeployed = Boolean(testnet.contractAddress && testnet.deploymentTx);
  const testnetVerified = Boolean(testnetDeployed && testnet.verificationStatus === 'verified');
  const released = Boolean(mainnet.contractAddress && mainnet.deploymentTx && mainnet.deploymentTimestamp && mainnet.verificationStatus === 'verified' && mainnet.smokeTestStatus === 'passed' && mainnet.mainnetWritesEnabled);
  const active = released ? mainnet : testnet;
  const activeChain = released ? chains[677] : chains[968];
  const activeSource = safeHttpUrl(active.verifiedSourceUrl);
  const activeContractUrl = active.contractAddress ? `${activeChain.explorerUrl}/address/${active.contractAddress}` : null;
  const activeTxUrl = active.deploymentTx ? `${activeChain.explorerUrl}/tx/${encodeURIComponent(active.deploymentTx)}` : null;
  const activeLinks = [
    activeContractUrl ? externalLink('View contract', activeContractUrl) : '',
    activeTxUrl ? externalLink('Deployment transaction', activeTxUrl) : '',
    activeSource && activeSource !== activeContractUrl ? externalLink('Verified source', activeSource) : '',
  ].join('');
  const activeTitle = released ? 'Live on BOT Mainnet' : testnetVerified ? 'Contract verified on BOT Testnet' : testnetDeployed ? 'Contract deployed on BOT Testnet' : 'BOT Testnet deployment pending';
  const activeDescription = released
    ? 'The mainnet release has a verified contract and recorded lifecycle checks.'
    : testnetVerified
      ? 'The testnet contract and source are verified. A complete funded lifecycle on the public network has not been recorded yet.'
      : testnetDeployed
        ? 'The testnet contract is deployed, but source verification is still pending.'
        : 'No testnet contract is configured in the deployment manifest.';
  const mainnetContractUrl = mainnet.contractAddress ? `${chains[677].explorerUrl}/address/${mainnet.contractAddress}` : null;
  return `<div class="launch-page">
    <section class="product-hero launch-hero"><div class="shell-width product-hero__inner"><div class="product-hero__copy"><h1>Deployment status</h1><p class="lede">Where Lastlight is available today, and what comes next.</p><div class="launch-hero__status">${statusPill(released ? 'Mainnet live' : testnetVerified ? 'Testnet verified' : 'Testnet pending', released || testnetVerified ? 'active' : 'neutral')}</div></div><img class="product-hero__art" src="./assets/lastlight-hero.webp" alt="" aria-hidden="true"></div></section>
    <div class="shell-width launch-content">
      <section class="launch-current"><div class="launch-current__heading"><span>${escapeHtml(activeChain.name)}</span><h2>${escapeHtml(activeTitle)}</h2><p>${escapeHtml(activeDescription)}</p></div><div class="launch-current__details"><dl class="mini-definition"><div><dt>Contract</dt><dd>${active.contractAddress ? escapeHtml(shortAddress(active.contractAddress)) : 'Not deployed'}</dd></div><div><dt>Source</dt><dd>${active.verificationStatus === 'verified' ? 'Verified' : 'Not verified'}</dd></div><div><dt>Deployment date</dt><dd>${escapeHtml(formatDeploymentDate(active.deploymentTimestamp))}</dd></div></dl>${activeLinks ? `<div class="launch-current__links">${activeLinks}</div>` : ''}</div></section>
      ${!released ? `<section class="launch-next"><div><h2>Mainnet is not live yet</h2><p>Lastlight currently uses BOT Testnet. Mainnet actions remain unavailable until the release requirements are recorded.</p></div><div class="launch-next__status">${statusPill('Mainnet pending', 'neutral')}<details class="launch-checklist"><summary>What remains before mainnet release</summary><ul><li><span>${icon(mainnet.contractAddress ? 'check' : 'clock')}</span><span><strong>Contract deployment</strong><small>${mainnet.contractAddress ? externalLink(shortAddress(mainnet.contractAddress), mainnetContractUrl) : 'Not deployed'}</small></span></li><li><span>${icon(mainnet.verificationStatus === 'verified' ? 'check' : 'clock')}</span><span><strong>Source verification</strong><small>${mainnet.verificationStatus === 'verified' ? 'Verified in the deployment manifest' : 'Not verified'}</small></span></li><li><span>${icon(mainnet.smokeTestStatus === 'passed' ? 'check' : 'clock')}</span><span><strong>Lifecycle check</strong><small>${mainnet.smokeTestStatus === 'passed' ? 'Passed and recorded' : 'Not recorded'}</small></span></li><li><span>${icon('clock')}</span><span><strong>Public release</strong><small>Not published</small></span></li></ul></details></div></section>` : ''}
    </div>
  </div>`;
}
