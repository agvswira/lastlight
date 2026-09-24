import { button, escapeHtml, icon } from '../components/ui';
import type { AppState } from '../app/state';
import { planCard } from './shared';
import { renderHowItWorks } from '../components/process';

function renderQuestions(): string {
  const questions = [
    ['What happens if I miss a check-in?', 'The plan enters its grace period. The owner can still check in before the final deadline; after that, owner actions close.'],
    ['Does the deadline transfer funds automatically?', 'No. Funds stay in the plan until the named recipient submits a successful claim transaction after the final deadline.'],
    ['Can I change the recipient?', 'The owner can change the named recipient before the final deadline, including during grace. Changing the recipient does not reset the schedule.'],
    ['What information is public?', 'The owner and recipient addresses, amount, schedule, and confirmed transactions are on-chain. A local plan label stays on your device.'],
    ['Do I need a wallet to create a plan?', 'You can prepare the details without connecting. To create and fund the plan, connect your wallet and confirm the transaction.'],
    ['What does the recipient need to claim?', 'The recipient needs the wallet named in the plan, access to the plan’s network, and enough BOT for transaction fees. Claiming becomes available only after the final deadline.'],
  ];
  return `<section class="shell-width faq-section" aria-labelledby="questions-heading"><div class="faq-section__heading"><h2 id="questions-heading">Questions before you start</h2><p>Straight answers about check-ins, deadlines, and claiming.</p></div><div class="faq-list">${questions.map(([question, answer]) => `<details class="faq-item"><summary>${escapeHtml(question)}</summary><p>${escapeHtml(answer)}</p></details>`).join('')}</div></section>`;
}

export function renderHome(state: AppState): string {
  const visiblePlans = state.livePlans.slice(0, 3);
  return `<div class="overview-page">
    <section class="overview-hero" aria-labelledby="overview-heading"><div class="shell-width overview-hero__inner"><div class="overview-hero__copy" data-motion="hero"><h1 id="overview-heading"><span>Make a plan.</span><span>Stay in control.</span></h1><p class="lede">Set a named recipient, funding amount, and check-in schedule, with a final deadline for the claim right.</p><div class="overview-hero__action">${button('Create plan', { href: '#/create' })}</div></div><div class="overview-hero__visual" data-motion="hero" aria-hidden="true"><img src="/assets/lastlight-hero.webp" alt="" width="900" height="629" fetchpriority="high" decoding="async"></div></div></section>
    ${renderHowItWorks()}
    ${renderQuestions()}
    ${visiblePlans.length ? `<section class="shell-width overview-plans"><div class="section-heading section-heading--row"><h2>Plans loaded in this session</h2><a class="text-link" href="#/plans">View all ${icon('arrow')}</a></div><div class="overview-plan-list">${visiblePlans.map((plan) => planCard(plan, `#/plan/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`)).join('')}</div></section>` : ''}
  </div>`;
}
