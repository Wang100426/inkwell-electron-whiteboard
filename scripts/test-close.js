'use strict';

/**
 * 窗口关闭行为静态检查。
 *
 * 真实点击「叉」的行为在无显示环境不可测，这里校验关键代码结构。
 * 端到端行为由 scripts/test-edit-close.js 覆盖（用事件对象模拟 close）。
 *
 * 用法：node scripts/test-close.js
 */

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const HTML = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { console.log('  \u2713 ' + name); pass++; }
  else { console.log('  \u2717 ' + name + (detail ? '  → ' + detail : '')); fail++; }
}

console.log('\n窗口关闭行为检查\n');

const main = fs.readFileSync(MAIN, 'utf8');
const renderer = fs.readFileSync(RENDERER, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const preload = fs.readFileSync(PRELOAD, 'utf8');

/* ---------- 1. 禁用两种会静默卡死的方案 ---------- */
{
  check('未使用 beforeunload（会静默阻止关闭）',
    !/addEventListener\(\s*['"]beforeunload['"]/.test(renderer));
  // 只检测真实的调用，不误伤注释里的说明文字
  check('未使用 showMessageBoxSync（原生模态框可能挂起）',
    !/dialog\.showMessageBoxSync\s*\(/.test(main));
  // 单实例提示用的是异步 showMessageBox，不会阻塞，属正常用法
  check('单实例提示使用异步弹窗（不阻塞）',
    !/dialog\.showMessageBoxSync/.test(main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
}

/* ---------- 2. 主进程 close 处理 ---------- */
{
  const hasClose = /mainWindow\.on\(\s*'close'/.test(main);
  const hasPrevent = /e\.preventDefault\(\)/.test(main);
  const sendsConfirm = /send\(\s*'app:confirm-close'\s*\)/.test(main);
  const syncFlag = /if \(!hasUnsavedChanges\)/.test(main);
  check('主进程监听 close 事件', hasClose);
  check('有未保存内容时阻止关闭', hasPrevent);
  check('通知渲染进程弹确认框', sendsConfirm);
  check('同步读取缓存的脏标记', syncFlag);
}

/* ---------- 3. 脏标记同步可读（不能异步反查） ---------- */
{
  const hasFlag = /let hasUnsavedChanges = false/.test(main);
  const hasIpc = /ipcMain\.on\('app:dirty'/.test(main);
  const closeStart = main.indexOf("mainWindow.on('close'");
  const closeEnd = main.indexOf('mainWindow.on(', closeStart + 10);
  const closeBody = main.slice(closeStart, closeEnd > 0 ? closeEnd : undefined);
  check('主进程缓存 hasUnsavedChanges', hasFlag);
  check('渲染进程通过 app:dirty 上报', hasIpc);
  check('close 处理器内无异步反查（否则卡死）', !/executeJavaScript/.test(closeBody));
}

/* ---------- 4. 关闭放行机制 ---------- */
{
  const declared = /let allowClose = false/.test(main);
  const checked = /if \(allowClose\) return/.test(main);
  const forceClose = /function forceClose\(\)/.test(main);
  const deferred = /setImmediate\(/.test(main);
  check('存在 allowClose 放行标志', declared);
  check('close 时检查放行标志', checked);
  check('封装 forceClose 统一关闭入口', forceClose);
  check('关闭延后一拍（避开同步重入）', deferred);
}

/* ---------- 5. 三种选择都有处理 ---------- */
{
  const hasChoice = /ipcMain\.on\('app:close-choice'/.test(main);
  const cancel = /choice === 'cancel'[\s\S]{0,60}return/.test(main);
  const save = /choice === 'save'[\s\S]{0,200}save-and-close/.test(main);
  const discard = /forceClose\(\);\s*\/\/\s*discard/.test(main);
  check('主进程监听关闭选择', hasChoice);
  check('「取消」保持窗口', cancel);
  check('「保存」触发存盘后关', save);
  check('「不保存」直接关', discard);
}

/* ---------- 6. 渲染进程的 HTML 确认框 ---------- */
{
  const hasMask = /id="closeMask"/.test(html);
  const hasSave = /id="closeSave"/.test(html);
  const hasDiscard = /id="closeDiscard"/.test(html);
  const hasCancel = /id="closeCancel"/.test(html);
  check('页面内含确认框结构', hasMask);
  check('含「保存」按钮', hasSave);
  check('含「不保存」按钮', hasDiscard);
  check('含「取消」按钮', hasCancel);

  const showFn = /function showCloseConfirm\(\)/.test(renderer);
  const chooseFn = /function chooseClose\(/.test(renderer);
  const listens = /onConfirmClose\(showCloseConfirm\)/.test(renderer);
  const replies = /closeChoice\(choice\)/.test(renderer);
  check('渲染进程实现 showCloseConfirm', showFn);
  check('渲染进程实现 chooseClose', chooseFn);
  check('监听主进程的确认请求', listens);
  check('选择结果回传主进程', replies);
}

/* ---------- 7. preload 桥接 ---------- */
{
  check('preload 暴露 setDirty', /setDirty/.test(preload));
  check('preload 暴露 onConfirmClose', /onConfirmClose/.test(preload));
  check('preload 暴露 closeChoice', /closeChoice/.test(preload));
  check('preload 暴露 onSaveAndClose', /onSaveAndClose/.test(preload));
  check('preload 暴露 saveDone', /saveDone/.test(preload));
}

/* ---------- 8. 编辑相关：不得再有会误关编辑器的全局监听 ---------- */
{
  const badFocusIn = /document\.addEventListener\(\s*'focusin'/.test(renderer);
  const badWatch = /startEditWatch|setInterval\(/.test(renderer);
  check('未使用全局 focusin 监听（会误关编辑器）', !badFocusIn);
  check('未使用编辑期轮询（会误关编辑器）', !badWatch);
  check('保留 focusout 提交', /addEventListener\('focusout'/.test(renderer));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('提示：真实点击「叉」的行为由 test-edit-close.js 覆盖。\n');
process.exit(fail ? 1 : 0);
