import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from './exec.ts';
import { extractZip } from './envinstall.ts';

test(
  'extractZip 解压含盘符路径的 zip',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-extract-'));
    const src = path.join(root, 'payload');
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(src, 'bin', 'hdc.exe'), 'hdc');

    const zip = path.join(root, 'payload.zip');
    const ps = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(src, '*')}' -DestinationPath '${zip}' -Force`,
    ]);
    assert.equal(ps.code, 0, ps.stderr);

    const dest = path.join(root, 'out');
    await extractZip(zip, dest);
    assert.equal(
      fs.readFileSync(path.join(dest, 'bin', 'hdc.exe'), 'utf8'),
      'hdc',
    );
    fs.rmSync(root, { recursive: true, force: true });
  },
);
