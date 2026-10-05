'use strict';

/** 截图诊断：点文字工具 → 点画布 → 截图，看编辑器是否真的可见 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  const run = (c) => win.webContents.executeJavaScript(c, true);

  // 点文字工具
  const step1 = await run(`(() => {
    document.querySelector('.tool[data-tool="text"]').click();
    return document.getElementById('stage').className + ' | ' + document.getElementById('statusTool').textContent;
  })()`);
  console.log('切工具结果:', step1);
  // 点画布
  await run(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + 400, clientY: r.top + 300,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'diag-text-editor.png'), img.toPNG());
  console.log('截图已保存: diag-text-editor.png');

  // 便签同样来一遍
  await run(`document.querySelector('.tool[data-tool="note"]').click()`);
  await run(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + 700, clientY: r.top + 420,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const info = await run(`(() => {
    const ed = document.getElementById('textEditor');
    const ta = ed.querySelector('textarea');
    const er = ed.getBoundingClientRect(), tr = ta.getBoundingClientRect();
    return {
      editor: er.width.toFixed(0) + 'x' + er.height.toFixed(0) + ' @' + er.left.toFixed(0) + ',' + er.top.toFixed(0),
      textarea: tr.width.toFixed(0) + 'x' + tr.height.toFixed(0) + ' @' + tr.left.toFixed(0) + ',' + tr.top.toFixed(0),
      editorInlineWidth: ed.style.width,
      overflowX: (tr.right > er.right + 1) ? 'textarea 溢出编辑器 ' + (tr.right - er.right).toFixed(0) + 'px' : '不溢出',
      isNote: ed.classList.contains('is-note'),
    };
  })()`);
  console.log('便签编辑器几何:', JSON.stringify(info, null, 2));

  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'diag-note-editor.png'), img2.toPNG());
  console.log('截图已保存: diag-note-editor.png');

  app.exit(0);
});
