type ProcessStep = {
  number: string;
  title: string;
  copy: string;
  image: string;
  alt: string;
};

const steps: ProcessStep[] = [
  {
    number: '01',
    title: 'Create your plan',
    copy: 'Choose a recipient, amount, and check-in schedule.',
    image: './assets/how-plan-light.webp',
    alt: 'A graphite vault sealed by a ribbon of lime light.',
  },
  {
    number: '02',
    title: 'Keep checking in',
    copy: 'Each confirmed check-in renews your deadline.',
    image: './assets/how-checkin-light.webp',
    alt: 'A graphite calendar with a glowing check-in mark.',
  },
  {
    number: '03',
    title: 'Grace period',
    copy: 'Missed a check-in? You still have time to renew.',
    image: './assets/how-grace-light.webp',
    alt: 'A graphite timer with a short illuminated amber interval.',
  },
  {
    number: '04',
    title: 'Recipient claims',
    copy: 'After the final deadline, your recipient can claim.',
    image: './assets/how-claim-light.webp',
    alt: 'An open graphite vault with lime light reaching a claim button.',
  },
];

export function renderHowItWorks(): string {
  return `<section class="process-section shell-width" id="how-it-works" aria-labelledby="process-heading">
    <h2 id="process-heading" tabindex="-1">How Lastlight works</h2>
    <div class="process-grid">${steps.map((step) => `<article class="process-card" data-motion="process"><div class="process-card__visual"><img class="process-illustration" src="${step.image}" alt="${step.alt}" width="768" height="768" loading="lazy" decoding="async"></div><div class="process-card__number">${step.number}</div><h3>${step.title}</h3><p>${step.copy}</p></article>`).join('')}</div>
  </section>`;
}
