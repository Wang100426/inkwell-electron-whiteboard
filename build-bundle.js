'use strict';

/**
 * 渲染进程打包：nodeIntegration 为 false 时渲染进程无法 require 本地模块，
 * 所以把 geometry/history/board/app 按依赖顺序拼成单个 bundle.js。
 * 用法：node build-bundle.js
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src', 'renderer');
// 依赖顺序：被依赖者在前
const files = ['geometry.js', 'history.js', 'board.js', 'eraser.js', 'app.js'];

function stripRequires(code) {
  // 去掉 CommonJS 头部与 require 调用
  return code
    .replace(/^\s*'use strict';\s*$/m, '')
    .replace(/^const\s*\{[^}]*\}\s*=\s*require\([^)]*\);?\s*$/gm, '')
    .replace(/^const\s+\w+\s*=\s*require\([^)]*\);?\s*$/gm, '')
    .replace(/^module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/m, '');
}

const parts = files.map((f) => {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  return `/* ===== ${f} ===== */\n${stripRequires(code).trim()}\n`;
});

const banner = `'use strict';
// 本文件由 build-bundle.js 自动生成，请勿直接修改。
// 源文件：geometry.js / history.js / board.js / app.js
`;

const out = banner + parts.join('\n');
const dest = path.join(SRC, 'bundle.js');
fs.writeFileSync(dest, out, 'utf8');

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`bundle.js 生成完成 · ${kb} KB · 源文件 ${files.length} 个`);

// 自检：拼接后不应残留 require / module.exports
const leftovers = out.match(/require\(|module\.exports/g);
if (leftovers) {
  console.error('警告：bundle 中残留 CommonJS 语法 →', leftovers);
  process.exit(1);
}
