import { run } from '../src/core/exec.ts';
import { detectSdk } from '../src/core/sdk.ts';
import { parseBadging } from '../src/core/apk.ts';
import { listApps } from '../src/core/apk.ts';
import { loadAppSettings } from '../src/core/settings.ts';
import { scopeDirs } from '../src/core/env.ts';
import path from 'node:path';

const sdk = detectSdk();
const settings = loadAppSettings();
const dirs = scopeDirs(settings.dataRoot, { kind: 'project', projectId: 'e2e-验证' });
const apps = listApps(dirs.appsDir);
console.log('apps:', apps.map((a) => ({ id: a.id, pkg: a.packageName })));
const target = path.join(dirs.appsDir, apps[0]!.id + '.apk');
console.log('path:', target);

const res = await run(sdk!.aapt!, ['dump', 'badging', target], { timeoutMs: 30_000 });
console.log('code:', res.code);
console.log('stdout head:', JSON.stringify(res.stdout.slice(0, 150)));
console.log('stderr:', JSON.stringify(res.stderr.slice(0, 300)));
console.log('parsed:', parseBadging(res.stdout) ?? null);
