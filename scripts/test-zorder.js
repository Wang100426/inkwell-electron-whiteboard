'use strict';

/**
 * 图层顺序（上移一层 / 下移一层 / 置顶 / 置底）回归测试。
 *
 * 覆盖：
 *   A. reorderIds 纯函数的各种情形（单选 / 多选 / 边界）
 *   B. BoardStore.reorder 的真实行为（顺序生效、撤销/重做、无变化不记历史）
 *   C. UI：按钮存在、选中后可用、到顶/到底时置灰、点击有效、快捷键有效
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test-zorder.js
 *      （或 npm run test:zorder）
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
ipcMain.handle('app:info', () => ({ version: '1.1.0', platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', () => {});
ipcMain.on('app:dirty', () => {});

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // show 必须为 true：隐藏窗口不重绘，rAF 不会跑，
    // 而下面的置灰判断依赖 requestAnimationFrame 后的状态。
    width: 1280, height: 860, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1200);

  // 附加 CDP 用真实输入（这里主要用 executeJavaScript + 合成键盘事件即可，
  // 但键盘走真实输入更可靠）
  win.webContents.debugger.attach('1.3');
  const send = (method, params) => win.webContents.debugger.sendCommand(method, params || {});
  const js = (c) => win.webContents.executeJavaScript(
    '(function(){ try { ' + c + ' } catch(e) { return {__err: e.message}; } })()', true);

  /* ===================== A. 纯函数 reorderIds ===================== */
  console.log('\n【A. reorderIds 纯函数】');

  const pure = await js(`
    const { reorderIds } = window.__inkwell;
    const T = (ids, chosen, mode) => reorderIds(ids, new Set(chosen), mode).join(',');
    return {
      单上: T(['a','b','c','d'], ['b'], 'up'),
      单下: T(['a','b','c','d'], ['c'], 'down'),
      顶不动: T(['a','b','c'], ['c'], 'up'),
      底不动: T(['a','b','c'], ['a'], 'down'),
      置顶: T(['a','b','c','d'], ['b'], 'top'),
      置底: T(['a','b','c','d'], ['c'], 'bottom'),
      相邻上: T(['a','b','c','d'], ['b','c'], 'up'),
      相邻下: T(['a','b','c','d'], ['b','c'], 'down'),
      间隔上: T(['a','b','c','d','e'], ['b','d'], 'up'),
      全选上不动: T(['a','b','c'], ['a','b','c'], 'up'),
      多选置顶保序: T(['a','b','c','d','e'], ['b','d'], 'top'),
      多选置底保序: T(['a','b','c','d','e'], ['b','d'], 'bottom'),
      空选: T(['a','b'], [], 'up'),
    };
  `);
  if (pure && pure.__err) { console.log('  !! 出错', pure.__err); }

  check('单选中上移一层', pure.单上 === 'a,c,b,d', pure.单上);
  check('单选中下移一层', pure.单下 === 'a,c,b,d', pure.单下);
  check('已在最上层，上移不动', pure.顶不动 === 'a,b,c', pure.顶不动);
  check('已在最下层，下移不动', pure.底不动 === 'a,b,c', pure.底不动);
  check('置顶移到末尾', pure.置顶 === 'a,c,d,b', pure.置顶);
  check('置底移到开头', pure.置底 === 'c,a,b,d', pure.置底);
  check('相邻双选整体上移一格', pure.相邻上 === 'a,d,b,c', pure.相邻上);
  check('相邻双选整体下移一格', pure.相邻下 === 'b,c,a,d', pure.相邻下);
  check('间隔双选各自上移一格', pure.间隔上 === 'a,c,b,e,d', pure.间隔上);
  check('全选上移不变', pure.全选上不动 === 'a,b,c', pure.全选上不动);
  check('多选置顶保持内部相对顺序', pure.多选置顶保序 === 'a,c,e,b,d', pure.多选置顶保序);
  check('多选置底保持内部相对顺序', pure.多选置底保序 === 'b,d,a,c,e', pure.多选置底保序);
  check('空选中不算出问题', pure.空选 === 'a,b', pure.空选);

  /* ===================== B. store.reorder 真实行为 ===================== */
  console.log('\n【B. store 行为】');

  const storeTest = await js(`
    const { store, makeBase } = window.__inkwell;
    store.replaceAll([], { record: false });
    const mk = (n) => { const s = makeBase('rect', { color:'#fff', fill:'transparent', width:2 });
                        s.id = n; s.x = 0; s.y = 0; s.w = 10; s.h = 10; return s; };
    ['A','B','C'].forEach((n) => store.replaceAll(store.shapes.concat([mk(n)]), { record:false }));
    store.history.clear();

    const ids = () => store.shapes.map(s => s.id).join('');

    const before1 = ids();
    const byId = (n) => store.shapes.find(s => s.id === n);
    const ok1 = store.reorder([byId('A')], 'up');     // A上移 → B A C
    const after1 = ids();
    const undo1 = !!store.undo(); const undoIds = ids();
    store.redo(); const redoIds = ids();

    // 无变化时不记历史
    const hLenBefore = store.history.stack.length;
    const ok2 = store.reorder([byId('C')], 'up');      // C已在顶 → 不移动
    const hLenAfter = store.history.stack.length;

    // 置顶 / 置底
    store.replaceAll([],{record:false});
    ['A','B','C'].forEach((n) => store.replaceAll(store.shapes.concat([mk(n)]), { record:false }));
    store.reorder([store.shapes.find(s=>s.id==='A')], 'top');
    const topIds = ids();
    store.reorder([store.shapes.find(s=>s.id==='A')], 'bottom');
    const botIds = ids();

    return { before1, ok1, after1, undo1, undoIds, redoIds, ok2, hLenBefore, hLenAfter, topIds, botIds };
  `);

  check('reorder 返回 true 表示发生了变化', storeTest.ok1 === true, storeTest);
  check('上移一层顺序正确 (ABC → BAC)', storeTest.before1 === 'ABC' && storeTest.after1 === 'BAC', storeTest);
  check('撤销恢复到原顺序', storeTest.undo1 === true && storeTest.undoIds === 'ABC', storeTest);
  check('重做再次应用新顺序', storeTest.redoIds === 'BAC', storeTest);
  check('已到顶时 reorder 返回 false', storeTest.ok2 === false, storeTest);
  check('无变化时不写入历史', storeTest.hLenBefore === storeTest.hLenAfter, storeTest);
  check('置顶 (ABC → BCA)', storeTest.topIds === 'BCA', storeTest);
  check('置底 (BCA → ABC)', storeTest.botIds === 'ABC', storeTest);

  /* ===================== C. UI ===================== */
  console.log('\n【C. 界面与快捷键】');

  const ui = await js(`
    const b1 = document.getElementById('btnRaise');
    const b2 = document.getElementById('btnLower');
    return {
      hasRaise: !!b1, hasLower: !!b2,
      raiseText: b1 && b1.textContent.trim(),
      lowerText: b2 && b2.textContent.trim(),
    };
  `);
  check('存在「上移一层」按钮', ui.hasRaise && /上移/.test(ui.raiseText || ''), ui);
  check('存在「下移一层」按钮', ui.hasLower && /下移/.test(ui.lowerText || ''), ui);

  // 无选中时两个按钮都该置灰
  const noSel = await js(`
    const { state, requestRender, updateStatus } = window.__inkwell;
    state.selection = [];
    requestRender();
    updateStatus();      /* 直接刷新，不依赖 rAF（隐藏/节流窗口里 rAF 可能不跑）*/
    return {
      raise: document.getElementById('btnRaise').disabled,
      lower: document.getElementById('btnLower').disabled,
    };
  `);
  check('无选中时「上移」置灰', noSel.raise === true, noSel);
  check('无选中时「下移」置灰', noSel.lower === true, noSel);

  // 选中底层图形：可上移、不可下移
  const bottomSel = await js(`
    const { store, state, requestRender, makeBase, updateStatus } = window.__inkwell;
    store.replaceAll([], { record: false });
    ['A','B','C'].forEach((n) => {
      const s = makeBase('rect', { color:'#fff', fill:'transparent', width:2 });
      s.id = n; s.x = 0; s.y = 0; s.w = 20; s.h = 20;
      store.replaceAll(store.shapes.concat([s]), { record: false });
    });
    state.selection = [store.shapes.find(s => s.id === 'A')];
    requestRender();
    updateStatus();
    return {
      raise: document.getElementById('btnRaise').disabled,
      lower: document.getElementById('btnLower').disabled,
    };
  `);
  check('选中最底层时可上移', bottomSel.raise === false, bottomSel);
  check('选中最底层时「下移」置灰', bottomSel.lower === true, bottomSel);

  // 选中顶层：可下移、不可上移
  const topSel = await js(`
    const { store, state, requestRender, updateStatus } = window.__inkwell;
    state.selection = [store.shapes.find(s => s.id === 'C')];
    requestRender();
    updateStatus();
    return {
      raise: document.getElementById('btnRaise').disabled,
      lower: document.getElementById('btnLower').disabled,
    };
  `);
  check('选中最顶层时「上移」置灰', topSel.raise === true, topSel);
  check('选中最顶层时可下移', topSel.lower === false, topSel);

  // 点击按钮真的改变顺序
  const clickEffect = await js(`
    const { store, state, requestRender, updateStatus } = window.__inkwell;
    state.selection = [store.shapes.find(s => s.id === 'A')];
    requestRender();
    updateStatus();   /* 必须刷新，否则按钮还停在上一轮的 disabled 状态 */
    document.getElementById('btnRaise').click();
    return store.shapes.map(s => s.id).join('');
  `);
  check('点「上移一层」按钮后顺序变为 BAC', clickEffect === 'BAC', clickEffect);

  // 快捷键 Ctrl+] / Ctrl+[
  const k1 = await js(`
    const { store, requestRender } = window.__inkwell;
    store.replaceAll([], { record: false });
    ['A','B','C'].forEach((n) => {
      const s = makeBase('rect', { color:'#fff', fill:'transparent', width:2 });
      s.id = n; s.x = 0; s.y = 0; s.w = 20; s.h = 20;
      store.replaceAll(store.shapes.concat([s]), { record: false });
    });
    const { state } = window.__inkwell;
    state.selection = [store.shapes.find(s => s.id === 'A')];
    requestRender();
    /* 回传，供外部派发真实键盘事件 */
    return store.shapes.map(s => s.id).join('');
  `);
  check('快捷键前初始顺序 ABC', k1 === 'ABC', k1);

  // 用 CDP 派发真实键盘事件（走默认行为链路）
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 221, code: 'BracketRight',
    key: ']', modifiers: 2,  // 2 = Ctrl
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 221, code: 'BracketRight',
    key: ']', modifiers: 2,
  });
  await sleep(200);
  const afterHotkey = await js('return window.__inkwell.store.shapes.map(s => s.id).join("")');
  check('Ctrl+] 真实按键上移一层 (ABC → BAC)', afterHotkey === 'BAC', afterHotkey);

  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', windowsVirtualKeyCode: 219, code: 'BracketLeft',
    key: '[', modifiers: 2,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 219, code: 'BracketLeft',
    key: '[', modifiers: 2,
  });
  await sleep(200);
  const afterHotkey2 = await js('return window.__inkwell.store.shapes.map(s => s.id).join("")');
  check('Ctrl+[ 真实按键下移一层 (BAC → ABC)', afterHotkey2 === 'ABC', afterHotkey2);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  try { win.webContents.debugger.detach(); } catch (_) {}
  app.exit(fail === 0 ? 0 : 1);
});
