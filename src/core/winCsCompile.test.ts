import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './exec.ts';
import { DRAG_CS, GEOMETRY_CS, REPOSITION_CS } from './win.ts';

// 三个窗口脚本（reposition/geometry/drag）的内嵌 C# 在运行时经 Add-Type 编译，
// 脚本里的 SilentlyContinue 会吞掉编译失败（表现为药丸定位静默失效）——
// 这里强制编译，C# 语法/签名错误必须在此暴露。
for (const [name, cs] of [
  ['reposition', REPOSITION_CS],
  ['geometry', GEOMETRY_CS],
  ['drag', DRAG_CS],
] as const) {
  test(
    `窗口脚本 C# 编译通过（${name}）`,
    {
      skip: process.platform !== 'win32',
      timeout: 60_000,
    },
    async () => {
      const res = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${cs}\n'@\nWrite-Output COMPILED`,
        ],
        { timeoutMs: 50_000 },
      );
      assert.equal(res.code, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /COMPILED/);
    },
  );
}
