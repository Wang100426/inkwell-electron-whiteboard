'use strict';

/** 用可显示窗口截图，确认编辑器在视觉上是否真的可见 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900,
    show: true,                 // 真实显示，保证会绘制
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2000));

  const run = (c) => win.webContents.executeJavaScript(
    '(function(){ try { ' + c + ' } catch(e) { return {__err: e.message}; } })()', true);

  // 画一个矩形做背景参照
  await run(`
    const { store, renderer, requestRender } = window.__inkwell;
    store.addShape({ id:'bg1', type:'rect', color:'#4c8dff', fill:'transparent', fillEnabled:false,
      width:3, opacity:1, x:200, y:150, w:500, h:300 });
    requestRender();
  `);

  // 打开文字编辑器
  const openInfo = await run(`
    const { setTool, state } = window.__inkwell;
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    setTool('text');
    const mk = (t, x, y) => new PointerEvent(t, { bubbles:true, cancelable:true, composed:true,
      clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:1,
      pointerType:'mouse', isPrimary:true });
    c.dispatchEvent(mk('pointerdown', 450, 300));
    c.dispatchEvent(mk('pointerup', 450, 300));

    const ed = document.getElementById('textEditor');
    const ta = document.getElementById('textInput');
    const er = ed.getBoundingClientRect();
    const tr = ta.getBoundingClientRect();
    const ecs = getComputedStyle(ed);
    const tcs = getComputedStyle(ta);

    /* 检查编辑器中心点上，最顶层元素是不是 textarea */
    const topEl = document.elementFromPoint(er.left + er.width/2, er.top + er.height/2);

    return {
      editor: { rect: [er.left, er.top, er.width, er.height].map(Math.round), display: ecs.display,
                opacity: ecs.opacity, visibility: ecs.visibility, zIndex: ecs.zIndex },
      textarea: { rect: [tr.left, tr.top, tr.width, tr.height].map(Math.round), display: tcs.display,
                  opacity: tcs.opacity, visibility: tcs.visibility,
                  background: tcs.backgroundColor, color: tcs.color, border: tcs.borderColor },
      elementFromPoint: topEl ? (topEl.id || topEl.tagName) : 'null',
      isOurTextarea: topEl === ta,
      activeEl: document.activeElement && document.activeElement.id,
    };
  `);

  console.log('\n=== 编辑器实际渲染状态 ===');
  console.log(JSON.stringify(openInfo, null, 2));

  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'diag-editor-visible.png'), img.toPNG());
  console.log('\n截图: diag-editor-visible.png');

  app.exit(0);
});
