import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const baseUrl = 'http://127.0.0.1:4174';
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

async function waitForServer(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Vite did not start within 15 seconds.');
}

async function settleVisuals(): Promise<void> {
  assert.ok(page);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(850);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

async function auditRoute(path: string, heading: string): Promise<void> {
  assert.ok(page);
  await page.goto(`${baseUrl}/${path}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: heading }).waitFor();
  await settleVisuals();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.equal(
    results.violations.length,
    0,
    results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(', ')}`).join('\n'),
  );
}

test.before(async () => {
  server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4174'], { cwd: process.cwd(), stdio: 'ignore' });
  await waitForServer();
  const installedChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/lunarch/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
  browser = await chromium.launch({ executablePath: existsSync(installedChromium) ? installedChromium : undefined, headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
});

test.after(async () => {
  await context?.close();
  await browser?.close();
  if (server && !server.killed) server.kill('SIGTERM');
});

test('core routes pass the automated WCAG 2 AA audit', async () => {
  assert.ok(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await auditRoute('#/', 'A clear next chapter for your BOT.');
  await auditRoute('#/__components', 'Component gallery');
  await auditRoute('#/demo', 'See the plan move.');
  await auditRoute('#/create', 'Who should be able to claim?');
  await auditRoute('#/plans', 'Keep the important date close.');
  await auditRoute('#/receive/968/0x1111111111111111111111111111111111111111/7', 'A plan for its named recipient.');
  await auditRoute('#/proof/968/0x1111111111111111111111111111111111111111/7', 'Ready to claim');
  await auditRoute('#/plan/968/0x2222222222222222222222222222222222222222/7', 'This locator is read-only until it is allowlisted.');
  await auditRoute('#/about', 'Continuity without the mystery.');
  await auditRoute('#/launch', 'A truthful launch page starts before launch.');
});

test('compiled app keeps rehearsal and locator routes usable without a wallet', async () => {
  assert.ok(page);
  assert.ok(browser);
  const noJsContext = await browser.newContext({ javaScriptEnabled: false });
  const noJsPage = await noJsContext.newPage();
  await noJsPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await noJsPage.getByRole('heading', { name: 'A clear next chapter for your BOT.' }).waitFor();
  assert.match(await noJsPage.locator('body').innerText(), /JavaScript is required for rehearsal and wallet transactions/);
  await noJsContext.close();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mkdir('evidence/local/screenshots', { recursive: true });

  await page.goto(`${baseUrl}/#/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'A clear next chapter for your BOT.' }).waitFor();
  await settleVisuals();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('.wallet-error').waitFor();
  assert.match(await page.locator('.wallet-error').innerText(), /No wallet browser was found/);
  assert.equal(await page.getByRole('button', { name: 'Copy page link' }).count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'connect-wallet');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'A clear next chapter for your BOT.' }).waitFor();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/home-desktop.png', fullPage: true });
  assert.equal(await page.locator('main h1').count(), 1);
  assert.equal(await page.locator('a.skip-link').getAttribute('href'), '#main-content');
  const firstMoment = page.locator('[role="tab"][data-scene="choose"]');
  await firstMoment.focus();
  await firstMoment.press('ArrowRight');
  assert.equal(await page.locator('[role="tab"][data-scene="check-in"]').getAttribute('aria-selected'), 'true');

  await page.goto(`${baseUrl}/#/demo`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'See the plan move.' }).waitFor();
  assert.match(await page.locator('body').innerText(), /Guided testnet path/);
  assert.match(await page.locator('body').innerText(), /3 minutes \+ 3 minutes/);
  assert.equal(await page.locator('a', { hasText: 'BOT test faucet' }).count(), 1);
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/demo-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /Miss a check-in/ }).click();
  await page.getByRole('heading', { name: 'Check-in overdue' }).waitFor();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/demo-grace-desktop.png', fullPage: true });

  await page.goto(`${baseUrl}/#/create`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Who should be able to claim?' }).waitFor();
  const draftPersistence = page.locator('#draft-persistence');
  assert.equal(await draftPersistence.isChecked(), false);
  await page.locator('#recipient-address').fill('0x1111111111111111111111111111111111111111');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Who should be able to claim?' }).waitFor();
  assert.equal(await page.locator('#recipient-address').inputValue(), '');
  await page.locator('#draft-persistence').check();
  await page.locator('#recipient-address').fill('0x1111111111111111111111111111111111111111');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Who should be able to claim?' }).waitFor();
  assert.equal(await page.locator('#draft-persistence').isChecked(), true);
  assert.equal(await page.locator('#recipient-address').inputValue(), '0x1111111111111111111111111111111111111111');
  await page.locator('#draft-persistence').uncheck();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Who should be able to claim?' }).waitFor();
  assert.equal(await page.locator('#recipient-address').inputValue(), '');
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/builder-recipient-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#recipient-error').waitFor();
  assert.equal(await page.locator('#recipient-address').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'recipient-address');
  await page.getByRole('button', { name: 'Use demo address' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/builder-timing-desktop.png', fullPage: true });
  await page.locator('#inactivity-days').selectOption('custom');
  await page.locator('#grace-days').selectOption('custom');
  await page.locator('[data-custom-unit="inactivityPeriod"]').selectOption('seconds');
  await page.locator('[data-custom-period="inactivityPeriod"]').fill('60');
  await page.locator('[data-custom-unit="gracePeriod"]').selectOption('seconds');
  await page.locator('[data-custom-period="gracePeriod"]').fill('30');
  assert.match(await page.locator('body').innerText(), /Check in by/);
  assert.equal(await page.locator('[data-custom-period="inactivityPeriod"]').inputValue(), '60');
  assert.equal(await page.locator('[data-custom-period="gracePeriod"]').inputValue(), '30');
  await page.locator('#builder-rehearsal-slider').fill('989');
  await page.getByRole('button', { name: 'Return during grace' }).click();
  assert.match(await page.locator('.builder-preview').innerText(), /Owner can check in/);
  assert.match(await page.locator('body').innerText(), /resets this preview/);
  await page.locator('#builder-rehearsal-slider').fill('1000');
  await page.getByRole('button', { name: 'Return during grace' }).click();
  assert.match(await page.locator('.builder-preview').innerText(), /Recipient can claim/);
  assert.match(await page.locator('body').innerText(), /owner control cannot reset this preview/);
  await page.getByRole('button', { name: 'Miss R' }).click();
  assert.match(await page.locator('.builder-preview').innerText(), /Check-in still available/);
  assert.match(await page.locator('body').innerText(), /R has passed/);
  await page.getByRole('button', { name: 'Return during grace' }).click();
  assert.match(await page.locator('.builder-preview').innerText(), /Owner can check in/);
  assert.match(await page.locator('body').innerText(), /resets this preview/);
  await page.getByRole('button', { name: 'Pass D' }).click();
  assert.match(await page.locator('.builder-preview').innerText(), /Recipient can claim/);
  assert.match(await page.locator('body').innerText(), /D has passed/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/builder-amount-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/builder-review-desktop.png', fullPage: true });
  assert.match(await page.locator('body').innerText(), /1 minute/);
  assert.match(await page.locator('body').innerText(), /30 seconds/);

  await page.goto(`${baseUrl}/#/proof/968/0x1111111111111111111111111111111111111111/7`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Ready to claim' }).waitFor();
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/proof-recorded-desktop.png', fullPage: true });
  assert.match(await page.locator('body').innerText(), /Recorded proof/);
  assert.match(await page.locator('body').innerText(), /No transaction attached/);

  await page.goto(`${baseUrl}/#/plan/968/0x2222222222222222222222222222222222222222/7`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'This locator is read-only until it is allowlisted.' }).waitFor();
  assert.equal(await page.locator('[data-locator-route]').count(), 1);

  await page.setViewportSize({ width: 375, height: 812 });
  await settleVisuals();
  await page.screenshot({ path: 'evidence/local/screenshots/unsupported-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
});

test('responsive breakpoint matrix keeps core journeys visible in accessibility media modes', async () => {
  assert.ok(page);
  const viewports = [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 844, height: 390 },
  ];
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`${baseUrl}/#/`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: /A clear next chapter for your BOT\.|Control has a rhythm\.|A handoff can be clear\./ }).waitFor();
      const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#main-content *')).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1) ? [element.tagName.toLowerCase()] : [];
      }).slice(0, 5));
      assert.deepEqual(overflow, [], `home overflow at ${viewport.width}x${viewport.height}: ${overflow.join(', ')}`);
      assert.equal(await page.getByRole('link', { name: 'Try the demo' }).isVisible(), true);

      await page.goto(`${baseUrl}/#/create`, { waitUntil: 'networkidle' });
      await page.locator('[data-create-step="0"]').click();
      await page.getByRole('heading', { name: 'Who should be able to claim?' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Continue' }).isVisible(), true);
      const createOverflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#main-content *')).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1)
          ? [`${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className && typeof element.className === 'string' ? `.${element.className.trim().replace(/\s+/g, '.')}` : ''} (${Math.round(rect.left)}..${Math.round(rect.right)})`]
          : [];
      }).slice(0, 8));
      assert.deepEqual(createOverflow, [], `builder overflow at ${viewport.width}x${viewport.height}: ${createOverflow.join(', ')}`);
    }
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  }
});
