'use strict';

/** 最小化诊断：真实事件序列 + 错误详情回报 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.handle('file:open', () => ({ ok: false }));
ipcMain.handle('file:exportImage', () => ({ ok: false }));
ipcMain.handle('app:info', () => ({ version: '1.0.0', platform: process.platform, electron: process.versions.electron }));
/* 1.2.0 无边框窗口：渲染层会查询最大化状态，测试环境补个 stub 避免报错 */
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  const errs = [];
  win.webContents.on('console-message', (...args) => {
    const a = args[0];
    if (a && typeof a === 'object' && 'message' in a) {
      if ((a.level ?? 0) >= 2) errs.push(a.message + ' @' + (a.sourceId || '?') + ':' + (a.lineNumber || '?'));
    } else if (args[1] >= 2) {
      errs.push(args[2] + ' @' + args[4] + ':' + args[3]);
    }
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  /* 安全执行：包 try/catch，返回错误详情 */
  const run = async (code) => {
    try {
      return await win.webContents.executeJavaScript(
        '(function(){ try { ' + code + ' } catch (e) { return { __err: e.message, __stack: String(e.stack).split("\\n").slice(0,3) }; } })()',
        true
      );
    } catch (e) {
      return { __execErr: e.message };
    }
  };

  console.log('\n=== hasApi / canvas 几何 ===');
  console.log(JSON.stringify(await run(`
    const api = window.__inkwell;
    if (!api) return { __noApi: true };
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    return {
      apiKeys: Object.keys(api).length,
      canvasRect: Math.round(cr.width) + 'x' + Math.round(cr.height) + ' @' + Math.round(cr.left) + ',' + Math.round(cr.top),
      bitmap: c.width + 'x' + c.height,
      dpr: window.devicePixelRatio,
      tool: api.state.tool,
    };
  `), null, 2));

  const MK = `
    const mk = (t, x, y, extra) => new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(
      t, Object.assign({ bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse',
        isPrimary: true }, extra || {}));
  `;

  console.log('\n=== 点文字工具 -> 点画布（完整鼠标序列） ===');
  console.log(JSON.stringify(await run(`
    const { setTool, state, store } = window.__inkwell;
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    ${MK}
    const btn = document.querySelector('.tool[data-tool="text"]');
    const br = btn.getBoundingClientRect();
    const bx = br.left + br.width / 2, by = br.top + br.height / 2;
    btn.dispatchEvent(mk('pointerdown', bx, by, { buttons: 1 }));
    btn.dispatchEvent(mk('mousedown', bx, by, { buttons: 1 }));
    btn.dispatchEvent(mk('pointerup', bx, by, { buttons: 0 }));
    btn.dispatchEvent(mk('mouseup', bx, by, { buttons: 0 }));
    btn.dispatchEvent(mk('click', bx, by, { buttons: 0 }));
    const toolAfter = state.tool;

    const mx = cr.left + 400, my = cr.top + 300;
    c.dispatchEvent(mk('pointerdown', mx, my, { buttons: 1 }));
    const ed = document.getElementById('textEditor');
    const openedOnDown = !ed.hidden;
    document.body.focus();
    c.dispatchEvent(mk('pointerup', mx, my, { buttons: 0 }));
    c.dispatchEvent(mk('mouseup', mx, my, { buttons: 0 }));
    c.dispatchEvent(mk('click', mx, my, { buttons: 0 }));

    const er = ed.getBoundingClientRect();
    return {
      toolAfterToolClick: toolAfter,
      openedOnDown,
      hiddenNow: ed.hidden,
      display: getComputedStyle(ed).display,
      rect: Math.round(er.width) + 'x' + Math.round(er.height),
      pos: Math.round(er.left) + ',' + Math.round(er.top),
      activeEl: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      shapes: store.shapes.length,
    };
  `), null, 2));

  console.log('\n=== 便签：点工具 -> 点画布 ===');
  console.log(JSON.stringify(await run(`
    const { setTool, state, store } = window.__inkwell;
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    ${MK}
    store.replaceAll([]);
    setTool('note');
    const mx = cr.left + 600, my = cr.top + 400;
    c.dispatchEvent(mk('pointerdown', mx, my, { buttons: 1 }));
    c.dispatchEvent(mk('pointerup', mx, my, { buttons: 0 }));
    const ed = document.getElementById('textEditor');
    const er = ed.getBoundingClientRect();
    return {
      tool: state.tool,
      hidden: ed.hidden,
      display: getComputedStyle(ed).display,
      isNote: ed.classList.contains('is-note'),
      rect: Math.round(er.width) + 'x' + Math.round(er.height),
      zIndex: getComputedStyle(ed).zIndex,
      opacity: getComputedStyle(ed).opacity,
      visibility: getComputedStyle(ed).visibility,
    };
  `), null, 2));

  if (errs.length) {
    console.log('\n=== 渲染进程报错 ===');
    [...new Set(errs)].slice(0, 15).forEach((e) => console.log('  X ' + e));
  } else {
    console.log('\n（无渲染进程报错）');
  }

  app.exit(0);
});
