// 构建期一次性脚本：把 app-icon.svg 渲染为多尺寸 PNG。
// 仅在生成图标时手动运行，不被 app 代码 import，不作为运行时依赖。
// 运行（sharp 来自 backend，不入 pwa deps）：
//   cd pwa
//   SHARP_PATH=/Users/hb02995/other-work/SmartButler/backend/node_modules/sharp/dist/index.mjs \
//     node src/assets/gen-icons.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const sharpPath = process.env.SHARP_PATH ?? 'sharp';
const sharp = (await import(sharpPath)).default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcSvg = resolve(__dirname, 'app-icon.svg');
const publicDir = resolve(__dirname, '../../public');
const svg = readFileSync(srcSvg);

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-512-maskable.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
];

for (const { file, size } of targets) {
  const out = resolve(publicDir, file);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`generated ${file} -> ${meta.width}x${meta.height}`);
}
