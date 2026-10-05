'use strict';

/**
 * 诊断脚本：复现"点文字/便签工具 → 点画布 → 编辑器不出现"。
 *
 * 与 test-edit-close.js 的区别：本脚本**完全走真实点击链路**，
 * 不直接调 openEditor，而是真的去 click 工具栏按钮、再向 canvas
 * 派发 pointerdown，并在每一步打印中间状态。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron scripts/diag-text-note.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
const log = (...a) => console.log('  ▸', ...a);

ipcMain.on('file:save', (e) => e.returnValue && e.returnValue({ ok: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  await new Promise((r) => setTimeout(r, 600));

  const run = (code) => win.webContents.executeJavaScript(code, true);

  /* ---------- 1. 基础环境 ---------- */
  console.log('\n=== 1. 环境 ===');
  const env = await run(`(() => {
    const c = document.getElementById('canvas');
    const st = document.getElementById('stage');
    const cs = getComputedStyle(c);
    return {
      canvasSize: c.width + 'x' + c.height,
      canvasDisplay: cs.display,
      canvasPointerEvents: cs.pointerEvents,
      canvasVisibility: cs.visibility,
      canvasOpacity: cs.opacity,
      stageChildren: [...st.children].map(e => e.id || e.className),
      toolBtns: document.querySelectorAll('.tool').length,
      fnOpenEditor: typeof window.__inkwell,
    };
  })()`);
  log(JSON.stringify(env, null, 0));

  /* ---------- 2. 画布中心点，最上层元素是谁 ---------- */
  console.log('\n=== 2. 画布中心处最顶层元素 ===');
  const top = await run(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const el = document.elementFromPoint(x, y);
    return { tag: el && el.tagName, id: el && el.id, cls: el && el.className };
  })()`);
  log(JSON.stringify(top));

  /* ---------- 3. 点「文字」工具按钮 ---------- */
  console.log('\n=== 3. 点击「文字」工具按钮 ===');
  const afterToolClick = await run(`(() => {
    const btn = document.querySelector('.tool[data-tool="text"]');
    if (!btn) return { error: '找不到文字按钮' };
    const r = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
    btn.dispatchEvent(new MouseEvent('mouseup', opts));
    btn.dispatchEvent(new MouseEvent('click', opts));
    const stage = document.getElementById('stage');
    return {
      stageClass: stage.className,
      textGroupHidden: document.getElementById('textGroup').hidden,
      activeBtn: document.querySelector('.tool.active') && document.querySelector('.tool.active').dataset.tool,
      statusTool: document.getElementById('statusTool').textContent,
    };
  })()`);
  log(JSON.stringify(afterToolClick));

  /* ---------- 4. 向 canvas 派发真实 pointerdown ---------- */
  console.log('\n=== 4. 点击画布（真实 pointer 事件） ===');
  const afterCanvasClick = await run(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    });
    c.dispatchEvent(ev);
    const ed = document.getElementById('textEditor');
    return {
      defaultPrevented: ev.defaultPrevented,
      editorHidden: ed.hidden,
      editorDisplay: getComputedStyle(ed).display,
      editorRect: (() => { const q = ed.getBoundingClientRect(); return q.width + 'x' + q.height; })(),
      editorLeft: ed.style.left,
      editorTop: ed.style.top,
      activeEl: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    };
  })()`);
  log(JSON.stringify(afterCanvasClick));

  /* ---------- 5. 强制调用 openEditor 看能不能开 ---------- */
  console.log('\n=== 5. 直接验证编辑器元素本身是否可见 ===');
  const forceOpen = await run(`(() => {
    const ed = document.getElementById('textEditor');
    ed.hidden = false;
    const cs = getComputedStyle(ed);
    const r = ed.getBoundingClientRect();
    const res = {
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      zIndex: cs.zIndex, position: cs.position,
      rect: r.width + 'x' + r.height,
      parent: ed.parentElement && (ed.parentElement.id || ed.parentElement.className),
      parentPosition: getComputedStyle(ed.parentElement).position,
      parentOverflow: getComputedStyle(ed.parentElement).overflow,
      textareaRect: (() => { const q = ed.querySelector('textarea').getBoundingClientRect(); return q.width + 'x' + q.height; })(),
    };
    ed.hidden = true;
    return res;
  })()`);
  log(JSON.stringify(forceOpen, null, 2));

  if (errs.length) {
    console.log('\n=== 渲染进程报错 ===');
    errs.forEach((e) => console.log('  ✗', e));
  } else {
    console.log('\n（无渲染进程报错）');
  }

  console.log('\n诊断结束');
  app.exit(0);
});
