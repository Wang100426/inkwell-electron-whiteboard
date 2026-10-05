'use strict';

/**
 * 修复 electron-builder 在 Windows 上打包 exe 时的两个问题。
 *
 * 问题 1（致命）：rcedit 报 `Fatal error: Unable to commit changes`
 *
 *   packaging 刚把 Electron 的 exe 复制到 win-unpacked 后，会立刻调用
 *   rcedit 写入版本信息和图标。此时 exe 的文件句柄尚未完全释放
 *   （安全软件也常在此刻扫描新生成的大文件），导致 rcedit 替换文件失败。
 *
 *   electron-builder 内置了 3 次重试，但**间隔太短**，全部撞在同一把锁上，
 *   整个打包流程因此中止，产不出安装包。
 *   实测：每次成功修改后需要间隔一段时间才能再次修改，
 *   改为递增延迟重试（0.7s / 1.2s / 1.7s …）后稳定通过。
 *
 * 问题 2（非致命）：OriginalFilename 被写成空串
 *
 *   electron-builder 硬编码传 `--set-version-string OriginalFilename ""`，
 *   语义上该值应为 exe 文件名。这里顺手改正确。
 *
 * 用法：node scripts/fix-electron-builder.js
 *       （已接入 npm run dist / dist:dir，无需手动调用）
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'winPackager.js'
);

const MARK = 'PATCH(rcedit-retry)';

/** 原始那一行（electron-builder 25.x 的写法） */
const ORIGINAL_RCEDIT_LINE = 'await (0, builder_util_1.executeAppBuilder)(["rcedit", "--args", JSON.stringify(args)], undefined /* child-process */, {}, 3 /* retry three times */);';

/** 替换成带递增延迟的重试循环 */
const PATCHED_RCEDIT = [
  `// ${MARK} —— 规避文件锁竞态，改用递增延迟重试`,
  'let rceditError = null;',
  'for (let attempt = 0; attempt < 8; attempt++) {',
  '    try {',
  '        await (0, builder_util_1.executeAppBuilder)(["rcedit", "--args", JSON.stringify(args)], undefined, {}, 0);',
  '        rceditError = null;',
  '        break;',
  '    }',
  '    catch (e) {',
  '        rceditError = e;',
  '        const waitMs = 700 + attempt * 500;',
  '        console.log("  • rcedit 撞上文件锁，等待 " + waitMs + "ms 后重试（第 " + (attempt + 2) + " 次）");',
  '        await new Promise((resolve) => setTimeout(resolve, waitMs));',
  '    }',
  '}',
  'if (rceditError != null) {',
  '    throw rceditError;',
  '}',
].join('\n');

function log(msg) {
  console.log('  ' + msg);
}

function main() {
  console.log('\n修复 electron-builder 打包问题\n');

  if (!fs.existsSync(TARGET)) {
    console.error('  ✗ 找不到 app-builder-lib/out/winPackager.js');
    console.error('    请先执行 npm install');
    process.exit(1);
  }

  let src = fs.readFileSync(TARGET, 'utf8');
  let changed = 0;

  /* ---------- 问题 1：rcedit 重试间隔 ---------- */
  if (src.includes(MARK)) {
    log('✓ rcedit 延迟重试：已是修复版');
  } else {
    const idx = src.indexOf(ORIGINAL_RCEDIT_LINE);
    if (idx < 0) {
      log('✗ 未找到 rcedit 调用行 —— electron-builder 版本可能已变');
      log('  请检查 node_modules/app-builder-lib/out/winPackager.js');
      log('  搜索 "rcedit" 并手动确认重试逻辑');
    } else {
      // 保留原有缩进
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      const indent = src.slice(lineStart, idx);
      const indented = PATCHED_RCEDIT.split('\n')
        .map((l, i) => (i === 0 ? l : indent + l))
        .join('\n');
      src = src.slice(0, idx) + indented + src.slice(idx + ORIGINAL_RCEDIT_LINE.length);
      changed++;
      log('✓ rcedit 延迟重试：已应用');
    }
  }

  /* ---------- 问题 2：OriginalFilename 空串 ---------- */
  const EMPTY_ORIGINAL = '"--set-version-string", "OriginalFilename", ""';
  if (src.includes('"OriginalFilename", internalName + ".exe"')) {
    log('✓ OriginalFilename：已修正');
  } else if (src.includes(EMPTY_ORIGINAL)) {
    src = src.replace(
      EMPTY_ORIGINAL,
      '"--set-version-string", "OriginalFilename", internalName + ".exe"'
    );
    changed++;
    log('✓ OriginalFilename：已修正（不再是空串）');
  } else {
    log('· OriginalFilename：未找到空串写法，跳过');
  }

  if (changed > 0) {
    fs.writeFileSync(TARGET, src);
    log('');
    log('已写入 ' + changed + ' 处修复');
  }

  log('');
  log('提示：npm install 会还原 node_modules，重新打包前本脚本会自动再跑一次。');
  console.log('');
}

main();
