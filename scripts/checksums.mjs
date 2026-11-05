// 生成 sha256sum 风格校验清单（`<hex>  <文件名>`），发布 CI 与本地共用
// 用法：node scripts/checksums.mjs <file> [file...] > checksums.txt
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error(
    '用法：node scripts/checksums.mjs <file> [file...] > checksums.txt',
  );
  process.exit(1);
}
for (const file of files) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = createReadStream(file);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  console.log(`${hash.digest('hex')}  ${path.basename(file)}`);
}
