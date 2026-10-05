'use strict';

/**
 * 编辑与关闭的回归测试。
 *
 * 核心：复现"真实鼠标点击会引发焦点转移"这一合成事件测不到的场景。
 * 用户反馈的两个问题：
 *   A. 文字/便签编辑不了 —— 编辑器刚打开就被判定失焦、提交空内容并关闭
 *   B. 创建过内容后关不掉   —— 原生模态框挂起
 *
 * 用法：electron scripts/test-edit-close.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

// ---- 复刻 main.js 的关闭逻辑（含 hasUnsavedChanges 缓存 + HTML 弹框）----
let hasUnsavedChanges = false;
let allowClose = false;
let mainWin = null;
let closePrevented = 0;
let confirmedSent = 0;

ipcMain.handle('app:info', () => ({ version: '1.3.0', platform: process.platform, electron: process.versions.electron }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:dirty', (_e, d) => { hasUnsavedChanges = !!d; });
ipcMain.on('app:save-done', () => {});
ipcMain.on('app:close-choice', (_e, choice) => {
  console.log('    [main] 收到关闭选择: ' + choice);
  if (choice === 'cancel') return;
  if (choice === 'save') return;
  allowClose = true;
});

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
  mainWin = new BrowserWindow({
    width: 1280, height: 850, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  // 复刻 close 逻辑（emit 时手动传一个带 preventDefault 的事件对象，
  // 因为 BrowserWindow.emit('close') 不会自动生成事件参数）
  mainWin.on('close', (e) => {
    if (allowClose) return;
    if (!hasUnsavedChanges) { allowClose = true; return; }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    closePrevented++;
    confirmedSent++;
    mainWin.webContents.send('app:confirm-close');
  });

  // 便捷触发：模拟点击标题栏的叉
  const triggerClose = () => mainWin.emit('close', { preventDefault() { /* noop */ } });

  const errors = [];
  mainWin.webContents.on('console-message', (...a) => {
    const d = a[0];
    if (d && typeof d === 'object' && 'message' in d && (d.level ?? 0) >= 2) errors.push(d.message);
    else if (a[1] >= 2) errors.push(a[2]);
  });

  await mainWin.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1000);

  const js = (code) => mainWin.webContents.executeJavaScript('(() => {' + code + '})()');

  console.log('\n编辑与关闭回归测试\n');

  /* ============ A. 编辑器不应被焦点转移误关 ============ */
  {
    const r = await js([
      'const { store, setTool } = window.__inkwell;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const ed = document.getElementById("textEditor");',
      'store.replaceAll([]); store.history.clear();',
      'setTool("text");',
      'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:1, pointerType:"mouse", isPrimary:true, bubbles:true }));',
      'fire("pointerdown", 300, 300);',
      'fire("pointerup", 300, 300);',
      'const opened = !ed.hidden;',
      '/* 关键：真实鼠标松开后焦点会回到 body —— 模拟这一转移 */',
      'document.body.focus();',
      'const stillOpen = !ed.hidden;',
      '/* 再模拟 click 事件（真实点击还会派发 click） */',
      'c.dispatchEvent(new MouseEvent("click", { clientX: cr.left+300, clientY: cr.top+300, bubbles: true }));',
      'const afterClick = !ed.hidden;',
      'return { opened, stillOpen, afterClick,',
      '  active: document.activeElement ? (document.activeElement.id || "body") : "none" };',
    ].join('\n'));
    console.log('  A. 编辑器抗焦点转移: ' + JSON.stringify(r));
    check('点击画布打开编辑器', r.opened, r);
    check('焦点回到 body 后编辑器仍开着', r.stillOpen, r);
    check('额外 click 事件后编辑器仍开着', r.afterClick, r);
    check('输入框保持焦点', r.active === 'textInput', r.active);
  }

  /* ============ A1b. 编辑器必须落在画布可视范围内 ============
   * 回归点：点画布右下区域时，编辑器曾被定位到画布外
   * （实测 pos=1200 而画布只到 1126），被 .stage 的 overflow:hidden
   * 整个裁掉 → 用户看到的是"点了没反应"。 */
  {
    const r = await js([
      'const { store, setTool } = window.__inkwell;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const stage = document.getElementById("stage");',
      'const ed = document.getElementById("textEditor");',
      'store.replaceAll([]); store.history.clear();',
      'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:1, pointerType:"mouse", isPrimary:true, bubbles:true }));',
      'const openAt = (tool, x, y) => {',
      '  setTool(tool); fire("pointerdown", x, y); fire("pointerup", x, y);',
      '  const b = ed.getBoundingClientRect();',
      '  const s = stage.getBoundingClientRect();',
      '  const res = { right: Math.round(b.right), bottom: Math.round(b.bottom),',
      '                stageRight: Math.round(s.right), stageBottom: Math.round(s.bottom),',
      '                width: Math.round(b.width), height: Math.round(b.height) };',
      '  ed.hidden = true;',
      '  return res;',
      '};',
      '/* 右下角：最容易出界的位置 */',
      'const textBR = openAt("text", cr.width - 20, cr.height - 20);',
      'const noteBR = openAt("note", cr.width - 20, cr.height - 20);',
      '/* 左上角：正常位置，不应被挪动 */',
      'const textTL = openAt("text", 100, 100);',
      '/* 复原状态，避免污染后续用例：',
      '   A2 依赖"上一步已打开一个文字编辑器"，这里补开一个。 */',
      'setTool("text");',
      'fire("pointerdown", 300, 300); fire("pointerup", 300, 300);',
      'return { textBR, noteBR, textTL };',
    ].join('\n'));
    console.log('  A1b. 编辑器边界约束: ' + JSON.stringify(r));
    check('文字编辑器右下角不越界（右）', r.textBR.right <= r.textBR.stageRight, r.textBR);
    check('文字编辑器右下角不越界（下）', r.textBR.bottom <= r.textBR.stageBottom, r.textBR);
    check('便签编辑器右下角不越界（右）', r.noteBR.right <= r.noteBR.stageRight, r.noteBR);
    check('便签编辑器右下角不越界（下）', r.noteBR.bottom <= r.noteBR.stageBottom, r.noteBR);
    check('便签编辑器尺寸随纸片（非 74px 小框）', r.noteBR.height > 100, r.noteBR);
    check('左上角正常位置不被挪动', r.textTL.right < r.textTL.stageRight * 0.8, r.textTL);
  }

  /* ============ A2. 在编辑器里输入并提交 ============ */
  {
    const r = await js([
      'const { store } = window.__inkwell;',
      'const ed = document.getElementById("textEditor");',
      'const ta = document.getElementById("textInput");',
      'const opened = !ed.hidden;',
      'ta.value = "真实场景文字";',
      'ta.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", ctrlKey:true, bubbles:true, cancelable:true }));',
      'return { opened, count: store.shapes.length, text: store.shapes[0] && store.shapes[0].text, hidden: ed.hidden };',
    ].join('\n'));
    console.log('  A2. 输入并提交: ' + JSON.stringify(r));
    check('编辑器确实开着（上一步没被误关）', r.opened, r);
    check('提交成功生成 text 图形', r.count === 1 && r.text === '真实场景文字', r);
  }

  /* ============ A3. 便签同样流程 ============ */
  {
    const r = await js([
      'const { store, setTool } = window.__inkwell;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const ed = document.getElementById("textEditor");',
      'const ta = document.getElementById("textInput");',
      'store.replaceAll([]); store.history.clear();',
      'setTool("note");',
      'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:2, pointerType:"mouse", isPrimary:true, bubbles:true }));',
      'fire("pointerdown", 500, 350); fire("pointerup", 500, 350);',
      'const opened = !ed.hidden;',
      'document.body.focus();',
      'const stillOpen = !ed.hidden;',
      'ta.value = "便签内容";',
      'ta.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", ctrlKey:true, bubbles:true, cancelable:true }));',
      'const notes = store.shapes.filter(s => s.type === "note");',
      'return { opened, stillOpen, notes: notes.length, text: notes[0] && notes[0].text };',
    ].join('\n'));
    console.log('  A3. 便签流程: ' + JSON.stringify(r));
    check('便签编辑器打开', r.opened, r);
    check('焦点转移后便签编辑器仍开着', r.stillOpen, r);
    check('便签创建成功', r.notes === 1 && r.text === '便签内容', r);
  }

  /* ============ A4. 编辑中点击画布应提交而非丢弃 ============ */
  {
    const r = await js([
      'const { store, setTool } = window.__inkwell;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const ta = document.getElementById("textInput");',
      'store.replaceAll([]); store.history.clear();',
      'setTool("text");',
      'const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: cr.left+x, clientY: cr.top+y, button:0, buttons:1, pointerId:3, pointerType:"mouse", isPrimary:true, bubbles:true }));',
      'fire("pointerdown", 300, 300); fire("pointerup", 300, 300);',
      'ta.value = "第一段";',
      '/* 不按键，直接点画布别处 */',
      'fire("pointerdown", 700, 500); fire("pointerup", 700, 500);',
      'return { count: store.shapes.length, texts: store.shapes.map(s=>s.text).join("|") };',
    ].join('\n'));
    console.log('  A4. 编辑中点画布: ' + JSON.stringify(r));
    check('编辑中点击画布会提交内容', r.count === 1 && r.texts === '第一段', r);
  }

  /* ============ B. 关闭确认走 HTML 弹框 ============ */
  {
    // 确保有未保存内容
    await js('window.__inkwell.state.dirty = true; return 1;');
    await js([
      'const { store } = window.__inkwell;',
      'if (!store.shapes.length) store.addShape({ id:"x", type:"rect", color:"#fff", fill:"transparent", fillEnabled:false, width:3, opacity:1, x:0, y:0, w:10, h:10 });',
      'return store.shapes.length;',
    ].join('\n'));
    await sleep(200);
    check('主进程已收到未保存标记', hasUnsavedChanges === true, { hasUnsavedChanges });

    // 触发 close
    confirmedSent = 0;
    triggerClose();
    await sleep(350);

    const shown = await js('return !document.getElementById("closeMask").hidden;');
    check('有未保存内容时弹出页面内确认框', shown === true, { shown });
    check('主进程发出了确认请求', confirmedSent === 1, { confirmedSent });

    // 点「取消」
    await js('document.getElementById("closeCancel").click(); return 1;');
    await sleep(250);
    const afterCancel = await js('return !document.getElementById("closeMask").hidden;');
    check('点「取消」后弹框关闭', afterCancel === false, { afterCancel });
    check('点「取消」后窗口未关闭', !mainWin.isDestroyed());
  }

  /* ============ B2. 点「不保存」应放行 ============ */
  {
    allowClose = false;
    triggerClose();
    await sleep(300);
    await js('document.getElementById("closeDiscard").click(); return 1;');
    await sleep(300);
    check('点「不保存」后主进程放行关闭', allowClose === true, { allowClose });
    const hidden = await js('return document.getElementById("closeMask").hidden;');
    check('点「不保存」后弹框关闭', hidden === true, { hidden });
  }

  /* ============ B3. 空画布（无未保存）应直接放行，不弹框 ============ */
  {
    hasUnsavedChanges = false;
    allowClose = false;
    const before = closePrevented;
    triggerClose();
    await sleep(250);
    check('无未保存内容时直接放行关闭', allowClose === true, { allowClose });
    check('无未保存内容时不弹确认框', closePrevented === before, { before, after: closePrevented });
  }

  /* ============ C. UI 可见性：hidden 必须真正生效 ============ */
  // 踩坑：`.modal-mask { display: grid }` 会压过浏览器默认的
  // `[hidden] { display: none }`，导致关闭遮罩**常驻全屏**，
  // 拦截一切页面内点击 → 表现为"编辑不了"+"一进去就弹窗"。
  {
    // 先恢复到启动状态（前面的用例可能改动过工具/面板）
    await js([
      'window.__inkwell.setTool("pen");',
      'document.getElementById("textEditor").hidden = true;',
      'return 1;',
    ].join('\n'));
    await sleep(120);

    const r = await js([
      'const ids = ["closeMask","toast","textGroup","textEditor","btnNoFill"];',
      'const out = {};',
      'for (const id of ids) {',
      '  const el = document.getElementById(id);',
      '  if (!el) { out[id] = "MISSING"; continue; }',
      '  const cs = getComputedStyle(el);',
      '  out[id] = { hasAttr: el.hasAttribute("hidden"), display: cs.display };',
      '}',
      'return out;',
    ].join('\n'));
    console.log('  C. 重置后隐藏元素: ' + JSON.stringify(r));
    for (const [id, v] of Object.entries(r)) {
      check(id + ' 隐藏时 display:none', v && v.display === 'none', v);
    }

    // 显示/隐藏切换必须有效
    const r2 = await js([
      'const m = document.getElementById("closeMask");',
      'm.hidden = false;',
      'const shown = getComputedStyle(m).display;',
      'm.hidden = true;',
      'const hid = getComputedStyle(m).display;',
      'return { shown, hid };',
    ].join('\n'));
    check('弹框设为可见时 display 正常', r2.shown !== 'none', r2.shown);
    check('弹框设为隐藏时 display:none', r2.hid === 'none', r2.hid);

    // 遮罩隐藏时不应拦截画布点击
    const r3 = await js([
      'const m = document.getElementById("closeMask");',
      'm.hidden = true;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const el = document.elementFromPoint(cr.left + 100, cr.top + 100);',
      'return { hit: el ? (el.id || el.tagName) : "none" };',
    ].join('\n'));
    check('遮罩隐藏时画布可被点击命中', r3.hit === 'canvas', r3);

    // 遮罩可见时应当拦截点击（这是它存在的意义）
    const r4 = await js([
      'const m = document.getElementById("closeMask");',
      'm.hidden = false;',
      'const c = document.getElementById("canvas");',
      'const cr = c.getBoundingClientRect();',
      'const el = document.elementFromPoint(cr.left + 100, cr.top + 100);',
      'const inside = m.contains(el);',
      'm.hidden = true;',
      'return { hit: el ? (el.id || el.className || el.tagName) : "none", inside };',
    ].join('\n'));
    check('遮罩可见时拦截页面点击', r4.inside === true, r4);

    // 色板共用：填充工具下改填充色，其余工具改描边色
    const r5 = await js([
      'const { setTool, state } = window.__inkwell;',
      'const btn = document.getElementById("btnNoFill");',
      'const label = document.getElementById("colorLabel");',
      'const show = (el) => getComputedStyle(el).display !== "none";',
      'const pressure = document.getElementById("pressureGroup");',
      'setTool("fill");',
      'const btnShow = show(btn);',
      'const labelFill = label.textContent;',
      'const sw = document.querySelector(".swatch[data-color=\\"#ff5f6b\\"]");',
      'sw.click();',
      'const fillVal = state.style.fill;',
      'const strokeAfterFillSwatch = state.style.color;',
      'setTool("pen");',
      'const btnHid = show(btn);',
      'const labelPen = label.textContent;',
      'sw.click();',
      'const strokeVal = state.style.color;',
      'const fillAfterPenSwatch = state.style.fill;',
      'const penPressure = show(pressure);',
      'return { btnShow, btnHid, labelFill, labelPen, fillVal, strokeVal,',
      '         strokeAfterFillSwatch, fillAfterPenSwatch, penPressure };',
    ].join('\n'));
    check('填充工具显示「清除填充」按钮', r5.btnShow === true, r5);
    check('非填充工具隐藏「清除填充」按钮', r5.btnHid === false, r5);
    check('填充工具下色板标签为「填充色」', r5.labelFill === '填充色', r5);
    check('画笔工具下色板标签为「颜色」', r5.labelPen === '颜色', r5);
    check('填充工具点色板改填充色', r5.fillVal === '#ff5f6b', r5);
    check('填充工具点色板不动描边色', r5.strokeAfterFillSwatch === '#e8ecf4', r5);
    check('画笔工具点色板改描边色', r5.strokeVal === '#ff5f6b', r5);
    check('画笔工具点色板不动填充色', r5.fillAfterPenSwatch === '#ff5f6b', r5);
    check('画笔工具显示压感面板', r5.penPressure === true, r5);

    // 便签不得污染全局填充色（历史 bug：切便签会把 fill 改成黄色并开启填充）
    const r6 = await js([
      'const { setTool, state } = window.__inkwell;',
      'setTool("rect");',
      'state.style.fill = "#4c8dff";',
      'setTool("note");',
      'const afterNote = { fill: state.style.fill, enabled: state.style.fillEnabled };',
      'setTool("rect");',
      'return { afterNote };',
    ].join('\n'));
    check('切便签不改全局填充色', r6.afterNote.fill === '#4c8dff', r6.afterNote);
    check('切便签不打开全局填充开关', !r6.afterNote.enabled, r6.afterNote);
  }

  if (errors.length) {
    console.log('\n渲染进程错误:');
    errors.slice(0, 5).forEach((e) => console.log('    ' + e));
    fail += errors.length;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  app.exit(fail ? 1 : 0);
});
