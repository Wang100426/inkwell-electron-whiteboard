'use strict';

/**
 * 手写笔压感端到端测试：模拟真实笔迹（压力由轻到重再到轻），
 * 验证图形数据里每个点的宽度确实变化，且渲染像素有粗细差异。
 * 用法：electron scripts/test-pressure-e2e.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('no-sandbox');

ipcMain.handle('app:info', () => ({ version: '1.2.0', platform: process.platform, electron: process.versions.electron }));
/* 1.2.0 无边框窗口：渲染层会查询最大化状态，测试环境补个 stub 避免报错 */
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:maximize', () => {});
ipcMain.on('window:close', () => {});
ipcMain.on('app:health', () => {});

let pass = 0;
let fail = 0;

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

app.whenReady().then(async () => {
  const ROOT = path.join(__dirname, '..');
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  const errors = [];
  win.webContents.on('console-message', (...a) => {
    const d = a[0];
    if (d && typeof d === 'object' && 'message' in d && (d.level ?? 0) >= 2) errors.push(d.message);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const js = async (code, label) => {
    const r = await win.webContents.executeJavaScript(
      '(() => { try { ' + code + '\n} catch(err) { return { __err: err.message, __stack: (err.stack||"").split("\\n").slice(0,4) }; } })()'
    );
    if (r && r.__err) {
      console.log('  \u2717 ' + (label || '未命名') + ' 执行失败: ' + r.__err);
      (r.__stack || []).forEach((l) => console.log('      ' + l.trim()));
      fail++;
      return null;
    }
    return r;
  };

  console.log('\n手写笔压感端到端测试\n');

  try {
    /* ---------- 1. 模拟手写笔画：压力由轻→重→轻 ---------- */
    const r1 = await js(
      'const { store, renderer, state, setTool } = window.__inkwell;'
      + 'const c = document.getElementById("canvas");'
      + 'const cr = c.getBoundingClientRect();'
      + 'store.replaceAll([]); store.history.clear();'
      + 'setTool("pen");'
      + "/* 笔压曲线：轻 → 重 → 轻 */"
      + 'const pressAt = (t) => 0.15 + 0.8 * Math.sin(Math.PI * t);'
      + 'let pid = 100;'
      + 'const fire = (type, t, pressure) => {'
      + '  const x = 200 + t * 500, y = 400;'
      + '  c.dispatchEvent(new PointerEvent(type, {'
      + '    clientX: cr.left + x, clientY: cr.top + y, button: 0, buttons: 1,'
      + '    pointerId: pid, pointerType: "pen", pressure, isPrimary: true, bubbles: true }));'
      + '};'
      + 'fire("pointerdown", 0, pressAt(0));'
      + 'for (let i = 1; i <= 40; i++) fire("pointermove", i / 40, pressAt(i / 40));'
      + 'fire("pointerup", 1, 0);'
      + 'const s = store.shapes[0];'
      + 'if (!s) return { _fail: "笔迹未生成", shapes: store.shapes.length,'
      + '  tool: state.tool, ps: state.style.pressureSensitive };'
      + 'const ws = s.points.map(p => p.w).filter(v => typeof v === "number");'
      + 'return {'
      + '  count: store.shapes.length, type: s && s.type,'
      + '  pressureSensitive: s && s.pressureSensitive,'
      + '  points: s ? s.points.length : 0,'
      + '  widths: ws.length,'
      + '  minW: Math.min(...ws), maxW: Math.max(...ws),'
      + '  device: state.activePointerType,'
      + '};'
    , "压感笔迹数据");
    if (r1) {
      if (r1._fail) {
        console.log('  \u2717 压感笔迹数据: ' + r1._fail + ' ' + JSON.stringify(r1));
        fail++;
      } else {
        check('手写笔生成 pen 图形', r1.count === 1 && r1.type === 'pen', r1);
        check('标记为压感笔迹', r1.pressureSensitive === true, r1);
        check('每个采样点都有宽度', r1.widths === r1.points, { widths: r1.widths, points: r1.points });
        check('宽度随压力变化（max > min）', r1.maxW > r1.minW * 1.5, { minW: r1.minW, maxW: r1.maxW });
        check('识别为手写笔设备', r1.device === 'pen', r1.device);
      }
    }

    /* ---------- 2. 压力曲线形状：中间粗两端细 ---------- */
    const r2 = await js(
      'const s = window.__inkwell.store.shapes[0];'
      + 'const ws = s.points.map(p => p.w);'
      + 'const mid = Math.floor(ws.length / 2);'
      + 'return { first: ws[0], last: ws[ws.length - 1], middle: ws[mid],'
      + '         firstHalfMax: Math.max(...ws.slice(0, mid)),'
      + '         secondHalfMax: Math.max(...ws.slice(mid)) };'
    , "压力曲线形状");
    check('起笔较轻', r2.first < r2.middle, r2);
    check('收笔较轻', r2.last < r2.middle, r2);
    check('中段最粗（压力峰值在中点）', r2.middle >= r2.firstHalfMax - 0.5 && r2.middle >= r2.secondHalfMax - 0.5, r2);

    /* ---------- 3. 像素验证：渲染出的粗细真的有差异 ---------- */
    const r3 = await js(
      'const { store, renderer } = window.__inkwell;'
      + 'const c = renderer.exportPNG(store.shapes, { scale: 1, background: "#0f1115" });'
      + 'const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;'
      + 'const b = c.__bounds;'
      + "/* 测量笔迹在垂直方向的粗细分布：左端(轻) / 中段(重) */"
      + 'const measure = (wx) => {'
      + '  const px = Math.round(wx - b.x);'
      + '  if (px < 0 || px >= c.width) return 0;'
      + '  let count = 0;'
      + '  for (let py = 0; py < c.height; py++) {'
      + '    const i = (py * c.width + px) * 4;'
      + '    const r = d[i], g = d[i+1], bl = d[i+2];'
      + '    if (Math.abs(r - 15) > 20 || Math.abs(g - 17) > 20 || Math.abs(bl - 21) > 20) count++;'
      + '  }'
      + '  return count;'
      + '};'
      + 'return { light: measure(210), heavy: measure(450) };'
    , "像素粗细差异");
    check('渲染后轻压处明显更细', r3.light < r3.heavy, r3);
    check('轻压处有实际像素（非空）', r3.light > 0, r3);

    /* ---------- 4. 鼠标绘制仍为等宽（不回归） ---------- */
    const r4 = await js(
      'const { store, setTool } = window.__inkwell;'
      + 'const c = document.getElementById("canvas");'
      + 'const cr = c.getBoundingClientRect();'
      + 'store.replaceAll([]); store.history.clear();'
      + 'setTool("pen");'
      + 'const fire = (type, x, pressure) => c.dispatchEvent(new PointerEvent(type, {'
      + '  clientX: cr.left + x, clientY: cr.top + 500, button: 0, buttons: 1,'
      + '  pointerId: 200, pointerType: "mouse", pressure, isPrimary: true, bubbles: true }));'
      + 'fire("pointerdown", 200, 0.5);'
      + 'for (let i = 1; i <= 20; i++) fire("pointermove", 200 + i * 15, 0.5);'
      + 'fire("pointerup", 500, 0.5);'
      + 'const s = store.shapes[0];'
      + 'const ws = s.points.map(p => p.w).filter(v => typeof v === "number");'
      + 'return {'
      + '  pressureSensitive: s && s.pressureSensitive,'
      + '  uniqueWidths: ws.length ? new Set(ws.map(v => Math.round(v))).size : 0,'
      + '  device: window.__inkwell.state.activePointerType };'
    , '鼠标等宽');
    check('鼠标绘制不走变宽路径', r4.pressureSensitive === false, r4);
    check('鼠标笔迹宽度基本一致', r4.uniqueWidths <= 1, r4);
    check('鼠标设备识别正确', r4.device === 'mouse', r4.device);

    /* ---------- 5. 保存 / 加载后压感保留 ---------- */
    const r5 = await js(
      'const { store } = window.__inkwell;'
      + 'store.replaceAll([]); store.history.clear();'
      + 'store.addShape({ id:"p", type:"pen", color:"#fff", fill:"transparent", fillEnabled:false,'
      + '  width:3, opacity:1, pressureSensitive:true, pressureMax:20,'
      + '  points:[{x:0,y:0,w:2},{x:10,y:0,w:9},{x:20,y:0,w:18}] });'
      + "/* 序列化往返（模拟保存 → 打开） */"
      + 'const json = JSON.stringify(store.toJSON());'
      + 'store.loadJSON(json);'
      + 'const s = store.shapes[0];'
      + 'return { pressureSensitive: s.pressureSensitive, pressureMax: s.pressureMax,'
      + '         widths: s.points.map(p => p.w) };'
    , "保存加载往返");
    check('读档后仍标记为压感笔迹', r5.pressureSensitive === true, r5);
    check('读档后最大宽度保留', r5.pressureMax === 20, r5);
    check('读档后每点宽度保留', JSON.stringify(r5.widths) === '[2,9,18]', r5.widths);

    /* ---------- 6. UI：压感面板仅在画笔/橡皮时显示 ---------- */
    const r6 = await js(
      'const { setTool } = window.__inkwell;'
      + 'const pg = document.getElementById("pressureGroup");'
      + 'setTool("pen");   const penVisible = !pg.hidden;'
      + 'setTool("rect");  const rectHidden = pg.hidden;'
      + 'setTool("pen");'
      + 'const label = document.getElementById("pressureDevice").textContent;'
      + 'return { penVisible, rectHidden, label };'
    , "UI面板");
    check('画笔工具下压感面板可见', r6.penVisible, r6);
    check('非绘画工具下压感面板隐藏', r6.rectHidden, r6);
    check('设备标签已更新', typeof r6.label === 'string' && r6.label.length > 0, r6);

    /* ---------- 7. 压感开关关闭后为等宽 ---------- */
    const r7 = await js(
      'const { store, setTool, state } = window.__inkwell;'
      + 'const c = document.getElementById("canvas");'
      + 'const cr = c.getBoundingClientRect();'
      + 'store.replaceAll([]); store.history.clear();'
      + 'const toggle = document.getElementById("pressureToggle");'
      + 'toggle.checked = false;'
      + 'toggle.dispatchEvent(new Event("change", { bubbles: true }));'
      + 'setTool("pen");'
      + 'let pid = 300;'
      + 'const fire = (type, x, pressure) => c.dispatchEvent(new PointerEvent(type, {'
      + '  clientX: cr.left + x, clientY: cr.top + 300, button: 0, buttons: 1,'
      + '  pointerId: pid, pointerType: "pen", pressure, isPrimary: true, bubbles: true }));'
      + 'fire("pointerdown", 200, 0.2);'
      + 'for (let i = 1; i <= 20; i++) fire("pointermove", 200 + i * 15, 0.9);'
      + 'fire("pointerup", 500, 0.9);'
      + 'const s = store.shapes[0];'
      + 'toggle.checked = true;'
      + 'toggle.dispatchEvent(new Event("change", { bubbles: true }));'
      + 'return { pressureSensitive: s && s.pressureSensitive };'
    , "压感开关");
    check('关闭压感后笔迹为等宽', r7.pressureSensitive === false, r7);

    /* ---------- 8. 笔杆橡皮端 ---------- */
    const r8 = await js(
      'const { store, setTool } = window.__inkwell;'
      + 'const c = document.getElementById("canvas");'
      + 'const cr = c.getBoundingClientRect();'
      + 'store.replaceAll([]); store.history.clear();'
      + 'setTool("pen");'
      + "/* 先画一条笔迹 */"
      + 'const fire = (type, x, y, extra) => c.dispatchEvent(new PointerEvent(type, Object.assign({'
      + '  clientX: cr.left + x, clientY: cr.top + y, button: 0, buttons: 1,'
      + '  pointerId: 400, pointerType: "pen", pressure: 0.6, isPrimary: true, bubbles: true }, extra)));'
      + 'fire("pointerdown", 200, 200);'
      + 'for (let i = 1; i <= 20; i++) fire("pointermove", 200 + i * 20, 200, { pressure: 0.6 });'
      + 'fire("pointerup", 600, 200);'
      + 'const afterDraw = store.shapes.length;'
      + "/* 笔杆橡皮端：buttons 含 32 (0x20)，笔尖朝下时触发 */"
      + 'const fireE = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {'
      + '  clientX: cr.left + x, clientY: cr.top + y, button: 5, buttons: 32,'
      + '  pointerId: 401, pointerType: "pen", pressure: 0.5, isPrimary: true, bubbles: true }));'
      + 'fireE("pointerdown", 400, 200);'
      + 'for (let i = 0; i <= 8; i++) fireE("pointermove", 400 + i * 10, 200);'
      + 'fireE("pointerup", 480, 200);'
      + 'return { afterDraw, afterBarrel: store.shapes.length,'
      + '  parts: store.shapes.filter(s => s.id.startsWith("s") || s.points).length };'
      , "笔杆橡皮端");
    if (r8) {
      // 橡皮端生效的判据：笔迹被矢量擦除切断（段数变多），而非图形数减少
      check('笔杆橡皮端触发擦除（笔迹被切断）', r8.parts > 1, r8);
      check('笔杆橡皮端产生多段笔迹', r8.parts >= 2, r8);
    }

    if (errors.length) {
      console.log('\n渲染进程错误:');
      errors.slice(0, 5).forEach((e) => console.log('    ' + e));
      fail += errors.length;
    }
  } catch (err) {
    console.error('\n执行异常: ' + err.message);
    fail++;
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  app.exit(fail ? 1 : 0);
});
