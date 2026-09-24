import { button, icon } from '../components/ui';

export function renderNotFound(): string {
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('warning')}</div><p class="eyebrow">Link unavailable</p><h1>This plan link is incomplete.</h1><p>Check the chain, contract address, and numeric plan ID. Lastlight will not request a signature for an unsupported or invalid locator.</p><div>${button('Back to overview', { href: '#/', icon: 'arrow' })}${button('Create a plan', { href: '#/create', variant: 'secondary', icon: 'arrow' })}</div></div>`;
}
