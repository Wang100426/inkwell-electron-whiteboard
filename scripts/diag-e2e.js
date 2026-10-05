'use strict';

/**
 * 端到端复现：真实 main.js + 真实点击 + trace 落盘验证。
 *
 * 目的：证明"点文字工具 → 点画布"这条链路在完整应用里是通的，
 * 并且 trace 日志能准确记录每一步。用户那边跑一次就能对比日志定位。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'trace-test.log');
fs.writeFileSync(LOG, '');

ipcMain.handle('app:info', () => ({ version: '1.0.0', platform: process.platform, electron: process.versions.electron }));
/* 1.2.0 无边框窗口：渲染层会查询最大化状态，测试环境补个 stub 避免报错 */
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', (_e, d) => fs.appendFileSync(LOG, 'HEALTH ' + JSON.stringify(d) + '\n'));
ipcMain.on('app:trace', (_e, m) => fs.appendFileSync(LOG, 'TRACE ' + m + '\n'));
ipcMain.on('app:dirty', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const run = (code) => win.webContents.executeJavaScript(
    '(function(){ try { ' + code + ' } catch (e) { return { __err: e.message }; } })()', true);

  const MK = `
    const mk = (t, x, y, extra) => new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(
      t, Object.assign({ bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse',
        isPrimary: true }, extra || {}));
  `;

  // 完全模拟用户操作：真实点击工具栏按钮 + 真实点击画布
  const res = await run(`
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    ${MK}
    const clickBtn = (name) => {
      const b = document.querySelector('.tool[data-tool="' + name + '"]');
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      b.dispatchEvent(mk('pointerdown', x, y, { buttons: 1 }));
      b.dispatchEvent(mk('mousedown', x, y, { buttons: 1 }));
      b.dispatchEvent(mk('pointerup', x, y, { buttons: 0 }));
      b.dispatchEvent(mk('mouseup', x, y, { buttons: 0 }));
      b.dispatchEvent(mk('click', x, y, { buttons: 0 }));
    };
    const clickCanvas = (x, y) => {
      c.dispatchEvent(mk('pointerdown', cr.left + x, cr.top + y, { buttons: 1 }));
      c.dispatchEvent(mk('pointerup', cr.left + x, cr.top + y, { buttons: 0 }));
    };

    /* 文字：点按钮 -> 点画布 */
    clickBtn('text');
    clickCanvas(400, 300);
    const edAfterText = !document.getElementById('textEditor').hidden;

    /* 输入内容并提交（模拟真实打字 + Esc 提交） */
    const ta = document.getElementById('textInput');
    ta.value = '测试文字';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(mk('pointerdown', cr.left + 900, cr.top + 600, { buttons: 1 }));
    c.dispatchEvent(mk('pointerup', cr.left + 900, cr.top + 600, { buttons: 0 }));

    /* 便签：点按钮 -> 点画布 */
    clickBtn('note');
    clickCanvas(700, 400);
    const edAfterNote = !document.getElementById('textEditor').hidden;
    const isNote = document.getElementById('textEditor').classList.contains('is-note');
    const ta2 = document.getElementById('textInput');
    ta2.value = '测试便签';
    c.dispatchEvent(mk('pointerdown', cr.left + 100, cr.top + 100, { buttons: 1 }));
    c.dispatchEvent(mk('pointerup', cr.left + 100, cr.top + 100, { buttons: 0 }));

    const shapes = window.__inkwell.store.shapes;
    return {
      edAfterText, edAfterNote, isNote,
      count: shapes.length,
      types: shapes.map(s => s.type).join(','),
      texts: shapes.map(s => s.text || '').join('|'),
    };
  `);

  console.log('\n=== 真实点击链路结果 ===');
  console.log(JSON.stringify(res, null, 2));

  console.log('\n=== trace 日志 ===');
  console.log(fs.readFileSync(LOG, 'utf8').trim() || '(空)');

  app.exit(0);
});
