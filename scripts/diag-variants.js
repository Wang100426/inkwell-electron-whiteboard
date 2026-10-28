'use strict';

/**
 * 诊断/验收：面板顶部的「工具变体」区（#variantGroup）是否真的可见、可点。
 *
 * 用 CDP Input.dispatchMouseEvent 派发**真实鼠标点击**，
 * 并对每个按钮做 elementFromPoint 命中测试 —— 光看 hidden 属性
 * 或 getBoundingClientRect 都不足以证明"用户真能点到"（1.3.0 的
 * 子弹层就是 DOM 一切正常、实际被面板压住）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-variants.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 截图验收：不禁用硬件加速（disable-gpu 下 capturePage 返回 0x0）
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp');

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

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

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
  await sleep(1500);

  const evalJs = (expr) => win.webContents.executeJavaScript(`(function(){ ${expr} })()`, true);
  const wc = win.webContents;
  wc.debugger.attach('1.3');

  async function realClick(x, y) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(25);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  const center = (sel) => evalJs(`
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
             l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  `);

  /** 对变体区做全量体检：几何 + 每个按钮的命中测试 */
  const audit = () => evalJs(`
    const box = document.getElementById('variantGroup');
    const br = box.getBoundingClientRect();
    const btns = Array.from(document.querySelectorAll('#variantItems .variant-btn'));
    const hits = btns.map((b) => {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const el = document.elementFromPoint(cx, cy);
      return {
        tool: b.dataset.tool,
        label: b.textContent.trim(),
        rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        hitSelf: !!(el && (el === b || b.contains(el))),
        hitWhat: el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : null,
        active: b.classList.contains('active'),
      };
    });
    return {
      hidden: box.hidden,
      rect: { l: Math.round(br.left), t: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) },
      label: document.getElementById('variantLabel').textContent,
      count: btns.length,
      hits,
      currentTool: window.__inkwell.state.tool,
      toolGroup: window.__inkwell.state.toolGroup,
      railFaceTool: (() => {
        const g = document.querySelector('.rail-tools .tool[data-group="shape"]');
        const f = g && g.querySelector('.tool-face');
        return f ? f.dataset.face : null;
      })(),
    };
  `);

  /* ---------- 1. 点「图形」分组 ---------- */
  const shapeBtn = await center('.rail-tools .tool[data-group="shape"]');
  console.log('图形按钮:', JSON.stringify(shapeBtn));
  await realClick(shapeBtn.x, shapeBtn.y);
  await sleep(350);

  const a1 = await audit();
  console.log('图形分组变体区:');
  console.log(JSON.stringify(a1, null, 2));

  /* ---------- 2. 点变体区里的「椭圆」 ---------- */
  const ellipse = a1.hits.find((h) => h.tool === 'ellipse');
  if (!ellipse) {
    console.log('!! 找不到椭圆按钮');
  } else {
    await realClick(ellipse.rect.l + 20, ellipse.rect.t + 20);
    await sleep(300);
    const a2 = await evalJs(`
      const g = document.querySelector('.rail-tools .tool[data-group="shape"]');
      const f = g.querySelector('.tool-face');
      return { tool: window.__inkwell.state.tool,
               railFace: f ? f.dataset.face : null,
               activeVariant: (document.querySelector('#variantItems .variant-btn.active') || {}).dataset,
               panelHead: document.getElementById('panelHeadName').textContent };
    `);
    console.log('点椭圆之后:', JSON.stringify(a2));
  }

  /* ---------- 3. 画笔分组 ---------- */
  const drawBtn = await center('.rail-tools .tool[data-group="draw"]');
  await realClick(drawBtn.x, drawBtn.y);
  await sleep(300);
  const a3 = await audit();
  console.log('绘画分组变体区:', JSON.stringify({
    hidden: a3.hidden, label: a3.label, count: a3.count,
    tools: a3.hits.map((h) => h.tool),
    allHitSelf: a3.hits.every((h) => h.hitSelf),
    currentTool: a3.currentTool,
  }));

  /* ---------- 4. 文本分组 ---------- */
  const textBtn = await center('.rail-tools .tool[data-group="text"]');
  await realClick(textBtn.x, textBtn.y);
  await sleep(300);
  const a4 = await audit();
  console.log('文本分组变体区:', JSON.stringify({
    hidden: a4.hidden, label: a4.label, count: a4.count,
    tools: a4.hits.map((h) => h.tool),
    allHitSelf: a4.hits.every((h) => h.hitSelf),
  }));

  /* ---------- 5. 选择分组：变体区应隐藏 ---------- */
  const selBtn = await center('.rail-tools .tool[data-group="select"]');
  await realClick(selBtn.x, selBtn.y);
  await sleep(300);
  const a5 = await evalJs(`
    const box = document.getElementById('variantGroup');
    return { hidden: box.hidden, tool: window.__inkwell.state.tool,
             colorHidden: document.getElementById('colorGroup').hidden };
  `);
  console.log('选择分组:', JSON.stringify(a5));

  /* ---------- 6. 截图 ---------- */
  await realClick(shapeBtn.x, shapeBtn.y);
  await sleep(400);
  const full = await wc.capturePage();
  fs.writeFileSync(path.join(OUT, 'variants-full.png'), full.toPNG());
  console.log('全窗截图:', JSON.stringify(full.getSize()));

  const panel = await center('.panel');
  if (panel && panel.w >= 100) {
    const crop = await wc.capturePage({ x: panel.l, y: panel.t, width: panel.w, height: Math.min(560, panel.h) });
    fs.writeFileSync(path.join(OUT, 'variants-panel.png'), crop.toPNG());
    console.log('面板截图:', JSON.stringify(crop.getSize()), '->', path.join(OUT, 'variants-panel.png'));
  }

  wc.debugger.detach();
  app.exit(0);
});
