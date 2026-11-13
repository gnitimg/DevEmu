#!/usr/bin/env node
/**
 * 主进程阻塞操作审计：ipcMain handler 与 core 模块在主进程内执行，
 * 同步递归删除 / 同步复制大文件会冻结全部窗口（迁移“未响应”事故的根因）。
 * 规则：src/core 与 src/ipc.ts 内出现 copyFileSync / cpSync / 递归 rmSync
 * 视为违规；行尾 `// sync-ok: 理由` 显式豁免（单文件 unlink 等元数据级操作不违反）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = [
  path.join(root, 'src', 'ipc.ts'),
  ...fs.readdirSync(path.join(root, 'src', 'core')).map((f) => path.join(root, 'src', 'core', f)),
];
const violations = [];

for (const file of targets) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/sync-ok:/.test(line)) return;
    const no = i + 1;
    const rel = path.relative(root, file);
    const trimmed = line.trim();
    // 纯注释行（如解释为何用异步的历史说明）不参与匹配
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (/copyFileSync|cpSync\(/.test(line)) violations.push(`${rel}:${no}: ${line.trim()}`);
    // rmSync 的 recursive 常在下一行的选项对象里：向前看 4 行，豁免注释同样生效
    if (/rmSync\(/.test(line)) {
      const window = lines.slice(i, i + 4).join(' ');
      if (/recursive:\s*true/.test(window) && !/sync-ok:/.test(window))
        violations.push(`${rel}:${no}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error('发现主进程阻塞式文件操作（改 fs.promises，或行尾 // sync-ok: 说明豁免理由）：');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('sync-fs 审计通过：无阻塞式大文件操作');
