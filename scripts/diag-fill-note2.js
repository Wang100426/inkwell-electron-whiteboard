'use strict';

/**
 * 复现：填充色 → 便签 → 回到填充，填充色变成便签黄。
 *
 * 严格按用户日志里的真实操作顺序走，并且**用 CDP 派发真实鼠标事件**：
 *   图形 → 矩形 → 拖一个矩形
 *   图形 → 填充 → 点色板选色 → 点矩形上色
 *   文本 → 便签 → 点画布（弹出编辑器）→ 输入文字
 *   → **在编辑器还开着的时候点左侧栏的「选择」**（真实点击会触发 focusout，
 *     从而走 commitEdit 这条提交路径，而不是 Ctrl+Enter）
 *   图形 → 填充 → 读 state.style.fill / 色板高亮 / 面板文字
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-fill-note2.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');

ipcMain.handle('app:info', () => ({ version: '1.3.3', platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', () => {});
ipcMain.on('app:dirty', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(() => { console.log('!! 超时退出'); app.exit(2); }, 45000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, useContentSize: true,
    backgroundColor: '#0f1115', frame: false,
    titleBarStyle: 'hidden', titleBarOverlay: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1200);

  const wc = win.webContents;
  wc.debugger.attach('1.3');

  const js = async (code) => {
    try {
      return await wc.executeJavaScript(`(function(){ ${code} })()`, true);
    } catch (err) {
      return { __err: String(err && err.message) };
    }
  };

  async function clickAt(x, y) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(25);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async function clickSel(sel) {
    const c = await js(`
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    `);
    if (!c || c.__err) { console.log('!! 找不到 ' + sel); return false; }
    await clickAt(c.x, c.y);
    await sleep(90);
    return true;
  }

  async function drag(x1, y1, x2, y2) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', clickCount: 0 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x1 + ((x2 - x1) * i) / 6,
        y: y1 + ((y2 - y1) * i) / 6,
        button: 'left', buttons: 1, clickCount: 0,
      });
      await sleep(16);
    }
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    await sleep(120);
  }

  const snapshot = (tag) => js(`
    const { state, store } = window.__inkwell;
    const sw = document.querySelector('.swatch.active');
    return {
      tag: ${JSON.stringify(tag)},
      tool: state.tool,
      styleFill: state.style.fill,
      styleColor: state.style.color,
      activeSwatch: sw ? sw.dataset.color : null,
      colorHex: document.getElementById('colorHex').textContent,
      picker: document.getElementById('colorPicker').value,
      shapes: store.shapes.map((s) => ({ type: s.type, fill: s.fill, fillEnabled: s.fillEnabled, color: s.color })),
    };
  `);

  // 画布几何（世界坐标 -> 屏幕坐标的换算靠 renderer.view）
  const canvasBox = await js(`
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  `);
  console.log('画布:', JSON.stringify(canvasBox));

  /* ---- 1. 矩形 ---- */
  await clickSel('.rail-tools .tool[data-group="shape"]');
  await clickSel('#variantItems .variant-btn[data-tool="rect"]');
  await drag(canvasBox.l + 120, canvasBox.t + 120, canvasBox.l + 360, canvasBox.t + 280);
  console.log('画完矩形:', JSON.stringify(await snapshot('rect-drawn')));

  /* ---- 2. 填充：选色 + 上色 ---- */
  await clickSel('#variantItems .variant-btn[data-tool="fill"]');
  await clickSel('.swatch[data-color="#38d39f"]');
  console.log('选了填充色:', JSON.stringify(await snapshot('swatch-picked')));

  await clickAt(canvasBox.l + 240, canvasBox.t + 200);   // 点矩形内部
  await sleep(120);
  console.log('填充之后:', JSON.stringify(await snapshot('filled')));

  /* ---- 3. 便签：编辑器开着时点左侧栏切换 ---- */
  await clickSel('.rail-tools .tool[data-group="text"]');
  await clickSel('#variantItems .variant-btn[data-tool="note"]');
  await clickAt(canvasBox.l + 620, canvasBox.t + 160);
  await sleep(250);

  const ed = await js(`
    const ed = document.getElementById('textEditor');
    return { open: !ed.hidden, active: document.activeElement && document.activeElement.id };
  `);
  console.log('便签编辑器:', JSON.stringify(ed));

  // 输入文字（真实输入）
  await wc.debugger.sendCommand('Input.insertText', { text: '便签' });
  await sleep(120);
  console.log('输入后:', JSON.stringify(await snapshot('typed')));

  // 关键一步：编辑器还开着，直接点左侧栏的「选择」
  await clickSel('.rail-tools .tool[data-group="select"]');
  await sleep(250);
  console.log('点「选择」之后:', JSON.stringify(await snapshot('after-rail-click')));

  /* ---- 4. 回到填充 ---- */
  await clickSel('.rail-tools .tool[data-group="shape"]');
  await clickSel('#variantItems .variant-btn[data-tool="fill"]');
  await sleep(150);
  const back = await snapshot('back-to-fill');
  console.log('回到填充:', JSON.stringify(back, null, 2));

  wc.debugger.detach();
  app.exit(0);
});
