let sequence = 0;
let revertActive: (() => void) | undefined;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * GSAP is loaded only for the horizon/receipt presentation sequence. The
 * semantic state is already in the DOM, so the app remains usable if motion
 * is reduced or the optional chunk cannot load.
 */
export async function animateRoutePresentation(container: ParentNode): Promise<void> {
  const token = ++sequence;
  revertActive?.();
  revertActive = undefined;
  if (reducedMotion()) return;
  const horizon = container.querySelector<HTMLElement>('.horizon:not(.horizon--compact)');
  const receipt = container.querySelector<HTMLElement>('.receipt-card');
  const routeTargets = Array.from(container.querySelectorAll<HTMLElement>('[data-motion]'));
  const main = container.querySelector<HTMLElement>('#main-content');
  const pageIntro = routeTargets.length ? null : main?.querySelector<HTMLElement>('.product-hero__copy, .receive-hero > div:first-child, .plan-heading, .not-found');
  const pageArt = routeTargets.length ? null : main?.querySelector<HTMLElement>('.product-hero__art, .receive-hero__art');
  const pageContent = routeTargets.length ? null : main?.querySelector<HTMLElement>('.builder-layout, .plans-content, .launch-content, .plan-layout, .receive-layout, .proof-layout');
  if (!horizon && !receipt && !routeTargets.length && !pageIntro && !pageContent) return;
  try {
    const { gsap } = await import('gsap');
    if (token !== sequence) return;
    const scope = main ?? horizon ?? receipt ?? routeTargets[0];
    if (!scope) return;
    const context = gsap.context(() => {
      if (routeTargets.length) {
        gsap.fromTo(routeTargets, { opacity: 1, y: 16 }, { opacity: 1, y: 0, duration: 0.46, stagger: 0.06, ease: 'power2.out' });
      } else {
        if (pageIntro) gsap.fromTo(pageIntro, { opacity: 0.9, y: 14 }, { opacity: 1, y: 0, duration: 0.48, ease: 'power3.out' });
        if (pageArt) gsap.fromTo(pageArt, { x: 20 }, { x: 0, duration: 0.6, ease: 'power3.out' });
        if (pageContent && !horizon && !receipt) gsap.fromTo(pageContent, { opacity: 0.94, y: 10 }, { opacity: 1, y: 0, duration: 0.42, delay: 0.08, ease: 'power3.out' });
      }
      if (horizon) {
        const active = horizon.querySelector<HTMLElement>('.horizon__active');
        const milestones = horizon.querySelectorAll<HTMLElement>('.horizon__milestone');
        if (active) gsap.fromTo(active, { scaleX: .78, transformOrigin: 'left center' }, { scaleX: 1, duration: 0.7, ease: 'power2.out' });
        if (milestones.length) gsap.fromTo(milestones, { opacity: .76 }, { opacity: 1, duration: 0.45, delay: 0.25, stagger: 0.08, ease: 'power1.out' });
      }
      if (receipt) gsap.fromTo(receipt, { opacity: 1, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power1.out' });
    }, scope);
    revertActive = () => context.revert();
  } catch {
    // Motion is optional. Static semantic content remains visible.
  }
}

export function disposeRoutePresentation(): void {
  sequence += 1;
  revertActive?.();
  revertActive = undefined;
}

export function animateCreateStep(container: ParentNode): void {
  if (reducedMotion()) return;
  container.querySelector<HTMLElement>('.create-page .builder-step')?.animate(
    [{ opacity: 0.88, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}
