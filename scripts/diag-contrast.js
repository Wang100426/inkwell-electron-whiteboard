'use strict';

/**
 * 量化诊断：编辑器在画布上的视觉对比度到底是多少？
 *
 * 背景调查：用户报"完全看不到框"，但日志证明 openEditor 成功执行
 * （display=block / hidden=false / active=textInput）。怀疑是深色主题下
 * 编辑器与画布对比度太低，导致"逻辑可见、视觉不可见"。
 *
 * 做法：真实显示窗口 → 打开编辑器 → 截图 → 逐像素比较
 * 「编辑器区域」与「同尺寸的画布背景区域」的平均亮度差，
 * 算出对比度比值（WCAG 相对亮度公式）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-contrast.js
 */

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// 完全复刻 main.js 的 GPU 降级策略，保证和用户环境一致
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
ipcMain.handle('app:info', () => ({ version: '1.0.0', platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', (e, m) => console.log('[trace] ' + m));
ipcMain.on('app:dirty', () => {});

/** WCAG 相对亮度 */
function lum(r, g, b) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(l1, l2) {
  const a = Math.max(l1, l2), b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

/** 取图片某矩形区域的平均颜色 */
function avgColor(img, x, y, w, h) {
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(size.width, (x + w) | 0), y1 = Math.min(size.height, (y + h) | 0);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * size.width + xx) * 4;
      b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2]; n++;
    }
  }
  if (!n) return { r: 0, g: 0, b: 0, n: 0 };
  return { r: r / n, g: g / n, b: b / n, n };
}

/** 剪掉 4px 边缘，避开编辑器自己的 2px 边框 + 外发光 */
function innerRect(rect, pad) {
  return { x: rect[0] + pad, y: rect[1] + pad, w: rect[2] - pad * 2, h: rect[3] - pad * 2 };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1126, height: 792,       // 复刻用户日志里的 CSS 尺寸
    show: true,
    useContentSize: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const run = (c) => win.webContents.executeJavaScript(
    '(function(){ try { ' + c + ' } catch(e) { return {__err: e.message}; } })()', true);

  const dpr = await run('return window.devicePixelRatio');
  console.log('devicePixelRatio =', dpr);

  const info = await run(`
    const { setTool } = window.__inkwell;
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
    const tcs = getComputedStyle(ta);
    const ecs = getComputedStyle(ed);
    return {
      editorRect: [er.left, er.top, er.width, er.height].map(Math.round),
      taBg: tcs.backgroundColor,
      taColor: tcs.color,
      taBorder: tcs.borderTopWidth + ' ' + tcs.borderTopColor,
      taShadow: tcs.boxShadow,
      taFontSize: tcs.fontSize,
      edOpacity: ecs.opacity,
      edAnim: ecs.animationName,
      edTransform: ecs.transform,
      edZ: ecs.zIndex,
      active: document.activeElement && document.activeElement.id,
    };
  `);
  console.log('\n=== 编辑器计算样式 ===');
  console.log(JSON.stringify(info, null, 2));

  // 等动画彻底结束（如果有）
  await new Promise((r) => setTimeout(r, 900));

  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(path.join(ROOT, 'diag-contrast-shot.png'), png);
  console.log('\n截图: diag-contrast-shot.png');

  const size = img.getSize();
  console.log('截图尺寸(设备像素):', size.width + 'x' + size.height);

  const s = dpr || 1;
  const R = info.editorRect;
  const box = [Math.round(R[0] * s), Math.round(R[1] * s), Math.round(R[2] * s), Math.round(R[3] * s)];
  console.log('编辑器设备像素矩形:', box.join(','));

  // 编辑器内部（避开边框）
  const inner = innerRect(box, Math.round(6 * s));
  const edAvg = avgColor(img, inner.x, inner.y, inner.w, inner.h);

  // 同尺寸的"纯画布背景"参照区：编辑器正下方 120px（那里没有图形）
  const refY = Math.min(size.height - inner.h - 4, box[1] + box[3] + Math.round(90 * s));
  const bgAvg = avgColor(img, inner.x, refY, inner.w, inner.h);

  const lEd = lum(edAvg.r, edAvg.g, edAvg.b);
  const lBg = lum(bgAvg.r, bgAvg.g, bgAvg.b);

  console.log('\n=== 像素对比 ===');
  console.log('编辑器区平均 RGB:', [edAvg.r, edAvg.g, edAvg.b].map((v) => v.toFixed(1)).join(','));
  console.log('画布背景平均 RGB:', [bgAvg.r, bgAvg.g, bgAvg.b].map((v) => v.toFixed(1)).join(','));
  console.log('编辑器相对亮度:', lEd.toFixed(4));
  console.log('背景相对亮度  :', lBg.toFixed(4));
  console.log('对比度比 (WCAG):', contrast(lEd, lBg).toFixed(3));
  console.log('\n判据: < 1.2 基本看不出边界; 1.2~1.6 很弱; > 2 清晰');

  // 再测：编辑器中心那一行像素里，最亮的是不是边框
  const cx = box[0], cy = box[1];
  console.log('\n=== 编辑器左上角附近横向像素扫描 (y=' + (cy + 4) + ') ===');
  const row = [];
  for (let dx = 0; dx < Math.min(box[2], 40); dx++) {
    const i = ((cy + 4) * size.width + (cx + dx)) * 4;
    const bmp = img.toBitmap();
    row.push(`x+${dx}:${bmp[i + 2]},${bmp[i + 1]},${bmp[i]}`);
  }
  console.log(row.join('  '));

  app.exit(0);
});
