'use strict';
/* 1.4.0 界面截图：底栏 + 左侧栏 + 面板 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
app.commandLine.appendSwitch('no-sandbox');
const ROOT = path.join(__dirname, '..');
ipcMain.handle('app:info', () => ({ version: '1.4.0' }));
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
  const OUT = path.join(ROOT, '.tmp');
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, useContentSize: true,
    backgroundColor: '#0f1115', frame: false, titleBarStyle: 'hidden', titleBarOverlay: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);
  const js = (c) => win.webContents.executeJavaScript(`(function(){ ${c} })()`, true);
  // 摆点内容让画面不那么空
  await js(`
    const k = window.__inkwell;
    const mk = (tool, style, geom) => Object.assign(k.makeBase(tool, style), geom);
    k.store._swapShapes([
      mk('pen', { color: '#4c8dff', width: 5 }, { points: [{x:180,y:160,w:5},{x:260,y:220,w:5},{x:360,y:150,w:5},{x:470,y:230,w:5}], pressureSensitive: false }),
      mk('rect', { color: '#38d39f', width: 3 }, { x: 560, y: 140, w: 220, h: 140 }),
      mk('ellipse', { color: '#7b5cff', width: 3 }, { x: 850, y: 150, w: 190, h: 130 }),
      mk('arrow', { color: '#ff8a3d', width: 3 }, { x1: 200, y1: 380, x2: 430, y2: 300 }),
      mk('note', { color: '#ffc93d', width: 3 }, { x: 620, y: 330, w: 220, h: 160, text: '1.4.0 底栏' }),
    ]);
    k.setTool('rect');
    return k.store.shapes.length;
  `);
  await sleep(700);
  // capturePage 在本机偶尔返回 0x0（GPU 合成抖动），重试几次
  let img = null;
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    img = await win.webContents.capturePage();
    const sz = img.getSize();
    if (sz.width > 0 && sz.height > 0) { console.log('第 ' + (i+1) + ' 次成功'); break; }
  }
  const sz = img.getSize();
  if (sz.width > 0) {
    fs.writeFileSync(path.join(OUT, 'dock-ui.png'), img.toPNG());
    console.log('截图:', JSON.stringify(sz), '->', path.join(OUT, 'dock-ui.png'));
  } else {
    console.log('!! capturePage 始终 0x0，本机合成问题，放弃截图');
  }
  app.exit(0);
});
