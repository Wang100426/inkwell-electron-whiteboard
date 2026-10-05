'use strict';

/**
 * 复刻用户环境截图：1126x792 + 全 GPU 禁用（与 src/main.js 完全一致）。
 * 目的：看到用户眼里的画面到底长什么样。
 *
 * 注意：本环境下 capturePage() 在软件渲染路径下可能返回空图，
 * 所以要同时用 window 尺寸 + toBitmap 长度做健康检查，
 * 空图时改用 nativeImage 从 dataURL 兜底。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-userview.js
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
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
ipcMain.on('app:trace', (e, m) => console.log('[trace] ' + m));
ipcMain.on('app:dirty', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  console.log('主屏 workAreaSize:', JSON.stringify(d.workAreaSize), 'scaleFactor:', d.scaleFactor);

  const win = new BrowserWindow({
    width: 1126, height: 792,
    show: true,
    useContentSize: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(2500);

  const run = (c) => win.webContents.executeJavaScript(
    '(function(){ try { ' + c + ' } catch(e) { return {__err: e.message, stack: e.stack}; } })()', true);

  // 打开文字编辑器
  await run(`
    const { setTool } = window.__inkwell;
    const c = document.getElementById('canvas');
    const cr = c.getBoundingClientRect();
    setTool('text');
    const mk = (t, x, y) => new PointerEvent(t, { bubbles:true, cancelable:true, composed:true,
      clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:1,
      pointerType:'mouse', isPrimary:true });
    c.dispatchEvent(mk('pointerdown', 450, 300));
    c.dispatchEvent(mk('pointerup', 450, 300));
  `);

  // 等动画彻底跑完（0.16s）+ 余量
  await sleep(1200);

  const state = await run(`
    const ed = document.getElementById('textEditor');
    const ta = document.getElementById('textInput');
    const ecs = getComputedStyle(ed);
    const tcs = getComputedStyle(ta);
    const er = ed.getBoundingClientRect();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    return {
      editorRect: [er.left, er.top, er.width, er.height].map(Math.round),
      stageRect: [stage.left, stage.top, stage.width, stage.height].map(Math.round),
      edHidden: ed.hidden, edDisplay: ecs.display, edOpacity: ecs.opacity,
      edVisibility: ecs.visibility, edTransform: ecs.transform,
      edAnim: ecs.animationName, edFillMode: ecs.animationFillMode,
      taDisplay: tcs.display, taOpacity: tcs.opacity,
      taBg: tcs.backgroundColor, taBorderW: tcs.borderTopWidth, taBorderC: tcs.borderTopColor,
      taColor: tcs.color, taFontSize: tcs.fontSize,
      active: document.activeElement && document.activeElement.id,
      placeholder: ta.placeholder,
    };
  `);
  console.log('\n=== 编辑器最终状态（动画结束后） ===');
  console.log(JSON.stringify(state, null, 2));
  console.log('截图: diag-userview.png');

  // 健康检查：反复截几张，取 bitmap 非空的
  let saved = false;
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    const buf = img.toBitmap();
    console.log(`第${attempt + 1}次截图: ${size.width}x${size.height}, bitmap ${buf.length} 字节`);
    if (size.width > 0 && buf.length > 0) {
      fs.writeFileSync(path.join(ROOT, 'diag-userview.png'), img.toPNG());
      saved = true;
    }
    await sleep(400);
  }
  if (!saved) console.log('!! capturePage 三次都返回空图，截图不可信');

  // 兜底：用 DOM 层坐标做"可见性断言"
  const verdict = await run(`
    const ed = document.getElementById('textEditor');
    const ta = document.getElementById('textInput');
    const er = ed.getBoundingClientRect();
    const cx = er.left + er.width/2, cy = er.top + er.height/2;
    const top = document.elementFromPoint(cx, cy);
    /* 沿中心点向外采样，看有没有别的元素盖住 */
    const samples = [];
    for (let dy = -er.height/2; dy <= er.height/2; dy += er.height/4) {
      for (let dx = -er.width/2; dx <= er.width/2; dx += er.width/4) {
        const el = document.elementFromPoint(cx+dx, cy+dy);
        samples.push(el ? (el.id || el.tagName) : 'null');
      }
    }
    return { centerTop: top ? (top.id||top.tagName):'null', isTa: top===ta, samples };
  `);
  console.log('\n=== 遮挡检测 ===');
  console.log(JSON.stringify(verdict, null, 2));

  app.exit(0);
});
