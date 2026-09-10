// Run: node tests/browser/asset-deletion.mjs. Real Next.js UI; all data and mutations stay in this in-memory API.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

const prefix = '/feisu/assets-library';
const cursor = page => Buffer.from(JSON.stringify({ page })).toString('base64url');
let assets, deleted, failedId, polls;
function reset(count = 25, userId = null, fail = null) {
  deleted = []; polls = new Map(); failedId = fail;
  assets = Array.from({ length: count }, (_, i) => ({
    asset_id: `asset-${i + 1}`, user_id: userId, name: `测试素材 ${i + 1}`, description: '夕阳下的城市',
    media_type: 'image', status: 'done', review_status: 'published', tags: [{ category: 'scene', value: '夕阳' }],
    media_url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#fda45e"/></svg>'),
    created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
    original_filename: 'fixture.png', size_bytes: 100, analysis: null, failure: null,
  }));
}
reset();
const api = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const path = new URL(req.url, 'http://fixture').pathname;
  let result;
  if (path.endsWith('/users')) result = { items: [{ user_id: 'user-7', display_name: '测试用户' }] };
  else if (path.endsWith('/assets/query')) {
    const page = body.cursor ? JSON.parse(Buffer.from(body.cursor, 'base64url')).page : 1;
    const offset = (page - 1) * 8;
    result = { items: assets.slice(offset, offset + 8), has_more: assets.length > offset + 8,
      next_cursor: cursor(page + 1), tag_statistics: { total_assets: assets.length }, search: null };
  } else if (path.includes('/tasks/')) {
    const id = path.split('/').at(-1);
    const poll = (polls.get(id) ?? 0) + 1; polls.set(id, poll);
    result = { task_id: id, status: poll === 1 ? 'running' : id === failedId ? 'failed' : 'done', error: id === failedId ? { message: '测试删除失败' } : null };
    if (result.status === 'done') assets = assets.filter(a => a.asset_id !== id);
  } else if (path.includes('/assets/')) {
    const id = path.split('/').at(-1);
    if (req.method === 'DELETE') {
      assert.equal(body.user_id, assets.find(a => a.asset_id === id)?.user_id);
      deleted.push(id); result = { task_id: id, status: 'queued' }; res.statusCode = 202;
    } else result = assets.find(a => a.asset_id === id);
  }
  if (!result) { res.statusCode = 404; result = { error: { message: `Unexpected fixture path ${path}` } }; }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const apiOrigin = `http://127.0.0.1:${api.address().port}`;
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
mkdirSync('.run/bulk-ui', { recursive: true });
const log = openSync('.run/bulk-ui/next.log', 'w');
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', String(port)], {
  detached: true, stdio: ['ignore', log, log], env: { ...process.env, APP_MODE: 'dev', WEBUI_LOCK_KEY: '',
    NEXT_PUBLIC_BASE_PATH: prefix, API_INTERNAL_ORIGIN: apiOrigin, NEXT_DIST_DIR: '.next-e2e',
    DEV_DATABASE_URL: 'mysql://fixture:fixture@127.0.0.1:1/fixture_test' },
});
let browser;
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(origin + prefix + '/').then(r => r.ok).catch(() => false)) break;
    if (i === 59) throw new Error('Next.js did not become ready; see .run/bulk-ui/next.log');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await fetch(apiOrigin + url.pathname + url.search, { method: request.method(),
      headers: { 'content-type': 'application/json' }, ...(request.postData() ? { body: request.postData() } : {}) });
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  const overview = (number, layout = 'gallery', scope = 'public') => {
    const params = new URLSearchParams({ view: 'published', scope, tag: '夕阳', layout });
    if (scope === 'private') params.set('user_id', 'user-7');
    if (number > 1) {
      params.set('cursor', cursor(number));
      params.set('history', Buffer.from(JSON.stringify(Array.from({ length: number - 1 }, (_, i) => i ? cursor(i + 1) : null))).toString('base64url'));
    }
    return origin + prefix + '?' + params;
  };
  const confirmDelete = async () => {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /^删除所选/ }).click();
  };
  await page.goto(overview(2));
  await page.getByRole('checkbox', { name: '本页全选', exact: true }).check();
  await expect(page.getByRole('button', { name: '删除所选（8）' })).toBeEnabled();
  await page.getByRole('button', { name: '取消选择' }).click();
  await page.getByRole('checkbox', { name: '选择 测试素材 9', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 测试素材 10', exact: true }).check();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除所选（2）' }).click();
  assert.equal(deleted.length, 0);
  await confirmDelete();
  await expect(page.getByRole('status')).toContainText('已删除 2 项');
  await expect(page.getByRole('checkbox', { name: '选择 测试素材 18', exact: true })).toBeVisible();
  assert.equal(page.url(), overview(2));
  console.log('PASS gallery: select all, cancel, async delete, retain page/filter and refill');
  await page.screenshot({ path: '.run/bulk-ui/gallery.png', fullPage: true });

  reset(25, 'user-7', 'asset-9');
  await page.goto(overview(2, 'list', 'private'));
  await page.getByRole('checkbox', { name: '选择 测试素材 9', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 测试素材 10', exact: true }).check();
  await confirmDelete();
  await expect(page.getByRole('status')).toContainText('已删除 1 项，失败 1 项');
  await expect(page.getByRole('checkbox', { name: '选择 测试素材 9', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '选择 测试素材 10', exact: true })).toHaveCount(0);
  assert.equal(page.url(), overview(2, 'list', 'private'));
  console.log('PASS list: private scope, partial failure, retain failed selection');
  await page.screenshot({ path: '.run/bulk-ui/partial-failure.png', fullPage: true });

  reset(17, 'user-7');
  await page.goto(overview(3, 'list', 'private'));
  await page.getByRole('link', { name: '测试素材 17', exact: true }).click();
  await page.waitForLoadState('networkidle');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('第 2 页', { exact: true })).toBeVisible();
  const target = new URL(page.url());
  assert.equal(target.pathname.replace(/\/$/, ''), prefix);
  for (const [key, value] of new URL(overview(2, 'list', 'private')).searchParams) assert.equal(target.searchParams.get(key), value);
  console.log('PASS detail deletion: last page removed, return to last valid page with private filter/layout');

  reset(24);
  await page.goto(overview(3));
  await page.getByRole('checkbox', { name: '本页全选', exact: true }).check();
  await confirmDelete();
  await expect(page.getByText('第 2 页', { exact: true })).toBeVisible();
  assert.equal(deleted.length, 8);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.run/bulk-ui/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS bulk deletion of final page; no browser runtime errors');
} finally {
  await browser?.close();
  process.kill(-web.pid, 'SIGTERM');
  await new Promise(resolve => api.close(resolve));
}
