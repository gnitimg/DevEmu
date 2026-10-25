/** 下载非 Play 镜像（首启明显更快），走官方 sdkmanager 渠道 */
import { detectSdk, detectJava, runSdkmanager } from '../src/core/sdk.ts';

const pkg = 'system-images;android-36;google_apis;x86_64';
const sdk = detectSdk();
if (!sdk?.sdkmanager) {
  console.error('no sdkmanager');
  process.exit(1);
}
console.log('[dl]', pkg, '开始下载…');
const res = await runSdkmanager(sdk, [pkg], { javaPath: detectJava(), onLine: (l) => /[\\[\d%]/.test(l) && console.log('[dl]', l) });
console.log('[dl] exit:', res.code);
if (res.code !== 0) {
  console.error('[dl] stderr:', res.stderr.slice(0, 500));
  process.exit(1);
}
console.log('[dl] DONE');
