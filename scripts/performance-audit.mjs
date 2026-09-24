#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const host = '127.0.0.1';
const port = Number(process.env.LASTLIGHT_PERF_PORT ?? 4176);
const baseUrl = `http://${host}:${port}`;
const outputPath = process.env.LASTLIGHT_PERF_OUTPUT ?? 'evidence/local/performance.json';
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/lunarch/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

function waitForServer() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(`${baseUrl}/`);
        if (response.ok) return resolve();
      } catch { /* preview is still starting */ }
      if (Date.now() - started > 15_000) return reject(new Error('Vite preview did not start within 15 seconds.'));
      setTimeout(poll, 150);
    };
    poll();
  });
}

const preview = spawn('npm', ['run', 'preview', '--', '--host', host, '--port', String(port)], { stdio: 'ignore' });
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: existsSync(chromiumPath) ? chromiumPath : undefined, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const metrics = { lcp: 0, cls: 0, inp: 0, observed: { lcp: false, cls: false, inp: false } };
    (window).__lastlightPerformance = metrics;
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries.at(-1);
        if (last) metrics.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      metrics.observed.lcp = true;
    } catch { /* unsupported observers remain an explicit unavailable metric */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) metrics.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      metrics.observed.cls = true;
    } catch { /* unsupported observers remain an explicit unavailable metric */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) metrics.inp = Math.max(metrics.inp, entry.duration);
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
      metrics.observed.inp = true;
    } catch { /* unsupported observers remain an explicit unavailable metric */ }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const started = performance.now();
  await page.goto(`${baseUrl}/#/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /A clear next chapter for your BOT\.|Control has a rhythm\.|A handoff can be clear\./ }).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Explore the demo' }).click();
  await page.getByRole('heading', { name: 'Make the consequence visible.' }).waitFor();
  await page.getByRole('button', { name: /Miss a check-in/ }).click();
  await page.getByRole('heading', { name: 'Check-in overdue' }).waitFor();
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const metrics = (window).__lastlightPerformance ?? { lcp: 0, cls: 0, inp: 0, observed: { lcp: false, cls: false, inp: false } };
    return {
      lcpMs: metrics.observed.lcp && metrics.lcp > 0 ? metrics.lcp : null,
      cls: metrics.observed.cls ? metrics.cls : null,
      inpMs: metrics.observed.inp && metrics.inp > 0 ? metrics.inp : null,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      loadMs: navigation?.loadEventEnd ?? null,
    };
  });
  const evidence = {
    schemaVersion: 'lastlight.performance.v1',
    measuredAt: new Date().toISOString(),
    environment: { mode: 'local production preview', url: baseUrl, viewport: { width: 390, height: 844 }, browser: 'Playwright Chromium', network: 'unthrottled lab' },
    metrics: result,
    budgets: {
      lcpMs: { target: 2500, value: result.lcpMs, pass: result.lcpMs !== null && result.lcpMs <= 2500 },
      cls: { target: 0.1, value: result.cls, pass: result.cls !== null && result.cls <= 0.1 },
      inpMs: { target: 200, value: result.inpMs, pass: result.inpMs !== null && result.inpMs <= 200 },
    },
    checks: { consoleErrors, pageErrors, routeInteractionMs: Math.round(performance.now() - started) },
    note: 'This is a local lab proxy, not field data. Missing browser PerformanceObserver metrics remain unmeasured rather than being treated as zero.',
  };
  await mkdir('evidence/local', { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.budgets.lcpMs.pass || !evidence.budgets.cls.pass || !evidence.budgets.inpMs.pass || consoleErrors.length || pageErrors.length) process.exitCode = 1;
  await context.close();
} finally {
  await browser?.close();
  if (!preview.killed) preview.kill('SIGTERM');
}
