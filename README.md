# Lastlight

Lastlight is an owner-controlled BOT continuity plan on BOT Chain. An owner funds a plan for one recipient and keeps control by checking in before a deadline. If the owner misses the check-in and the extra time expires, only the named recipient can claim the deposit. The claim requires a wallet transaction; funds never move automatically.

The deadline changes **who is allowed to act**, not where the money goes by itself. This keeps the owner in control while they keep checking in and gives the recipient a verifiable claim path when that control ends.

**Live app:** [lastlight.website](https://lastlight.website) · **Mainnet contract:** [view on BOT Chain Explorer](https://scan.botchain.ai/address/0x8a16dA8aAB1db133b3d1CFFbEC1761C0441B322D)

## Try the main flow

1. Open the live app and connect a wallet on **BOT Chain Mainnet (chain ID 677)**. The wallet needs BOT for both the deposit and transaction fees.
2. Select **Create plan**. Enter a different wallet as the recipient, choose the check-in interval and extra time, set the BOT amount, then review and confirm the funding transaction in your wallet.
3. Open **My plans → Created by me** to inspect the plan. Before the final deadline, the owner can check in to renew the schedule, change the recipient, or close the plan.
4. Share the recipient link from the plan page. After the final deadline, the named recipient connects their wallet and selects **Claim BOT**. The recipient pays the claim transaction fee.

The contract, rather than the browser, enforces who may act and when. Plan status, deadlines, and transactions are read from BOT Chain. Optional local labels and reminders stay in the browser and do not change the contract.

## Deployment

| Network | Chain ID | Contract address | Evidence |
| --- | ---: | --- | --- |
| BOT Chain Mainnet | 677 | [`0x8a16dA8aAB1db133b3d1CFFbEC1761C0441B322D`](https://scan.botchain.ai/address/0x8a16dA8aAB1db133b3d1CFFbEC1761C0441B322D) | [Deployment transaction](https://scan.botchain.ai/tx/0x0d1fd3d99f8a6cf89bbdf8399d55145f08b24fa1e9edb2aeae9e9715086d7840); source verified on the explorer |
| BOT Chain Testnet | 968 | [`0x4A13EC346A86536077Ddb67100DcbF6Ec06EdD28`](https://scan.bohr.life/address/0x4A13EC346A86536077Ddb67100DcbF6Ec06EdD28) | Source verified; a funded 3 BOT plan was [created](https://scan.bohr.life/tx/0xf2cdccdbdf33ac77506dfd7bd52596456e2d6f59971d8f8f627527f1be9e297a) and [claimed](https://scan.bohr.life/tx/0x7d72c62c811834141f140a0cbbdf18e70751cb0d14a4902decd46bdb97c4e181) |

Lastlight is officially launched on BOT Chain Mainnet. The public app uses mainnet only. The funded create-to-claim path was completed on testnet; the mainnet contract has passed read-only checks and transaction simulation, but a funded mainnet plan has not yet been run.

## Run locally

The frontend uses TypeScript and Vite. With Node.js 22 or newer:

```bash
npm ci
npm run dev
```

The smart contract is [`contracts/src/LastlightVault.sol`](contracts/src/LastlightVault.sol). The deployment records are in [`deployments/677.json`](deployments/677.json) and [`deployments/968.json`](deployments/968.json). To build the static site, run `npm run build`. The published site is hosted on GitHub Pages at the custom domain above.

## Limits

Lastlight does not detect death or verify identity. The owner may act until the final deadline; after that, owner control closes and the named recipient must initiate a claim. A recipient who loses access to their wallet cannot claim through Lastlight.
