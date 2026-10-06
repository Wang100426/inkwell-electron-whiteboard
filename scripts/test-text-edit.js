'use strict';

/**
 * 文字 / 便签编辑链路测试。
 * 覆盖：新建、双击编辑、提交、撤销/重做、Esc 取消。
 * 用法：electron scripts/test-text-edit.js
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

let pass = 0;
let fail = 0;

// 全局兜底：任一环节卡死都留下线索，而不是被静默 SIGTERM
setTimeout(() => {
  console.log('\n!! 全局超时（90s），强制退出');
  app.exit(2);
}, 90000);

function check(name, cond, detail) {
  if (cond) {
    console.log('  \u2713 ' + name);
    pass++;
  } else {
    console.log('  \u2717 ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
    fail++;
  }
}

const t0 = Date.now();

/** 渲染进程公共脚手架：坐标换算 + 事件派发 */
const PRELUDE = [
  'const { store, renderer, state, setTool } = window.__inkwell;',
  'const c = document.getElementById("canvas");',
  'const cr = c.getBoundingClientRect();',
  'const ed = document.getElementById("textEditor");',
  'const ta = document.getElementById("textInput");',
  'const fire = (t, sx, sy) => c.dispatchEvent(new PointerEvent(t, {',
  '  clientX: cr.left + sx, clientY: cr.top + sy, button: 0, pointerId: 1, bubbles: true, isPrimary: true }));',
  'const dbl = (wx, wy) => { const s = renderer.toScreen(wx, wy);',
  '  c.dispatchEvent(new MouseEvent("dblclick", { clientX: cr.left + s.x, clientY: cr.top + s.y,',
  '    bubbles: true, cancelable: true, view: window, button: 0, detail: 2 })); };',
  'const submit = (v) => { ta.value = v;',
  '  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); };',
].join('\n');

app.whenReady().then(async () => {
  const ROOT = path.join(__dirname, '..');
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...a) => {
    const d = a[0];
    if (d && typeof d === 'object' && 'message' in d && (d.level ?? 0) >= 2) errors.push(d.message);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));

  async function run(label, body) {
    // body 允许传字符串或字符串数组（数组更可读，避免长串拼接出错）
    const code = Array.isArray(body) ? body.join('\n') : body;
    if (process.env.DUMP_CODE) {
      console.log('  [run] ' + label + ' bodyType=' + (Array.isArray(body) ? 'array' : typeof body)
        + ' codeLen=' + code.length);
    }
    // 超时兜底：否则某段卡死会静默 SIGTERM，看不出卡在哪
    let timer = null;
    try {
      const p = win.webContents.executeJavaScript('(() => {\n' + PRELUDE + '\n' + code + '\n})()');
      timer = new Promise((_, rej) => setTimeout(() => rej(new Error('注入代码超时(5s)')), 5000));
      const r = await Promise.race([p, timer]);
      // 等待 focusout 定时器（commitEdit 用 setTimeout 兜底）与重绘完成
      await new Promise((r2) => setTimeout(r2, 120));
      return r;
    } catch (e) {
      console.log('  \u2717 ' + label + ' 执行异常: ' + e.message);
      fail++;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  console.log('\n文字 / 便签编辑测试\n');

  /* ---------- 1. 新建文字 ---------- */
  const r1 = await run('新建文字', [
    'store.replaceAll([]); store.history.clear();',
    'setTool("text");',
    'fire("pointerdown", 300, 200);',
    'fire("pointerup", 300, 200);',
    'const shown = !ed.hidden;',
    'const focused = document.activeElement === ta;',
    'submit("你好世界");',
    'return { shown, focused, count: store.shapes.length,',
    '  type: store.shapes[0] && store.shapes[0].type,',
    '  text: store.shapes[0] && store.shapes[0].text,',
    '  editorHidden: ed.hidden };',
  ].join('\n'));
  if (r1) {
    check('点击弹出文字编辑器', r1.shown, r1);
    check('编辑器自动聚焦', r1.focused, r1);
    check('提交后生成 text 图形', r1.count === 1 && r1.type === 'text', r1);
    check('文字内容正确保存', r1.text === '你好世界', r1.text);
    check('提交后编辑器隐藏', r1.editorHidden);
  }

  /* ---------- 2. 编辑现有文字 + 撤销/重做 ---------- */
  const r2 = await run('编辑文字', [
    'const s = store.shapes[0];',
    'if (!s) return { error: "没有文字图形" };',
    // 先探明命中情况，不猜测
    'const scr = renderer.toScreen(s.x + 2, s.y + 2);',
    'const w = renderer.toWorld(scr.x, scr.y);',
    'const hitDirect = window.__inkwell.hitTest(s, w.x, w.y, 6);',
    'const b = window.__inkwell.boundsOf(s);',
    'dbl(s.x + 2, s.y + 2);',
    'const opened = !ed.hidden;',
    'const loaded = ta.value;',
    'submit("改过的文字");',
    'const afterEdit = store.shapes[0].text;',
    'document.getElementById("btnUndo").click();',
    'const afterUndo = store.shapes[0] && store.shapes[0].text;',
    'document.getElementById("btnRedo").click();',
    'const afterRedo = store.shapes[0].text;',
    'return { shape: JSON.parse(JSON.stringify(s)), hitDirect, bounds: b, world: w, opened, loaded, afterEdit, afterUndo, afterRedo };',
  ].join('\n'));
  if (r2) {
    check('hitTest 能命中文字', r2.hitDirect, r2);
    check('双击文字打开编辑器', r2.opened, r2);
    check('编辑器载入原有内容', r2.loaded === '你好世界', r2.loaded);
    check('编辑后内容更新', r2.afterEdit === '改过的文字', r2.afterEdit);
    check('撤销恢复旧内容', r2.afterUndo === '你好世界', r2.afterUndo);
    check('重做应用新内容', r2.afterRedo === '改过的文字', r2.afterRedo);
  }

  /* ---------- 3. 新建便签 ---------- */
  const r3 = await run('新建便签', [
    'store.replaceAll([]); store.history.clear();',
    'setTool("note");',
    'fire("pointerdown", 500, 300);',
    'fire("pointerup", 500, 300);',
    'const shown = !ed.hidden;',
    'const isNoteStyle = ed.classList.contains("is-note");',
    'submit("待办事项");',
    'const s = store.shapes[0];',
    'return { shown, isNoteStyle, count: store.shapes.length,',
    '  type: s && s.type, text: s && s.text, w: s && s.w, h: s && s.h };',
  ].join('\n'));
  if (r3) {
    check('点击弹出便签编辑器', r3.shown, r3);
    check('便签使用专用样式 is-note', r3.isNoteStyle, r3);
    check('生成 note 图形', r3.count === 1 && r3.type === 'note', r3);
    check('便签内容正确', r3.text === '待办事项', r3.text);
    check('便签有合理尺寸', r3.w > 100 && r3.h > 80, { w: r3.w, h: r3.h });
  }

  /* ---------- 4. 双击便签编辑（不再用 prompt） ---------- */
  const r4 = await run('编辑便签', [
    'const s = store.shapes[0];',
    'dbl(s.x + 20, s.y + 20);',
    'const opened = !ed.hidden;',
    'const loaded = ta.value;',
    'submit("改过的便签");',
    'return { opened, loaded, after: store.shapes[0].text };',
  ].join('\n'));
  if (r4) {
    check('双击便签打开编辑器', r4.opened, r4);
    check('便签编辑器载入原内容', r4.loaded === '待办事项', r4.loaded);
    check('便签内容更新成功', r4.after === '改过的便签', r4.after);
  }

  /* ---------- 5. Esc 取消 ---------- */
  const r5 = await run('Esc 取消', [
    'const s = store.shapes[0];',
    'const before = s.text;',
    'dbl(s.x + 20, s.y + 20);',
    'ta.value = "这段不该被保存";',
    'ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));',
    'return { hidden: ed.hidden, unchanged: store.shapes[0].text === before };',
  ].join('\n'));
  if (r5) {
    check('Esc 关闭编辑器', r5.hidden, r5);
    check('Esc 放弃修改（内容未变）', r5.unchanged, r5);
  }

  /* ---------- 6. 空白输入不建图形 ---------- */
  const r6 = await run('空白输入', [
    'store.replaceAll([]); store.history.clear();',
    'setTool("text");',
    'fire("pointerdown", 700, 400);',
    'fire("pointerup", 700, 400);',
    'submit("   ");',
    'return { count: store.shapes.length };',
  ].join('\n'));
  if (r6) check('空白输入不创建图形', r6.count === 0, r6);

  /* ---------- 7. 完整撤销链路 ---------- */
  const r7 = await run('编辑撤销链路', [
    'store.replaceAll([]); store.history.clear();',
    'setTool("text");',
    'fire("pointerdown", 300, 300);',
    'fire("pointerup", 300, 300);',
    'submit("第一版");',
    'const afterCreate = store.shapes[0].text;',
    'const s = store.shapes[0];',
    'dbl(s.x + 2, s.y + 2);',
    'submit("第二版");',
    'const afterEdit = store.shapes[0].text;',
    'document.getElementById("btnUndo").click();',
    'const undo1 = store.shapes[0] && store.shapes[0].text;',
    'document.getElementById("btnUndo").click();',
    'const undo2Count = store.shapes.length;',
    'document.getElementById("btnRedo").click();',
    'document.getElementById("btnRedo").click();',
    'const redo = store.shapes[0] && store.shapes[0].text;',
    'return { afterCreate, afterEdit, undo1, undo2Count, redo,'
      + '  undoDepth: store.history.index, stackLen: store.history.stack.length };',
  ].join('\n'));
  if (r7) {
    check('创建后内容正确', r7.afterCreate === '第一版', r7.afterCreate);
    check('二次编辑后内容正确', r7.afterEdit === '第二版', r7.afterEdit);
    check('撤销一次回到第一版', r7.undo1 === '第一版', r7.undo1);
    // 再撤销一次会回退到"创建前"——即图形被移除
    check('再撤销一次图形被移除', r7.undo2Count === 0, { count: r7.undo2Count, stackLen: r7.stackLen });
    check('连续重做恢复第二版', r7.redo === '第二版', r7.redo);
  }

  if (errors.length) {
    console.log('\n渲染进程错误:');
    errors.slice(0, 5).forEach((e) => console.log('    ' + e));
    fail += errors.length;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  app.exit(fail ? 1 : 0);
});
