import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  adoptExternalDownload,
  cancelDownload,
  initDownloadStore,
  listDownloads,
} from './downloads.ts';

function store(): void {
  initDownloadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-dl-')));
}

/** 完成态归档有 600ms 延迟（等进度条补满动画），断言历史前先等收尾 */
function settleArchive(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 700));
}

test('adoptExternalDownload 进度入列，完成后进入历史', async () => {
  store();
  const done: { ok: boolean; cancelled?: boolean; error?: string }[] = [];
  const task = adoptExternalDownload({
    key: 'harmony-test-done',
    desc: 'HarmonyOS 命令行工具',
    onCancel: () => undefined,
    postProcess: async (_f, setPct) => setPct(95),
    onDone: (r) => done.push(r),
  });
  task.progress(50, 100);
  const active = listDownloads().active.find(
    (d) => d.pkg === 'harmony-test-done',
  );
  assert.ok(active);
  assert.equal(active!.percent, 48);

  await task.complete('C:/tmp/none.zip');
  await settleArchive();
  const fin = listDownloads().finished.find(
    (d) => d.pkg === 'harmony-test-done',
  );
  assert.equal(fin?.state, 'done');
  assert.equal(fin?.percent, 100);
  assert.deepEqual(done, [{ ok: true, cancelled: false, error: undefined }]);
});

test('adoptExternalDownload 落位失败标记 failed 并回传错误', async () => {
  store();
  const done: { ok: boolean; cancelled?: boolean; error?: string }[] = [];
  const task = adoptExternalDownload({
    key: 'harmony-test-fail',
    desc: 'HarmonyOS 命令行工具',
    onCancel: () => undefined,
    postProcess: async () => {
      throw new Error('压缩包内未找到 hdc');
    },
    onDone: (r) => done.push(r),
  });
  await task.complete('C:/tmp/none.zip');
  const fin = listDownloads().finished.find(
    (d) => d.pkg === 'harmony-test-fail',
  );
  assert.equal(fin?.state, 'failed');
  assert.match(fin!.error!, /未找到 hdc/);
  assert.deepEqual(done, [
    { ok: false, cancelled: false, error: '压缩包内未找到 hdc' },
  ]);
});

test('adoptExternalDownload 取消后不再落位', async () => {
  store();
  let cancelled = false;
  const done: { ok: boolean; cancelled?: boolean }[] = [];
  const task = adoptExternalDownload({
    key: 'harmony-test-cancel',
    desc: 'HarmonyOS 命令行工具',
    onCancel: () => {
      cancelled = true;
    },
    postProcess: async () => {
      throw new Error('不应执行');
    },
    onDone: (r) => done.push(r),
  });
  assert.equal(cancelDownload('harmony-test-cancel'), true);
  assert.equal(cancelled, true);
  task.fail('已取消');
  const fin = listDownloads().finished.find(
    (d) => d.pkg === 'harmony-test-cancel',
  );
  assert.equal(fin?.state, 'cancelled');
  assert.deepEqual(done, [{ ok: false, cancelled: true, error: undefined }]);
});

test('临时任务（应用更新包）完成不写入持久化历史', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-dl-'));
  initDownloadStore(root);
  const task = adoptExternalDownload({
    key: 'app-update-ephemeral',
    desc: 'DevEmu v9.9.9 更新包',
    ephemeral: true,
    onCancel: () => undefined,
    postProcess: async () => undefined,
  });
  await task.complete('C:/tmp/update.exe');
  await settleArchive();
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, 'downloads.json'), 'utf8'),
  ) as { finished?: { pkg: string }[] };
  assert.ok(!raw.finished?.some((f) => f.pkg === 'app-update-ephemeral'));
});

test('常规外部任务完成仍写入持久化历史', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-dl-'));
  initDownloadStore(root);
  const task = adoptExternalDownload({
    key: 'normal-persist',
    desc: '常规任务',
    onCancel: () => undefined,
    postProcess: async () => undefined,
  });
  await task.complete('C:/tmp/none.zip');
  await settleArchive();
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, 'downloads.json'), 'utf8'),
  ) as { finished?: { pkg: string }[] };
  assert.ok(raw.finished?.some((f) => f.pkg === 'normal-persist'));
});
