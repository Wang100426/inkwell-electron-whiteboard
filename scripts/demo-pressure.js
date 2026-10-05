'use strict';

/** 生成压感笔迹演示图：多条不同压力曲线的笔迹，用于视觉确认 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

ipcMain.handle('app:info', () => ({ version: '1.2.0', platform: process.platform, electron: process.versions.electron }));
ipcMain.on('app:health', () => {});

const OUT = path.join(__dirname, '..', 'pressure-demo.png');

app.whenReady().then(async () => {
  const ROOT = path.join(__dirname, '..');
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const dataUrl = await win.webContents.executeJavaScript('(() => {'
    + 'const { store, renderer } = window.__inkwell;'
    + 'const { pressureToWidth } = { pressureToWidth: null };'
    + 'const mk = (y, curve, color, base, max) => {'
    + '  const pts = [];'
    + '  for (let i = 0; i <= 400; i++) {'
    + '    const t = i / 400;'
    + '    const x = 80 + t * 1040;'
    + '    const yy = y + Math.sin(t * Math.PI * 2.2) * 26;'
    + '    const p = curve(t);'
    + '    pts.push({ x, y: yy, w: base + (max - base) * Math.pow(p, 1.6) });'
    + '  }'
    + '  return { id: "p" + y, type: "pen", color, fill: "transparent", fillEnabled: false,'
    + '    width: base, pressureMax: max, pressureSensitive: true, opacity: 1, points: pts };'
    + '};'
    + 'store.replaceAll(['
    + '  mk(110, (t) => Math.sin(Math.PI * t), "#7b5cff", 2, 26),'      // 轻→重→轻'
    + '  mk(240, (t) => t, "#4c8dff", 2, 26),'                          // 渐粗'
    + '  mk(370, (t) => 1 - t, "#38d39f", 2, 26),'                      // 渐细'
    + '  mk(500, (t) => 0.5 + 0.5 * Math.sin(t * Math.PI * 6), "#ffc93d", 2, 26),' // 波浪
    + '  mk(630, () => 0.08, "#ff5f6b", 1, 30),'                        // 极轻（几乎不断线）
    + ']);'
    + 'const c = renderer.exportPNG(store.shapes, { scale: 1, background: "#0f1115", padding: 30 });'
    + 'return c.toDataURL("image/png");'
    + '})()');

  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('压感演示图已保存:', OUT, fs.statSync(OUT).size, 'bytes');
  app.exit(0);
});
