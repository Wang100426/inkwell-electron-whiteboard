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

ipcMain.handle('app:info', () => ({ version: '1.3.3', platform: process.platform, electron: process.versions.electron }));
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
    /*
     * 便签的黄色不再是"图形数据"：fill 存 transparent，
     * 颜色由 drawShape 的 note 分支按类型补 NOTE_COLOR。
     * 这样黄色在 shapes 里根本不存在，也就不可能被别人继承。
     */
    check('便签不在数据里存黄色（改由类型决定）', r.fill === 'transparent', r);
    check('便签带填充标记（渲染时画纸片底色）', r.enabled === true, r);
  }

  /* ---------- 3b. 完整真实序列：上色 → 便签 → 回到填充 ---------- */
  /*
   * 用户报障："填充了一个颜色以后，使用便签，然后回来原本填充的颜色
   * 变成了便签的黄色"。
   *
   * 上面第 2 组只测了"切工具"，这组把整条真实链路走完：
   *   矩形 → 填充工具选色 → 点矩形上色 → 便签（真的写一张）
   *   → 切回填充
   * 三层状态都要守住：工具填充色 / 已填图形的 fill / 便签自己的 fill。
   */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      // 1. 画矩形
      'setTool("rect");',
      'const rect = drawRect(200, 200, 420, 360);',
      // 2. 填充工具，用色板选一个明确的绿色，然后点矩形上色
      'setTool("fill");',
      'pickFill("#38d39f");',
      'fire("pointerdown", 310, 280); fire("pointerup", 310, 280);',
      'const filled = { styleFill: state.style.fill, rectFill: rect.fill, rectOn: rect.fillEnabled };',
      // 3. 便签：真的写一张（Ctrl+Enter 提交）
      'setTool("note");',
      'const colorHiddenForNote = document.getElementById("colorGroup").hidden;',
      'fire("pointerdown", 700, 300); fire("pointerup", 700, 300);',
      'const ta = document.getElementById("textInput");',
      'ta.value = "便签内容";',
      'ta.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", ctrlKey:true, bubbles:true }));',
      'const note = store.shapes.find(s => s.type === "note");',
      // 4. 回到填充
      'setTool("fill");',
      'const sw = document.querySelector(".swatch.active");',
      'return {',
      '  filled,',
      '  colorHiddenForNote,',
      '  noteFill: note && note.fill,',
      '  styleFillBack: state.style.fill,',
      '  rectFillBack: rect.fill,',
      '  rectOnBack: rect.fillEnabled,',
      '  activeSwatch: sw ? sw.dataset.color : null,',
      '  colorHex: document.getElementById("colorHex").textContent,',
      '  colorShownForFill: document.getElementById("colorGroup").hidden === false,',
      '};',
    ].join('\n'));

    // 上色这一步本身要成立
    check('上色后工具填充色 = 选的绿', r.filled && r.filled.styleFill === '#38d39f', r.filled);
    check('上色后矩形 fill = 选的绿', r.filled && r.filled.rectFill === '#38d39f', r.filled);
    check('上色后矩形 fillEnabled = true', r.filled && r.filled.rectOn === true, r.filled);

    // 便签这一步不能有任何回写
    check('便签不把黄色写进图形数据', r.noteFill === 'transparent', r.noteFill);
    check('便签工具下不显示颜色区（色板对它无效）', r.colorHiddenForNote === true, r.colorHiddenForNote);

    // 回到填充：工具状态与图形数据都没被污染
    check('回到填充后工具填充色未被污染', r.styleFillBack === '#38d39f', r.styleFillBack);
    check('回到填充后矩形填充色未被污染', r.rectFillBack === '#38d39f', r.rectFillBack);
    check('回到填充后矩形仍处于已填充', r.rectOnBack === true, r.rectOnBack);
    check('回到填充后色板高亮回到绿的色块', r.activeSwatch === '#38d39f', r.activeSwatch);
    check('回到填充后面板文字显示填充色', r.colorHex === '#38D39F', r.colorHex);
    check('回到填充后颜色区重新显示', r.colorShownForFill === true);
  }

  /* ---------- 3c. 填充色守卫生效（防未来回归） ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'setTool("fill");',
      // 直接模拟"被别的代码写脏成便签黄"
      'state.style.fill = "#f5c451";',
      // setTool 末尾会调 syncStyleUI，借它触发守卫
      'setTool("fill");',
      'return { fill: state.style.fill };',
    ].join('\n'));
    check('填充色一旦被污染成便签黄会自动回退', r.fill === '#4c8dff', r.fill);
  }

  /* ---------- 3d. 数据巡检：非便签图形带便签黄会被清掉 ---------- */
  /*
   * 用户报的"已填色的图形变成便签黄"如果真发生，说明有未知路径
   * 把这个色值串到了别的图形上。store 的 change 监听里有巡检，
   * 这里直接模拟一个"被串味"的矩形，确认会被当场纠正。
   */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'const rect = drawRect(200, 200, 400, 360);',
      'rect.fill = "#f5c451"; rect.fillEnabled = true;',
      'store.emit("edit");',              // 触发巡检
      'return { fill: rect.fill, on: rect.fillEnabled };',
    ].join('\n'));
    check('非便签图形带便签黄会被清成无填充', r.fill === 'transparent' && r.on === false, r);
  }

  /* ---------- 3e. 落盘数据里不含便签黄 ---------- */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'const mk = window.__inkwell.makeBase;',
      'const rect = Object.assign(mk("rect", state.style), { x: 200, y: 200, w: 200, h: 160 });',
      'rect.fill = "#38d39f"; rect.fillEnabled = true;',
      'store.addShape(rect);',
      'const note = Object.assign(mk("note", state.style), { x: 600, y: 200, w: 220, h: 160, text: "便签" });',
      'store.addShape(note);',
      'const json = JSON.stringify(store.toJSON());',
      'return { hasYellow: json.indexOf("f5c451") >= 0,',
      '         hasGreen: json.indexOf("38d39f") >= 0,',
      '         noteFill: note.fill };',
    ].join('\n'));
    check('落盘 JSON 里不含便签黄 f5c451', r.hasYellow === false, r);
    check('落盘 JSON 里保留了矩形的填充色', r.hasGreen === true, r);
    check('便签写入文件时 fill 为 transparent', r.noteFill === 'transparent', r.noteFill);
  }

  /* ---------- 3f. 便签仍然画成黄色纸片（数据不存色，渲染必须补上） ---------- */
  /*
   * 前面几条把黄色从数据里拿掉了。这条是**反向保险**：
   * 如果渲染分支没按类型补色，便签会变成透明/黑纸片 ——
   * 那比原 bug 更严重。直接取像素验。
   */
  {
    const r = await js(PRELUDE + [
      'store.replaceAll([]); store.history.clear();',
      'const mk = window.__inkwell.makeBase;',
      'const note = Object.assign(mk("note", state.style), { x: 0, y: 0, w: 220, h: 160, text: "便签" });',
      'const cv = window.__inkwell.renderer.exportPNG([note], { scale: 1, background: "#000000" });',
      'const ctx2 = cv.getContext("2d");',
      'const d = ctx2.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height * 0.75), 1, 1).data;',
      'return { w: cv.width, h: cv.height, r: d[0], g: d[1], b: d[2] };',
    ].join('\n'));
    // NOTE_COLOR = #f5c451 → rgb(245,196,81)
    check('便签仍然渲染成黄色纸片',
      r && r.r > 220 && r.g > 170 && r.g < 225 && r.b > 50 && r.b < 125, r);
  }


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

  /* ---------- 13. UI：填充工具在「图形」分组的变体区里 ---------- */
  {
    // 1.3.1 起：左侧栏只有 4 个分组按钮，填充属于「图形」分组，
    // 具体工具铺在面板顶部的 #variantGroup（不再有弹出浮层）。
    const r = await js([
      'const g = document.querySelector(".rail-tools .tool[data-group=\\"shape\\"]");',
      'if (!g) return { groupExists: false };',
      'g.click();',
      'const box = document.getElementById("variantGroup");',
      'const b = document.querySelector("#variantItems .variant-btn[data-tool=\\"fill\\"]");',
      'if (!b) return { groupExists: true, visible: !box.hidden, exists: false };',
      'const br = b.getBoundingClientRect();',
      'const el = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);',
      'return { groupExists: true, exists: true, visible: !box.hidden,',
      '         label: b.textContent.trim(),',
      '         hitSelf: !!(el && (el === b || b.contains(el))) };',
    ].join('\n'));
    check('图形分组变体区里有填充按钮', r.groupExists && r.exists === true, r);
    check('填充按钮标签 = 填充', r.label === '填充', r.label);
    check('变体区可见且填充按钮可点中', r.visible === true && r.hitSelf === true, r);
  }

  if (errors.length) {
    console.log('\n渲染进程错误:');
    errors.slice(0, 5).forEach((e) => console.log('    ' + e));
    fail += errors.length;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  app.exit(fail ? 1 : 0);
});
