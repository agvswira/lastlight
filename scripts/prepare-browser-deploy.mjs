#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const deployer = '0xe604829a9c327b0d924718CfAcEF69BBdC8C0Efc';
const maxCostWei = 100000000000000000n;
const artifact = JSON.parse(await readFile('contracts/out/LastlightVault.sol/LastlightVault.json', 'utf8'));
const manifest = JSON.parse(await readFile('deployments/968.json', 'utf8'));
const release = JSON.parse(await readFile('evidence/local/release-prepare.json', 'utf8'));
if (manifest.chainId !== 968 || manifest.contractAddress) throw new Error('Testnet manifest is not pending on chain 968.');
const bytecode = artifact.bytecode?.object;
if (!/^0x[0-9a-f]+$/i.test(bytecode ?? '')) throw new Error('Creation bytecode is missing.');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytecodeHash = sha256(Buffer.from(bytecode.slice(2), 'hex'));
if (bytecodeHash !== release.artifact?.bytecodeSha256) throw new Error('Creation bytecode differs from prepared release.');
const sourceHash = sha256(await readFile('contracts/src/LastlightVault.sol'));
if (sourceHash !== release.sourceHashes?.['contracts/src/LastlightVault.sol']) throw new Error('Contract source differs from prepared release.');

const config = JSON.stringify({ deployer, chainId: 968, bytecode, bytecodeHash, sourceHash, maxCostWei: maxCostWei.toString() });
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lastlight · BOT Testnet deploy</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0b1012;color:#f5f7f3}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:680px;margin:8vh auto}.mark{color:#baf63e;font-weight:850;letter-spacing:-.05em;font-size:22px}h1{font-size:clamp(34px,6vw,56px);line-height:1.05;letter-spacing:-.055em;margin:54px 0 18px}p{color:#aeb8b2;line-height:1.6}.card{background:#171d1e;border:1px solid #394241;padding:26px;margin:34px 0}dl{display:grid;grid-template-columns:145px 1fr;gap:14px 18px;margin:0}dt{color:#aeb8b2}dd{margin:0;overflow-wrap:anywhere;font-weight:650}code{font:13px ui-monospace,monospace}select,button{border-radius:0;font:inherit}select{background:#0b1012;color:#f5f7f3;border:1px solid #394241;padding:12px;width:100%;margin:10px 0 16px}button{padding:14px 22px;border:1px solid #baf63e;background:#baf63e;color:#0b1012;font-weight:750;cursor:pointer;margin-right:10px;margin-top:8px}button:disabled{opacity:.45;cursor:not-allowed}button.secondary{background:transparent;color:#f5f7f3;border-color:#5a6663}#status{min-height:24px;margin:22px 0}#receipt a{color:#baf63e}.note{font-size:13px}a{color:#baf63e}@media(max-width:530px){dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:12px}}
</style>
<main><div class="mark">◼ Lastlight</div><h1>Deploy to BOT Testnet.</h1><p>This page sends the reviewed LastlightVault creation bytecode through your browser wallet. It never asks for a private key. You must approve the transaction in the wallet popup.</p>
<div class="card"><dl><dt>Required network</dt><dd>Bohr Testnet · chain 968</dd><dt>Wallet reports</dt><dd id="current-chain">Connect wallet to check</dd><dt>Approved deployer</dt><dd><code>${deployer}</code></dd><dt>Creation hash</dt><dd><code>${bytecodeHash}</code></dd><dt>Maximum gas cost</dt><dd>0.10 test BOT</dd><dt>Actual estimate</dt><dd id="estimate">Connect wallet to calculate</dd></dl></div>
<label for="provider">Browser wallet</label><select id="provider"><option value="">Detecting wallets…</option></select><div><button id="connect">Connect &amp; check</button><button id="switch-network" class="secondary" hidden>Switch to Bohr Testnet</button><button id="deploy" class="secondary" disabled>Deploy contract</button></div><p id="status" role="status" aria-live="polite"></p><div id="receipt"></div><p class="note">If the wallet displays a different account, network, bytecode, or fee above 0.10 test BOT, reject the transaction. The contract has no admin or upgrade key.</p></main>
<script>
const config=${config};
const $=(id)=>document.getElementById(id);
const wallets=new Map();let selected,ready;
function status(message){$('status').textContent=message}
function addWallet(id,name,provider){if(!provider||wallets.has(id))return;wallets.set(id,{name,provider});const option=document.createElement('option');option.value=id;option.textContent=name;$('provider').append(option);if(!selected){selected=id;$('provider').value=id}}
window.addEventListener('eip6963:announceProvider',(event)=>{const detail=event.detail;if(detail?.provider)addWallet(detail.info?.uuid||'wallet-'+wallets.size,detail.info?.name||'Browser wallet',detail.provider)});
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(!wallets.size&&window.ethereum)addWallet('injected','Browser wallet',window.ethereum);if(wallets.size)$('provider').querySelector('option[value=""]')?.remove();else $('provider').innerHTML='<option value="">No browser wallet detected</option>'},300);
const request=(provider,method,params=[])=>provider.request({method,params});
const hex=(value)=>'0x'+value.toString(16);
async function checkBytecode(){const bytes=new Uint8Array(config.bytecode.slice(2).match(/../g).map((part)=>parseInt(part,16)));const digest=await crypto.subtle.digest('SHA-256',bytes);const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==config.bytecodeHash)throw Error('Creation bytecode hash mismatch. Do not deploy.')}
async function prepare(){ready=undefined;$('deploy').disabled=true;$('switch-network').hidden=true;const wallet=wallets.get($('provider').value);if(!wallet)throw Error('Open this page in a browser with your wallet extension.');const provider=wallet.provider;await checkBytecode();const accounts=await request(provider,'eth_requestAccounts');const account=accounts?.[0];if(!account||account.toLowerCase()!==config.deployer.toLowerCase())throw Error('Wrong wallet account. Select '+config.deployer+' in your extension.');const chain=Number(BigInt(await request(provider,'eth_chainId')));$('current-chain').textContent='Chain '+chain+' (0x'+chain.toString(16)+') via '+wallet.name;if(chain!==config.chainId){$('switch-network').hidden=false;throw Error('Wallet reports chain '+chain+', but Bohr Testnet requires chain 968. Click Switch to Bohr Testnet.')}const gasEstimate=BigInt(await request(provider,'eth_estimateGas',[{from:account,data:config.bytecode}]));const gasLimit=(gasEstimate*12n+9n)/10n;const gasPrice=BigInt(await request(provider,'eth_gasPrice'));const maxCost=gasLimit*gasPrice;if(maxCost>BigInt(config.maxCostWei))throw Error('Estimated maximum cost exceeds 0.10 test BOT. No transaction was sent.');$('estimate').textContent=(Number(maxCost)/1e18).toFixed(6)+' test BOT (gas limit '+gasLimit+', '+Number(gasPrice)/1e9+' gwei)';ready={provider,account,gasLimit,gasPrice};$('deploy').disabled=false;status('Checks passed. Review the estimate, then click Deploy contract.');return ready}
$('provider').addEventListener('change',()=>{selected=$('provider').value;ready=undefined;$('deploy').disabled=true;$('switch-network').hidden=true;$('current-chain').textContent='Connect wallet to check';$('estimate').textContent='Connect wallet to calculate';status('')});
$('connect').addEventListener('click',async()=>{try{status('Checking wallet, chain, bytecode, and gas…');await prepare()}catch(error){status(error.message||String(error))}});
$('switch-network').addEventListener('click',async()=>{try{const wallet=wallets.get($('provider').value);if(!wallet)throw Error('Select a browser wallet first.');status('Approve the network switch in your wallet.');try{await request(wallet.provider,'wallet_switchEthereumChain',[{chainId:'0x3c8'}])}catch(error){if(error.code!==4902&&error.code!=='4902')throw error;await request(wallet.provider,'wallet_addEthereumChain',[{chainId:'0x3c8',chainName:'Bohr Testnet',nativeCurrency:{name:'BOT',symbol:'BOT',decimals:18},rpcUrls:['https://rpc.bohr.life'],blockExplorerUrls:['https://scan.bohr.life']}])}await prepare()}catch(error){status(error.message||String(error))}});
$('deploy').addEventListener('click',async()=>{try{status('Rechecking account, network, and gas…');const prior=ready;const current=await prepare();if(!prior||prior.provider!==current.provider||prior.account.toLowerCase()!==current.account.toLowerCase())throw Error('Wallet changed. Review the estimate and click Deploy again.');$('deploy').disabled=true;status('Approve the contract creation transaction in your wallet.');const hash=await request(current.provider,'eth_sendTransaction',[{from:current.account,data:config.bytecode,gas:hex(current.gasLimit),gasPrice:hex(current.gasPrice)}]);if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('Wallet returned an invalid transaction hash.');status('Transaction submitted. Send this hash to the Lastlight deployment agent for receipt verification.');$('receipt').innerHTML='<p>Transaction hash: <code>'+hash+'</code></p><p><a target="_blank" rel="noreferrer" href="https://scan.bohr.life/tx/'+hash+'">Open transaction in explorer</a></p>'}catch(error){status(error.message||String(error))}});
</script></html>`;

const outputDirectory = '/tmp/lastlight-browser-deploy';
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await writeFile(`${outputDirectory}/index.html`, html, { mode: 0o600 });
console.log(JSON.stringify({ output: `${outputDirectory}/index.html`, deployer, chainId: 968, bytecodeHash, sourceHash, maxCostBOT: 0.1 }, null, 2));
