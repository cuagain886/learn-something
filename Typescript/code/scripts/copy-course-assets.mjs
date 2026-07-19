/**
 * `tsc` 只负责 emit 被编译的实现与声明，不是通用资产复制器。
 * 第 14 课故意消费手写 JS/.d.ts，因此构建流程显式列出要进入 dist 的资产。
 */

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const assets = [
  ['src/legacy/string-tools.js', 'dist/legacy/string-tools.js'],
  ['src/legacy/string-tools.d.ts', 'dist/legacy/string-tools.d.ts'],
  ['src/globals.d.ts', 'dist/globals.d.ts'],
  [
    'src/14-declarations/trace-context.augmentation.d.ts',
    'dist/14-declarations/trace-context.augmentation.d.ts',
  ],
];

for (const [source, destination] of assets) {
  const sourcePath = path.join(projectRoot, source);
  const destinationPath = path.join(projectRoot, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

console.log(`copied ${assets.length} declaration-course assets`);
