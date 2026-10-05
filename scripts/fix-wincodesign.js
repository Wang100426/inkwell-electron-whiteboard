'use strict';

/**
 * 修复 electron-builder 的 winCodeSign 解压失败。
 *
 * 问题：winCodeSign 压缩包里包含 macOS 用的 .dylib 符号链接，
 *      Windows 未开启开发者模式时无法创建符号链接，7z 报"客户端没有所需的特权"，
 *      electron-builder 判定为致命错误并放弃。
 *      而它每次解压都用随机目录名，失败后无有效缓存，导致无限重试。
 *
 * 方案：手动解压并跳过 darwin 目录（打包 Windows 用不到 macOS 的 dylib），
 *      放入 electron-builder 认得的固定缓存位置。
 *
 * 用法：node scripts/fix-wincodesign.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_ROOT = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
const PKG = 'winCodeSign-2.6.0';
const DEST = path.join(CACHE_ROOT, PKG);
const SEVEN_ZIP = path.join(
  __dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'
);

function log(m) { console.log('  ' + m); }

function findArchive() {
  if (!fs.existsSync(CACHE_ROOT)) return null;
  const archives = fs
    .readdirSync(CACHE_ROOT)
    .filter((f) => f.endsWith('.7z'))
    .map((f) => {
      const full = path.join(CACHE_ROOT, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    });
  if (!archives.length) return null;
  // 取最新修改的一份（不能用字典序，缓存名是随机数字）
  archives.sort((a, b) => b.mtime - a.mtime);
  return archives[0].full;
}

function isValid(dir) {
  // 打包 Windows 真正需要的文件
  const needed = [
    'rcedit-x64.exe',
    path.join('windows-10', 'x64', 'signtool.exe'),
    path.join('windows-10', 'x64', 'makecert.exe'),
  ];
  return needed.every((f) => fs.existsSync(path.join(dir, f)));
}

function cleanBrokenCaches() {
  if (!fs.existsSync(CACHE_ROOT)) return;
  const dirs = fs.readdirSync(CACHE_ROOT).filter((f) => /^\d+$/.test(f));
  let removed = 0;
  dirs.forEach((d) => {
    const full = path.join(CACHE_ROOT, d);
    if (!isValid(full)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch (_) { /* 占用中则跳过 */ }
    }
  });
  if (removed) log(`清理了 ${removed} 个损坏的缓存目录`);
}

console.log('修复 winCodeSign 缓存\n');

// 1. 如果固定位置已经有效，跳过
if (isValid(DEST)) {
  console.log('✓ winCodeSign 缓存已就绪，无需修复');
  console.log('  位置:', DEST);
  process.exit(0);
}

// 2. 找压缩包
const archive = findArchive();
if (!archive) {
  console.error('✗ 找不到 winCodeSign 压缩包');
  console.error('  位置:', CACHE_ROOT);
  console.error('  首次打包时 electron-builder 会自动下载，请先运行一次 npm run dist');
  process.exit(1);
}
log('源包:', path.basename(archive));

// 3. 清理历史损坏缓存
cleanBrokenCaches();

// 4. 手动解压，跳过 darwin（macOS 专用，含无法创建的符号链接）
//    7za.exe 偶尔因被杀软/其他进程占用而 EBUSY，重试几次
let result = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  log(`解压中（跳过 darwin 目录）... 第 ${attempt} 次尝试`);
  result = spawnSync(
    SEVEN_ZIP,
    ['x', archive, '-o' + DEST, '-x!darwin/*', '-snld', '-bd', '-y'],
    { encoding: 'utf8' }
  );
  if (!result.error) break;
  log('失败: ' + result.error.message);
  if (attempt < 3) {
    // 同步等待 2 秒，避免占用未释放
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']);
  }
}

if (result.error) {
  console.error('✗ 7z 连续三次执行失败:', result.error.message);
  console.error('  请关闭可能占用该文件的程序（IDE/杀软）后重试');
  process.exit(1);
}

// 5. 校验
if (isValid(DEST)) {
  console.log('\n✓ 修复成功');
  log('位置:', DEST);
  log('已跳过 darwin 目录（macOS 专用，打包 Windows 不需要）');
  console.log('\n现在可以运行 npm run dist');
  process.exit(0);
}

console.error('\n✗ 解压后仍缺少必要文件');
console.error('  7z 输出:', (result.stdout || '').slice(-500));
console.error('  检查:', DEST);
process.exit(1);
