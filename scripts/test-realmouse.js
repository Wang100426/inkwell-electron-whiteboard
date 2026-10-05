'use strict';

/**
 * 回归测试：真实鼠标焦点转移（编辑器打开即被关闭的坑）。
 *
 * 为什么必须有这个测试：
 *   之前所有测试都用 dispatchEvent 合成事件，而**合成事件不执行默认行为**，
 *   所以「pointerdown 处理器返回后，浏览器执行 mousedown 默认聚焦、
 *   把 textarea 的焦点抢走 → focusout → commitEdit → 编辑器闪一下消失」
 *   这个问题从来没被测出来过，连续两轮误判为"已修复"。
 *
 *   本脚本用 CDP 的 Input.dispatchMouseEvent 派发**真实输入事件**，
 *   它会走浏览器完整的默认行为链路，能真实复现该场景。
 *
 * 覆盖：
 *   1. 真实鼠标点画布 → 编辑器应保持打开、焦点在输入框
 *   2. 输入文字 → 点别处 → 应正确提交成文字图形
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test-realmouse.js
 *      （或 npm run test:realmouse）
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
ipcMain.handle('app:info', () => ({ version: '1.0.0', platform: process.platform, electron: process.versions.electron }));
/* 1.2.0 无边框窗口：渲染层会查询最大化状态，测试环境补个 stub 避免报错 */
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', () => {});
ipcMain.on('app:dirty', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1126, height: 792, show: true, useContentSize: true, backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);

  // 用 webContents.debugger 附加 CDP —— 能派发真实输入事件
  win.webContents.debugger.attach('1.3');
  const send = (method, params) => win.webContents.debugger.sendCommand(method, params || {});
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){ try { ${expr} } catch(e) { return {__err:e.message}; } })()`,
      returnByValue: true,
    });
    return r.result && r.result.value;
  };

  const geo = await evalJs(`
    window.__inkwell.setTool('text');
    const r = document.getElementById('canvas').getBoundingClientRect();
    return { left: r.left, top: r.top };
  `);

  /** 派发一对真实鼠标按下/抬起（走浏览器默认行为，含 mousedown 默认聚焦） */
  const realClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };

  console.log('\n【真实鼠标 · 文字工具】');

  /* ---------- 1. 真实点击画布 → 编辑器必须保持打开 ---------- */
  await realClick(geo.left + 300, geo.top + 250);
  await sleep(500);   // 等所有默认行为 + 焦点抖动都跑完

  const after = await evalJs(`
    const ed = document.getElementById('textEditor');
    const er = ed.getBoundingClientRect();
    return {
      hidden: ed.hidden,
      display: getComputedStyle(ed).display,
      opacity: getComputedStyle(ed).opacity,
      w: Math.round(er.width), h: Math.round(er.height),
      active: document.activeElement && document.activeElement.id,
      status: document.getElementById('statusTool').textContent,
    };
  `);

  check('真实点击后编辑器未被关闭', after.hidden === false, after);
  check('编辑器可见（display/opacity）', after.display === 'block' && after.opacity === '1', after);
  check('编辑器尺寸正常（未被坍缩成 0）', after.w > 100 && after.h > 40, after);
  check('焦点仍在输入框（未被 mousedown 默认聚焦抢走）', after.active === 'textInput', after);
  check('状态栏提示"正在输入文字…"', after.status === '正在输入文字…', after);

  /* ---------- 2. 输入文字 → 点别处提交 ---------- */
  await send('Input.insertText', { text: '真实鼠标测试' });
  await sleep(120);
  await realClick(geo.left + 650, geo.top + 520);
  await sleep(400);

  const shapes = await evalJs('return window.__inkwell.store.shapes.map(s => ({ type: s.type, text: s.text }));');
  check(
    '文字正常提交成图形',
    Array.isArray(shapes) && shapes.some((s) => s.type === 'text' && s.text === '真实鼠标测试'),
    shapes
  );

  /* ---------- 3. 便签同样验证一遍 ---------- */
  console.log('\n【真实鼠标 · 便签工具】');
  await evalJs('window.__inkwell.setTool("note")');
  await sleep(100);
  await realClick(geo.left + 200, geo.top + 400);
  await sleep(500);

  const noteState = await evalJs(`
    const ed = document.getElementById('textEditor');
    const er = ed.getBoundingClientRect();
    return {
      hidden: ed.hidden,
      isNote: ed.classList.contains('is-note'),
      w: Math.round(er.width), h: Math.round(er.height),
      active: document.activeElement && document.activeElement.id,
    };
  `);
  check('便签编辑器保持打开', noteState.hidden === false, noteState);
  check('便签编辑器尺寸正常', noteState.w > 100 && noteState.h > 80, noteState);
  check('便签编辑器带 is-note 样式', noteState.isNote === true, noteState);
  check('便签焦点在输入框', noteState.active === 'textInput', noteState);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { win.webContents.debugger.detach(); } catch (_) {}
  app.exit(fail === 0 ? 0 : 1);
});
