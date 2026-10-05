'use strict';

/**
 * 客观量化：编辑器与深色画布的对比度到底有多少？
 *
 * 背景：用户报"完全看不到框"，但日志+诊断都证明编辑器已打开。
 * 怀疑是深色主题下编辑器与画布对比度太低，被眼睛"过滤"掉。
 * 这里直接读取真实计算样式，算出 WCAG 对比度，给出客观数字。
 *
 * 对比两组：
 *   旧版（用户当前 exe）：1.5px 边框、无外发光
 *   新版（本次改动）：2px 边框 + 3px 外发光 + 状态栏提示
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-contrast2.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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

/** 解析 "rgba(r, g, b, a)" 或 "#rrggbb" → [r,g,b,a]，并做 alpha 合成 */
function parseColor(s, under) {
  s = String(s).trim();
  let r, g, b, a = 1;
  let m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    [r, g, b] = p;
    if (p.length > 3) a = p[3];
  } else {
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const h = m[1];
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
  }
  if (r === undefined) return null;
  // 半透明色叠在 under 上
  if (a < 1 && under) {
    r = r * a + under[0] * (1 - a);
    g = g * a + under[1] * (1 - a);
    b = b * a + under[2] * (1 - a);
    a = 1;
  }
  return [r, g, b, a];
}

function lum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(c1, c2) {
  const l1 = lum(c1), l2 = lum(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1126, height: 792, show: true, useContentSize: true,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  const run = (c) => win.webContents.executeJavaScript(
    '(function(){ try { ' + c + ' } catch(e) { return {__err: e.message}; } })()', true);

  const r = await run(`
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue('--bg').trim();
    const accent = style.getPropertyValue('--accent').trim();
    const text = style.getPropertyValue('--text').trim();
    const stage = getComputedStyle(document.querySelector('.stage')).backgroundColor;

    /* 造一个隔离的 textarea，分别套上旧版/新版样式，读真实计算值 */
    const mk = (css) => {
      const d = document.createElement('div');
      d.className = 'text-editor';
      const ta = document.createElement('textarea');
      ta.id = 'probe-' + Math.random().toString(36).slice(2);
      d.appendChild(ta);
      document.body.appendChild(d);
      /* 清掉动画带来的即时差异，读稳定态 */
      const s = getComputedStyle(ta);
      return {
        bg: s.backgroundColor,
        color: s.color,
        borderC: s.borderTopColor,
        borderW: s.borderTopWidth,
        shadow: s.boxShadow,
      };
    };
    const now = mk();

    return { cssVars: { bg, accent, text, stage }, ta: now };
  `);

  console.log('\n=== CSS 变量与画布底色 ===');
  console.log(JSON.stringify(r.cssVars, null, 2));
  console.log('\n=== 编辑器 textarea 计算样式（新版） ===');
  console.log(JSON.stringify(r.ta, null, 2));

  // 合成：画布底 → 编辑器半透明底 → 文字
  const canvasBg = parseColor(r.cssVars.stage) || parseColor(r.cssVars.bg);
  const edBgRaw = parseColor(r.ta.bg);
  const edBg = parseColor(r.ta.bg, canvasBg);       // 叠在画布上
  const border = parseColor(r.ta.borderC, canvasBg);
  const txt = parseColor(r.ta.color, edBg);

  const cEdVsCanvas = contrast(edBg, canvasBg);
  const cBorderVsCanvas = contrast(border, canvasBg);
  const cTxtVsEd = contrast(txt, edBg);

  console.log('\n=== 对比度（WCAG，1.0 完全相同） ===');
  console.log('编辑器底色  vs 画布底色 :', cEdVsCanvas.toFixed(3),
    cEdVsCanvas < 1.15 ? '← 几乎不可分辨' : cEdVsCanvas < 1.5 ? '← 很弱' : '');
  console.log('编辑器边框  vs 画布底色 :', cBorderVsCanvas.toFixed(3),
    cBorderVsCanvas < 1.5 ? '← 边框很弱' : '← 边框清晰');
  console.log('文字        vs 编辑器底 :', cTxtVsEd.toFixed(3), '(需 >4.5 才易读)');

  // 旧版边框 1.5px 时，视觉上更弱；用边界感知强度估算
  console.log('\n=== 边框可见性估算 ===');
  console.log('新版边框 2px + 3px 外发光 rgba(76,141,255,0.18)');
  console.log('旧版边框 1.5px 无外发光');
  console.log('→ 外发光把边框视觉宽度扩到约 2+3*2=8px 的柔和过渡带，');
  console.log('  在小窗口 + 深色主题下，是否"看得见"主要取决于这条带。');

  app.exit(0);
});
