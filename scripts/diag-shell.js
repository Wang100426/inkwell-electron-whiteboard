'use strict';

/**
 * 1.2.0 外观验收截图：无边框窗口 + 左侧栏 + 自绘窗口按钮。
 * 输出 .tmp/shell-*.png
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-shell.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 截图验收专用：不禁用硬件加速 —— disable-gpu 路径下 capturePage() 会返回 0x0
// （项目已知问题），验收截图必须走能真正离屏渲染的路径。
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp');

ipcMain.handle('app:info', () => ({ version: '1.2.0', platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', () => {});
ipcMain.on('app:dirty', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    useContentSize: true,
    backgroundColor: '#0f1115',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);

  const evalJs = (expr) => win.webContents.executeJavaScript(
    `(function(){ ${expr} })()`, true
  );

  // 画点内容，便于观察画布与侧栏的关系。
  // 注意两件事：
  //  1. makeBase(tool, style) 只产出基础字段，几何字段要自己补
  //  2. 不能直接 store.shapes.push() —— 那绕过了 store 的 notify()，
  //     空提示不会消失、paint 也不会被触发。要用 _swapShapes（会 notify）。
  await evalJs(`
    const k = window.__inkwell;
    const mk = (tool, style, geom) => Object.assign(k.makeBase(tool, style), geom);
    const list = [
      mk('pen', { color: '#4c8dff', width: 5 }, {
        points: [{x:200,y:180,w:5},{x:260,y:240,w:5},{x:340,y:160,w:5},{x:430,y:250,w:5},{x:520,y:190,w:5}],
        pressureSensitive: false,
      }),
      mk('rect', { color: '#38d39f', width: 3 }, { x: 560, y: 150, w: 200, h: 120 }),
      mk('ellipse', { color: '#7b5cff', width: 3 }, { x: 800, y: 150, w: 170, h: 120 }),
      mk('arrow', { color: '#ff8a3d', width: 3 }, { x1: 200, y1: 420, x2: 420, y2: 340 }),
      mk('note', { color: '#ffc93d', width: 3 }, { x: 560, y: 300, w: 240, h: 200, text: '左上角已换成\\n应用图标' }),
      mk('text', { color: '#e8ecf4', width: 3, fontSize: 26 }, { x: 200, y: 480, w: 340, h: 40, text: 'InkWell 1.2.0', fontSize: 26, align: 'left', fontFamily: 'Segoe UI' }),
    ];
    k.store._swapShapes(list);
    return k.store.shapes.length;
  `).then((n) => console.log('演示图形数:', n));
  await sleep(800);

  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'shell-full.png'), img.toPNG());
  console.log('全窗口 ->', path.join(OUT, 'shell-full.png'), JSON.stringify(img.getSize()));

  // 左上角：应用图标 + 撤销重做 + 缩放
  img = await win.webContents.capturePage({ x: 0, y: 0, width: 300, height: 240 });
  fs.writeFileSync(path.join(OUT, 'shell-topleft.png'), img.toPNG());
  console.log('左上角 ->', JSON.stringify(img.getSize()));

  // 右上角：三个窗口按钮
  img = await win.webContents.capturePage({ x: 1440 - 200, y: 0, width: 200, height: 60 });
  fs.writeFileSync(path.join(OUT, 'shell-topright.png'), img.toPNG());
  console.log('右上角 ->', JSON.stringify(img.getSize()));

  // 左侧栏整条
  img = await win.webContents.capturePage({ x: 0, y: 0, width: 90, height: 900 });
  fs.writeFileSync(path.join(OUT, 'shell-rail.png'), img.toPNG());
  console.log('左侧栏 ->', JSON.stringify(img.getSize()));

  // 几何数据，便于数值核对
  const geo = await evalJs(`
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return JSON.stringify({
      rail: r('.rail'),
      brandImg: r('.brand-mark img'),
      btnUndo: r('#btnUndo'),
      btnZoomIn: r('#btnZoomIn'),
      firstTool: r('.rail .tool'),
      btnGrid: r('#btnGrid'),
      btnSave: r('#btnSave'),
      btnWinClose: r('#btnWinClose'),
      panel: r('.panel'),
      stage: r('.stage'),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    });
  `);
  console.log('几何:', geo);

  // 溢出诊断：rail 内容是否超过可视高度（1.2.0 曾踩坑：文件操作图标跑到视口外）
  const overflow = await evalJs(`
    const el = document.querySelector('.rail');
    const acts = document.querySelector('.rail-actions');
    const last = document.getElementById('btnSave');
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      railRect: { top: Math.round(r.top), h: Math.round(r.height) },
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      overflowPx: el.scrollHeight - el.clientHeight,
      actionsTop: Math.round(acts.getBoundingClientRect().top),
      actionsBottom: Math.round(acts.getBoundingClientRect().bottom),
      saveBtnBottom: Math.round(last.getBoundingClientRect().bottom),
      viewportH: window.innerHeight,
      saveInView: last.getBoundingClientRect().bottom <= window.innerHeight,
    });
  `);
  console.log('溢出诊断:', overflow);

  app.exit(0);
});
