import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const root = process.cwd();
const distRoot = resolve(root, 'dist');
const port = Number(process.env.LASTLIGHT_PREVIEW_PORT ?? 4177);
const baseUrl = `http://127.0.0.1:${port}`;
const mount = '/lastlight';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mountedPath(requestUrl: string | undefined): string {
  const pathname = new URL(requestUrl ?? '/', baseUrl).pathname;
  if (pathname === mount) return '/';
  if (pathname.startsWith(`${mount}/`)) return pathname.slice(mount.length) || '/';
  return pathname;
}

async function fileForRequest(requestUrl: string | undefined): Promise<{ path?: string; status: number }> {
  let pathName: string;
  try {
    pathName = decodeURIComponent(mountedPath(requestUrl));
  } catch {
    return { status: 400 };
  }
  const normalized = pathName.replace(/^\/+/, '');
  const requested = resolve(distRoot, normalized);
  if (requested !== distRoot && !requested.startsWith(`${distRoot}${sep}`)) return { status: 403 };
  try {
    const details = await stat(requested);
    if (details.isFile()) return { path: requested, status: 200 };
  } catch {
    // SPA routes fall through to the compiled index; missing asset paths remain 404s.
  }
  if (extname(normalized)) return { status: 404 };
  return { path: join(distRoot, 'index.html'), status: 200 };
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const target = await fileForRequest(request.url);
  if (!target.path) {
    response.writeHead(target.status);
    response.end();
    return;
  }
  const body = await readFile(target.path);
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-length': body.byteLength,
    'content-type': contentTypes[extname(target.path)] ?? 'application/octet-stream',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function listen(): Promise<ReturnType<typeof createServer>> {
  const server = createServer((request, response) => { void serve(request, response); });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return server;
}

function chromiumExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/lunarch/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
  return existsSync(configured) ? configured : undefined;
}

async function visit(page: Page, prefix: string, hash: string, heading: string | RegExp): Promise<void> {
  await page.goto(`${baseUrl}${prefix}/${hash}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: heading }).waitFor();
}

test('compiled routes load at root and repository subpath', async () => {
  assert.equal(existsSync(join(distRoot, 'index.html')), true, 'Run npm run build before the production preview test.');
  const server = await listen();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', (request) => errors.push(`request: ${request.url()} · ${request.failure()?.errorText ?? 'failed'}`));
    page.on('response', (response) => {
      if (response.status() >= 400 && (response.url().includes('/assets/') || response.url().endsWith('/favicon.png'))) errors.push(`asset: ${response.status()} ${response.url()}`);
    });

    for (const prefix of ['', mount]) {
      await visit(page, prefix, '#/', 'A clear next chapter for your BOT.');
      await visit(page, prefix, '#/demo', 'See the plan move.');
      await visit(page, prefix, '#/plans?chain=677', 'Keep the important date close.');
      assert.equal(await page.locator('#network-select').inputValue(), '677');
      await visit(page, prefix, '#/proof/968/0x1111111111111111111111111111111111111111/7', 'Ready to claim');
      assert.equal(await page.locator('body').innerText().then((body) => /Recorded proof|No transaction attached/.test(body)), true);
    }

    const loadedResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    assert.equal(loadedResources.some((resource) => /\/assets\/proof-[^/]+\.js/.test(resource)), true, 'The proof route did not load its lazy chunk.');
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
