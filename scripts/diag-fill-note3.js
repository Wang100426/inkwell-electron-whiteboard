'use strict';

/**
 * 深挖：已填色的矩形在「用过便签之后」fill 变成便签黄。
 *
 * 上一轮只重放了直线路径（画→填→便签→切回），数据没变。
 * 这次把可能引发"数据串味"的操作全排列一遍：撤销/重做、移动、
 * 删除便签、再填充，并且检查 **id 是否重复 / 对象是否同一引用**
 * —— 这两件事任一成立，都会让"改便签"改到矩形头上。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/diag-fill-note3.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const ROOT = path.join(__dirname, '..');

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
setTimeout(() => { console.log('!! 超时'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
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
  await sleep(1200);

  const js = async (code) => {
    try {
      return await win.webContents.executeJavaScript(`(function(){ ${code} })()`, true);
    } catch (err) {
      return { __err: String(err && err.message) };
    }
  };

  // 统一的"状态快照"
  const dump = (tag) => js(`
    const { store, state } = window.__inkwell;
    return {
      tag: ${JSON.stringify(tag)},
      tool: state.tool,
      styleFill: state.style.fill,
      shapes: store.shapes.map((s) => ({ id: s.id, type: s.type, fill: s.fill, on: s.fillEnabled, x: Math.round(s.x), y: Math.round(s.y) })),
      sameRef: store.shapes.length >= 2 ? (store.shapes[0] === store.shapes[1]) : null,
      dupIds: (() => {
        const seen = new Set(), dup = [];
        store.shapes.forEach((s) => { if (seen.has(s.id)) dup.push(s.id); seen.add(s.id); });
        return dup;
      })(),
    };
  `);

  const PRELUDE = [
    'const { store, setTool, state } = window.__inkwell;',
    'const c = document.getElementById("canvas");',
    'const cr = c.getBoundingClientRect();',
    'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:3, pointerType:"mouse", isPrimary:true, bubbles:true }));',
    'const drawRect = (x1,y1,x2,y2) => { setTool("rect"); fire("pointerdown",x1,y1); fire("pointermove",x2,y2); fire("pointerup",x2,y2); return store.shapes[store.shapes.length-1]; };',
    'const makeNote = (x, y, text) => {',
    '  setTool("note"); fire("pointerdown", x, y); fire("pointerup", x, y);',
    '  const ta = document.getElementById("textInput");',
    '  ta.value = text;',
    '  ta.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", ctrlKey:true, bubbles:true }));',
    '  return store.shapes.filter(s => s.type === "note").pop();',
    '};',
    'const fillAt = (x, y) => { setTool("fill"); fire("pointerdown", x, y); fire("pointerup", x, y); };',
    'const pickFill = (col) => { setTool("fill"); const b = document.querySelector(".swatch[data-color=\\"" + col + "\\"]"); if (b) b.click(); return state.style.fill; };',
  ].join('\n');

  /* ---------- 场景 1：矩形填绿 → 便签压在矩形上 → 各种操作 ---------- */
  console.log('\n===== 场景 1：便签与已填矩形重叠 =====');
  console.log('建矩形+上色:', JSON.stringify(await js(PRELUDE + [
    'store.replaceAll([]); store.history.clear();',
    'const r = drawRect(200, 200, 460, 400);',
    'pickFill("#38d39f");',
    'fillAt(330, 300);',
    'return { rectFill: r.fill, on: r.fillEnabled, styleFill: state.style.fill, id: r.id };',
  ].join('\n'))));

  console.log('压一张便签(重叠):', JSON.stringify(await js(PRELUDE + [
    'const n = makeNote(280, 250, "便签A");',
    'return { noteFill: n.fill, noteId: n.id, shapes: store.shapes.map(s => ({ t: s.type, f: s.fill, on: s.fillEnabled })) };',
  ].join('\n'))));

  console.log('便签后:', JSON.stringify(await dump('after-note')));

  console.log('撤销一次:', JSON.stringify(await js(PRELUDE + [
    'store.undo();',
    'const rect = store.shapes.find(s => s.type === "rect");',
    'return { count: store.shapes.length, rectFill: rect && rect.fill, rectOn: rect && rect.fillEnabled,',
    '         styleFill: state.style.fill };',
  ].join('\n'))));

  console.log('重做一次:', JSON.stringify(await js(PRELUDE + [
    'store.redo();',
    'const rect = store.shapes.find(s => s.type === "rect");',
    'const note = store.shapes.find(s => s.type === "note");',
    'return { count: store.shapes.length, rectFill: rect && rect.fill, rectOn: rect && rect.fillEnabled,',
    '         noteFill: note && note.fill, styleFill: state.style.fill };',
  ].join('\n'))));

  console.log('选中便签并移动:', JSON.stringify(await js(PRELUDE + [
    'store.replaceAll([]); store.history.clear();',
    'const r = drawRect(200, 200, 460, 400); pickFill("#38d39f"); fillAt(330, 300);',
    'const n = makeNote(280, 250, "便签B");',
    'setTool("select");',
    'fire("pointerdown", 300, 270); fire("pointerup", 300, 270);',
    'const sel = state.selection.map(s => s.type);',
    'window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));',
    'const rect = store.shapes.find(s => s.type === "rect");',
    'const note = store.shapes.find(s => s.type === "note");',
    'return { sel, rectFill: rect && rect.fill, noteFill: note && note.fill, styleFill: state.style.fill };',
  ].join('\n'))));

  console.log('删除便签后:', JSON.stringify(await js(PRELUDE + [
    'const note = store.shapes.find(s => s.type === "note");',
    'if (note) { state.selection = [note]; window.__inkwell.updateStatus(); }',
    'document.getElementById("btnDelete").click();',
    'const rect = store.shapes.find(s => s.type === "rect");',
    'return { count: store.shapes.length, rectFill: rect && rect.fill, styleFill: state.style.fill };',
  ].join('\n'))));

  /* ---------- 场景 2：先有便签，再填矩形 ---------- */
  console.log('\n===== 场景 2：先便签，后填矩形 =====');
  console.log(JSON.stringify(await js(PRELUDE + [
    'store.replaceAll([]); store.history.clear();',
    'const n = makeNote(280, 250, "便签C");',
    'const r = drawRect(600, 200, 860, 400);',
    'pickFill("#ff5f6b");',
    'fillAt(730, 300);',
    'const rect = store.shapes.find(s => s.type === "rect");',
    'const note = store.shapes.find(s => s.type === "note");',
    'return { rectFill: rect && rect.fill, noteFill: note && note.fill, styleFill: state.style.fill };',
  ].join('\n')), null, 2));

  /* ---------- 场景 3：填充后按 Ctrl+D 复制、再撤销 ---------- */
  console.log('\n===== 场景 3：填充后复制/撤销 =====');
  console.log(JSON.stringify(await js(PRELUDE + [
    'store.replaceAll([]); store.history.clear();',
    'const r = drawRect(200, 200, 460, 400); pickFill("#38d39f"); fillAt(330, 300);',
    'setTool("select"); state.selection = [r]; window.__inkwell.updateStatus();',
    'document.getElementById("btnDuplicate").click();',
    'store.undo(); store.redo();',
    'return { shapes: store.shapes.map(s => ({ t: s.type, f: s.fill, on: s.fillEnabled })), styleFill: state.style.fill };',
  ].join('\n')), null, 2));

  app.exit(0);
});
