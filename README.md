# Lastlight

Lastlight lets someone set aside BOT for one chosen recipient while retaining control through periodic check-ins. If the final deadline passes, the recipient can make a manual claim. Funds do not move automatically.

The project is a TypeScript/Vite app and a Solidity `LastlightVault` contract on BOT Chain. The app provides plan creation, owner and recipient views, claim links, and on-chain proof.

## Use locally

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Connect an EVM wallet to create or view a plan. The wallet must be on the network shown in the app. To build the static site, run `npm run build`.

## Deployment

| Network | Chain ID | Contract | Status |
| --- | ---: | --- | --- |
| BOT Testnet | 968 | [`0x4A13EC346A86536077Ddb67100DcbF6Ec06EdD28`](https://scan.bohr.life/address/0x4A13EC346A86536077Ddb67100DcbF6Ec06EdD28) | Source verified; a funded 3 BOT plan was [created](https://scan.bohr.life/tx/0xf2cdccdbdf33ac77506dfd7bd52596456e2d6f59971d8f8f627527f1be9e297a) and [claimed](https://scan.bohr.life/tx/0x7d72c62c811834141f140a0cbbdf18e70751cb0d14a4902decd46bdb97c4e181) |
| BOT Mainnet | 677 | [`0x8a16dA8aAB1db133b3d1CFFbEC1761C0441B322D`](https://scan.botchain.ai/address/0x8a16dA8aAB1db133b3d1CFFbEC1761C0441B322D) | [Deployed](https://scan.botchain.ai/tx/0x0d1fd3d99f8a6cf89bbdf8399d55145f08b24fa1e9edb2aeae9e9715086d7840), source verified, read-only checks passed |

Lastlight is officially launched on BOT Chain Mainnet. The frontend reads deployment state from `deployments/968.json` and `deployments/677.json` and uses mainnet by default. The funded create-to-claim flow was completed on testnet; the mainnet deployment has passed read-only checks and transaction simulation, but no funded mainnet plan has been run yet.

Website: [lastlight.website](https://lastlight.website)

The contract source is in [`contracts/src/LastlightVault.sol`](contracts/src/LastlightVault.sol). Foundry configuration and contract tests are under `contracts/`. The site is built as static files and hosted on GitHub Pages.

## Boundaries

Lastlight does not detect death or verify anyone's identity. The owner controls a plan before its final deadline; after that deadline, the named recipient must initiate a claim. On-chain state determines the result, while local labels and reminders are conveniences stored in the browser.
