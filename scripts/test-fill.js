'use strict';

/**
 * 填充工具专项测试。
 *
 * 覆盖：
 *   - 新图形默认无填充（不再有粘性开关）
 *   - 切片便签不污染全局填充（历史 bug）
 *   - 油漆桶：未填充→填充、同色→取消、异色→换色
 *   - 填充可撤销/重做
 *   - 便签颜色固定，不受填充色板影响
 *   - 只对矩形/椭圆生效
 *
 * 用法：electron scripts/test-fill.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

ipcMain.handle('app:info', () => ({ version: '1.3.0', platform: process.platform, electron: process.versions.electron }));
/* 1.2.0 无边框窗口：渲染层会查询最大化状态，测试环境补个 stub 避免报错 */
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.on('app:health', () => {});
ipcMain.on('app:save-done', () => {});
ipcMain.on('app:dirty', () => {});
ipcMain.on('app:close-choice', () => {});

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  \u2713 ' + name); pass++; }
  else { console.log('  \u2717 ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); fail++; }
}

setTimeout(() => { console.log('\n!! 超时'); app.exit(2); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ROOT = path.join(__dirname, '..');
  const win = new BrowserWindow({
    width: 1280, height: 850, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const errors = [];
  win.webContents.on('console-message', (...a) => {
    const d = a[0];
    if (d && typeof d === 'object' && 'message' in d && (d.level ?? 0) >= 2) errors.push(d.message);
    else if (a[1] >= 2) errors.push(a[2]);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(900);

  const js = (code) => win.webContents.executeJavaScript('(() => {' + code + '})()');

  // 公共前奏：清空画布、画一个矩形、返回其 id
  const PRELUDE = [
    'const { store, renderer, setTool, state } = window.__inkwell;',
    'const c = document.getElementById("canvas");',
    'const cr = c.getBoundingClientRect();',
    'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {',
    '  clientX: cr.left + x, clientY: cr.top + y, button: 0, buttons: 1,',
    '  pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true }));',
    'const drawRect = (x1, y1, x2, y2) => {',
    '  setTool("rect");',
    '  fire("pointerdown", x1, y1); fire("pointermove", x2, y2); fire("pointerup", x2, y2);',
    '  return store.shapes[store.shapes.length - 1];',
    '};',
    'const fillAt = (x, y) => { setTool("fill"); fire("pointerdown", x, y); fire("pointerup", x, y); };',
    // 填充工具复用画笔色板：选色即设填充色
    'const pickFill = (color) => {',
    '  setTool("fill");',
    '  const b = document.querySelector(".swatch[data-color=\\"" + color + "\\"]");',
    '  if (b) b.click();',
    '  return state.style.fill;',
    '};',
  ].join('\n');

  console.log('\n填充工具测试\n');

  /* ---------- 1. 新图形默认无填充 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'state.style.fill = "#4c8dff";',
      'const rect = drawRect(200, 200, 400, 350);',
      'return { fillEnabled: rect.fillEnabled, type: rect.type };',
    ].join('\n'));
    check('新矩形默认不带填充', r.fillEnabled === false, r);
  }

  /* ---------- 2. 便签不污染全局填充（历史 bug） ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'state.style.fill = "#38d39f";',
      'setTool("note");',
      'const afterNote = { fill: state.style.fill, enabled: state.style.fillEnabled };',
      'setTool("rect");',
      'const rect = drawRect(200, 200, 400, 350);',
      'return { afterNote, rectFillEnabled: rect.fillEnabled, rectFill: rect.fill };',
    ].join('\n'));
    check('切便签不改全局填充色', r.afterNote.fill === '#38d39f', r.afterNote);
    check('切便签不打开填充开关', !r.afterNote.enabled, r.afterNote);
    check('切过便签后画的矩形仍是描边', r.rectFillEnabled === false, r);
  }

  /* ---------- 3. 便签自己永远是黄色 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'state.style.fill = "#ff5f6b";',   // 故意设一个非黄色的填充色
      'setTool("note");',
      'fire("pointerdown", 300, 300); fire("pointerup", 300, 300);',
      'const ta = document.getElementById("textInput");',
      'ta.value = "便签";',
      'ta.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", ctrlKey:true, bubbles:true }));',
      'const note = store.shapes.find(s => s.type === "note");',
      'return { fill: note && note.fill, enabled: note && note.fillEnabled, color: note && note.color };',
    ].join('\n'));
    check('便签底色固定为黄', r.fill === '#f5c451', r);
    check('便签带填充标记', r.enabled === true, r);
  }

  /* ---------- 4. 油漆桶：未填充 → 填充 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'const rect = drawRect(200, 200, 400, 350);',
      'const before = rect.fillEnabled;',
      'pickFill("#38d39f");',
      'fillAt(300, 275);',
      'const after = store.shapes[store.shapes.length - 1];',
      'return { before, after: after.fillEnabled, fill: after.fill, count: store.shapes.length };',
    ].join('\n'));
    check('点未填充图形 → 填充', r.before === false && r.after === true, r);
    check('填充色为所选颜色', r.fill === '#38d39f', r.fill);
    check('填充不产生新图形', r.count === 1, r);
  }

  /* ---------- 5. 油漆桶：同色再点 → 取消 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'pickFill("#4c8dff");',
      'fillAt(300, 275);',
      'const filled = store.shapes[0].fillEnabled;',
      'fillAt(300, 275);',   // 再点一次
      'const after = store.shapes[0].fillEnabled;',
      'return { filled, after };',
    ].join('\n'));
    check('同色再点取消填充', r.filled === true && r.after === false, r);
  }

  /* ---------- 6. 油漆桶：异色 → 换色（不是取消） ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'pickFill("#4c8dff"); fillAt(300, 275);',
      'const first = store.shapes[0].fill;',
      'pickFill("#ffc93d"); fillAt(300, 275);',
      'const s = store.shapes[0];',
      'return { first, after: s.fill, enabled: s.fillEnabled };',
    ].join('\n'));
    check('换色时保持填充状态', r.enabled === true, r);
    check('填充色被替换', r.first === '#4c8dff' && r.after === '#ffc93d', r);
  }

  /* ---------- 7. 「清除填充」按钮 = 取消填充 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'pickFill("#4c8dff"); fillAt(300, 275);',
      'setTool("fill");',
      'document.getElementById("btnNoFill").click();',
      'const cleared = state.style.fill;',
      'fillAt(300, 275);',
      'return { cleared, enabled: store.shapes[0].fillEnabled };',
    ].join('\n'));
    check('点「清除填充」后填充色变为无', r.cleared === 'transparent', r);
    check('清除填充色后点图形取消填充', r.enabled === false, r);
  }

  /* ---------- 8. 填充可撤销 / 重做 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'pickFill("#38d39f"); fillAt(300, 275);',
      'const filled = store.shapes[0].fillEnabled;',
      'store.undo();',
      'const afterUndo = store.shapes[0].fillEnabled;',
      'store.redo();',
      'const afterRedo = store.shapes[0].fillEnabled;',
      'return { filled, afterUndo, afterRedo };',
    ].join('\n'));
    check('填充后状态正确', r.filled === true, r);
    check('撤销填充', r.afterUndo === false, r);
    check('重做填充', r.afterRedo === true, r);
  }

  /* ---------- 9. 只对矩形/椭圆生效 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'setTool("pen");',
      'fire("pointerdown", 200, 200);',
      'for (let i = 1; i <= 10; i++) fire("pointermove", 200 + i * 15, 200);',
      'fire("pointerup", 350, 200);',
      'const penShape = store.shapes[0];',
      'pickFill("#38d39f");',
      'fillAt(275, 200);',   // 点在笔迹上
      'return { type: penShape.type, fillEnabled: store.shapes[0].fillEnabled, count: store.shapes.length };',
    ].join('\n'));
    check('笔迹不被填充', r.fillEnabled === false, r);
    check('填充笔迹不产生新图形', r.count === 1, r);
  }

  /* ---------- 10. 空白处点击无副作用 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'const before = store.shapes.length;',
      'pickFill("#38d39f");',
      'fillAt(900, 700);',   // 空白处
      'return { before, after: store.shapes.length, fillEnabled: store.shapes[0].fillEnabled };',
    ].join('\n'));
    check('空白处点击不产生图形', r.after === r.before, r);
    check('空白处点击不误改图形', r.fillEnabled === false, r);
  }

  /* ---------- 11. 填充后读档仍保留 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'drawRect(200, 200, 400, 350);',
      'pickFill("#38d39f"); fillAt(300, 275);',
      'const json = JSON.stringify(store.toJSON());',
      'store.loadJSON(json);',
      'const s = store.shapes[0];',
      'return { fillEnabled: s.fillEnabled, fill: s.fill };',
    ].join('\n'));
    check('读档后填充状态保留', r.fillEnabled === true && r.fill === '#38d39f', r);
  }

  /* ---------- 12. 填充工具快捷键 F ---------- */
  {
    const r = await js([
      'const { state } = window.__inkwell;',
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true }));',
      'return { tool: state.tool };',
    ].join('\n'));
    check('按 F 切到填充工具', r.tool === 'fill', r);
  }

  /* ---------- 13. UI：工具栏有填充按钮 ---------- */
  {
    const r = await js([
      'const b = document.querySelector(".tool[data-tool=\\"fill\\"]");',
      'return { exists: !!b, title: b ? b.title : null };',
    ].join('\n'));
    check('工具栏存在填充按钮', r.exists === true, r);
  }

  if (errors.length) {
    console.log('\n渲染进程错误:');
    errors.slice(0, 5).forEach((e) => console.log('    ' + e));
    fail += errors.length;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  app.exit(fail ? 1 : 0);
});
