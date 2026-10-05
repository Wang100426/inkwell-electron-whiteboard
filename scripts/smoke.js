'use strict';

/**
 * 冒烟测试：以真实 Electron 环境启动白板，模拟绘制 → 校验 → 截图。
 * 用法：npm run smoke
 *
 * 说明：渲染进程通过 window.__inkwell 暴露内部状态供本脚本访问，
 *      因为 bundle 顶层的 const 属于块级作用域，executeJavaScript 取不到。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT_WINDOW = path.join(ROOT, 'smoke-output.png');
const OUT_BOARD = path.join(ROOT, 'smoke-board.png');
let exitCode = 0;

const t0 = Date.now();
const log = (m) => console.log('[' + String(Date.now() - t0).padStart(6) + 'ms] ' + m);

setTimeout(() => {
  log('!! 全局超时（150s），强制退出');
  app.exit(2);
}, 150000);

process.on('unhandledRejection', (e) => log('未处理异常: ' + (e && e.message ? e.message : e)));

// 必须早于 app ready 设置，否则不生效
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

ipcMain.handle('app:info', () => ({ version: '1.0.0', platform: process.platform, electron: process.versions.electron }));

/** 在渲染进程执行代码并返回结果，失败时抛出可读异常 */
async function run(win, label, code) {
  try {
    return await win.webContents.executeJavaScript(`(() => { ${code} })()`);
  } catch (e) {
    throw new Error(label + ' 执行失败: ' + e.message);
  }
}

app.whenReady().then(async () => {
  log('app ready');

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level >= 2) errors.push(e.message);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('渲染进程崩溃: ' + JSON.stringify(d)));

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  log('页面已加载');
  await new Promise((r) => setTimeout(r, 1000));

  try {
    /* ---------- 1. DOM / 引擎就绪 ---------- */
    const probe = await run(win, 'DOM 探针', `
      return {
        hasCanvas: !!document.getElementById('canvas'),
        toolCount: document.querySelectorAll('.tool').length,
        swatchCount: document.querySelectorAll('.swatch').length,
        engineReady: typeof window.__inkwell === 'object' && !!window.__inkwell.store,
        canvasW: document.getElementById('canvas').width,
        activeTool: document.querySelector('.tool.active') ? document.querySelector('.tool.active').dataset.tool : null,
      };
    `);
    log('DOM 探针: ' + JSON.stringify(probe));
    if (!probe.hasCanvas || probe.toolCount !== 11 || !probe.engineReady) throw new Error('DOM/引擎探针未通过');

    /* ---------- 2. 模拟绘制 ---------- */
    const paint = await run(win, '绘制探针', `
      const { store, renderer, setTool } = window.__inkwell;
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        clientX: r.left + x, clientY: r.top + y, button: 0,
        pointerId: 1, bubbles: true, isPrimary: true
      }));
      const setRange = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      setTool('pen');
      fire('pointerdown', 250, 300);
      for (let i = 0; i <= 24; i++) fire('pointermove', 250 + i * 11, 300 + Math.sin(i / 2.2) * 52);
      fire('pointerup', 515, 300);

      setTool('rect');
      fire('pointerdown', 610, 245);
      fire('pointermove', 890, 415);
      fire('pointerup', 890, 415);

      // 填充改由独立的「填充」工具完成：选工具 → 共用画笔色板选色 → 点图形
      setTool('fill');
      document.querySelector('.swatch[data-color="#4c8dff"]').click();
      fire('pointerdown', 750, 330);
      fire('pointerup', 750, 330);

      setTool('arrow');
      document.querySelector('.swatch[data-color="#38d39f"]').click();
      setRange('widthRange', 5);
      fire('pointerdown', 645, 330);
      fire('pointermove', 870, 330);
      fire('pointerup', 870, 330);

      setTool('text');
      store.addShape({ id:'t1', type:'text', color:'#ffc93d', fill:'transparent', fillEnabled:false,
        width:3, opacity:1, x:245, y:462, text:'InkWell 白板', fontSize:36, fontFamily:'Segoe UI', align:'left' });

      // 便签：现在由编辑器浮层创建（不再是拖拽矩形）
      setTool('note');
      fire('pointerdown', 940, 465);
      fire('pointerup', 940, 465);
      const ta = document.getElementById('textInput');
      ta.value = '待办：\\n1. 补文档\\n2. 打包发布';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', ctrlKey:true, bubbles:true }));
      const note = store.shapes[store.shapes.length - 1];
      if (note && note.type !== 'note') throw new Error('便签创建失败');

      // 橡皮：从便签中间横穿过去，验证它被真正删除（矢量擦除，非渲染遮罩）
      const beforeErase = store.shapes.length;
      setTool('eraser');
      // 便签矩形：x=940, y=465, w=220, h=160 → 中心约 (1050, 545)
      fire('pointerdown', 1000, 545);
      for (let i = 0; i <= 12; i++) fire('pointermove', 1000 + i * 8, 545);
      fire('pointerup', 1096, 545);
      const afterErase = store.shapes.length;

      return {
        shapes: afterErase,
        types: store.shapes.map(s => s.type).join(','),
        selection: state.selection.length,
        hasEraserShape: store.shapes.some(s => s.type === 'eraser'),
        erased: beforeErase - afterErase,
      };
    `);
    log('绘制探针: ' + JSON.stringify(paint));
    if (paint.shapes !== 4) throw new Error('图形数量异常（应剩 4 个）: ' + paint.shapes);
    if (paint.hasEraserShape) throw new Error('橡皮不应作为图形存在于 shapes 中');
    if (paint.erased !== 1) throw new Error('橡皮应删除恰好 1 个图形，实际 ' + paint.erased);
    if (paint.selection !== 0) throw new Error('绘制后不应残留选中状态: ' + paint.selection);

    /* ---------- 3. 撤销 / 重做 ---------- */
    const hist = await run(win, '撤销重做', `
      const { store } = window.__inkwell;
      const before = store.shapes.length;
      const beforeJson = JSON.stringify(store.shapes);
      document.getElementById('btnUndo').click();
      const afterUndo = store.shapes.length;
      const afterUndoJson = JSON.stringify(store.shapes);
      document.getElementById('btnRedo').click();
      const afterRedo = store.shapes.length;
      const afterRedoJson = JSON.stringify(store.shapes);
      return { before, afterUndo, afterRedo,
               undoChanged: beforeJson !== afterUndoJson,
               redoRestored: beforeJson === afterRedoJson };
    `);
    log('撤销重做: ' + JSON.stringify(hist));
    // 撤销可能让笔迹"复原"（分段合并回一条），所以数量可能增加，关键是数据变化正确
    if (!hist.undoChanged) throw new Error('撤销未产生变化');
    if (!hist.redoRestored) throw new Error('重做未恢复到操作前状态');
    if (hist.afterRedo !== hist.before) throw new Error('重做后图形数应与操作前一致');

    /* ---------- 4. 像素校验（小尺寸离屏重绘） ---------- */
    const px = await run(win, '像素校验', `
      const { store, renderer } = window.__inkwell;
      const c = renderer.exportPNG(store.shapes, { scale: 0.3, background: '#0f1115' });
      if (!c) return { error: 'exportPNG 返回空' };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonBg = 0, colored = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        if (Math.abs(r-15) > 14 || Math.abs(g-17) > 14 || Math.abs(b-21) > 14) {
          nonBg++;
          if (Math.max(r,g,b) - Math.min(r,g,b) > 40) colored++;
        }
      }
      return { w: c.width, h: c.height, nonBg, colored };
    `);
    log('像素校验: ' + JSON.stringify(px));
    if (px.error || px.nonBg < 200 || px.colored < 30) throw new Error('渲染内容异常: ' + JSON.stringify(px));

    /* ---------- 5. 矢量擦除语义（数据层裁剪） ---------- */
    const eraser = await run(win, '橡皮校验', `
      const { store, renderer, state } = window.__inkwell;
      // 构造场景：两条长笔迹，y=100 与 y=300，点足够密以便分段
      const mk = (id, y) => ({
        id, type:'pen', color:'#ffffff', fill:'transparent', fillEnabled:false, width:4, opacity:1,
        points: Array.from({length:31}, (_, i) => ({ x: 100 + i*10, y })),
      });
      store.replaceAll([mk('p1', 100), mk('p2', 300)]);
      const before = store.shapes.length;

      // 模拟一次真实擦除：从 y=100 的笔迹中间横穿
      const { applyErase } = window.__inkwell;
      const r = applyErase(store.shapes, [{x1:240,y1:70,x2:280,y2:130}], 30);
      const p1parts = r.shapes.filter(s => s.id.startsWith('p1')).length;
      const p2alive = r.shapes.some(s => s.id === 'p2');
      const hasEraser = r.shapes.some(s => s.type === 'eraser');
      const p1pts = r.shapes.filter(s => s.id.startsWith('p1')).reduce((a,s)=>a+s.points.length,0);

      return { before, after: r.shapes.length, p1parts, p2alive, hasEraser, changed: r.changed, p1pts };
    `);
    log('矢量擦除校验: ' + JSON.stringify(eraser));
    if (eraser.hasEraser) throw new Error('擦除结果中不应含 eraser 图形');
    if (eraser.p1parts < 2) throw new Error('被擦的笔迹应断成多段，实际 ' + eraser.p1parts);
    if (!eraser.p2alive) throw new Error('未接触的笔迹不应受影响');
    if (eraser.p1pts >= 31) throw new Error('被擦笔迹的点数应减少（部分被擦掉）');
    log('矢量擦除正确 ✓（数据层裁剪，无 eraser 图形残留）');

    /* ---------- 6. 橡皮撤销 ---------- */
    const eraserUndo = await run(win, '橡皮撤销', `
      const { store, setTool, renderer } = window.__inkwell;
      const c = document.getElementById('canvas');
      const rect = c.getBoundingClientRect();
      // 世界 → 屏幕（clientX/Y）：renderer.toScreen 给的是 canvas 内坐标，
      // 还需加上 canvas 在视口中的位置，这才是 PointerEvent 用的坐标系。
      const toClient = (wx, wy) => {
        const s = renderer.toScreen(wx, wy);
        return { x: rect.left + s.x, y: rect.top + s.y };
      };
      const fireScreen = (t, wx, wy) => {
        const p = toClient(wx, wy);
        c.dispatchEvent(new PointerEvent(t,{clientX:p.x, clientY:p.y, button:0, pointerId:1, bubbles:true, isPrimary:true}));
      };
      // 校验坐标映射是否合理
      const probe = toClient(100, 200);

      store.replaceAll([
        { id:'q1', type:'pen', color:'#ffffff', fill:'transparent', fillEnabled:false, width:6, opacity:1,
          points: Array.from({length:21}, (_, i) => ({ x: 100 + i*20, y: 200 })) },
      ]);
      const before = JSON.stringify(store.shapes);
      setTool('eraser');
      fireScreen('pointerdown', 240, 200);
      for (let i=0;i<=8;i++) fireScreen('pointermove', 240+i*5, 200);
      fireScreen('pointerup', 280, 200);
      const afterErase = JSON.stringify(store.shapes);
      const changed = before !== afterErase;
      const p1parts = store.shapes.filter(s => s.id.startsWith('q1')).length;
      document.getElementById('btnUndo').click();
      const afterUndo = JSON.stringify(store.shapes);
      document.getElementById('btnRedo').click();
      const afterRedo = JSON.stringify(store.shapes);
      return { changed, p1parts, undoRestored: afterUndo === before, redoReapplied: afterRedo === afterErase,
               probe: { x: Math.round(probe.x), y: Math.round(probe.y) },
               rect: { l: Math.round(rect.left), t: Math.round(rect.top) } };
    `);
    log('橡皮撤销校验: ' + JSON.stringify(eraserUndo));
    if (!eraserUndo.changed) throw new Error('擦除未生效');
    if (eraserUndo.p1parts < 2) throw new Error('笔迹未断成多段: ' + eraserUndo.p1parts);
    if (!eraserUndo.undoRestored) throw new Error('撤销未恢复被擦除的图形');
    if (!eraserUndo.redoReapplied) throw new Error('重做未重新应用擦除');
    log('橡皮撤销/重做正确 ✓');

    /* ---------- 6. 还原演示场景并导出 ---------- */
    const paint2 = await run(win, '演示场景', `
      const { store, state, renderer, setTool } = window.__inkwell;
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        clientX: r.left + x, clientY: r.top + y, button: 0, pointerId: 1, bubbles: true, isPrimary: true }));
      const setRange = (id, v) => { const el=document.getElementById(id); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); };
      const setColor = (hex) => document.querySelector('.swatch[data-color="'+hex+'"]').click();
      store.replaceAll([]);

      setTool('pen');
      setColor('#e8ecf4');           // 白色笔迹
      setRange('widthRange', 4);
      fire('pointerdown', 250, 300);
      for (let i=0;i<=24;i++) fire('pointermove', 250+i*11, 300+Math.sin(i/2.2)*52);
      fire('pointerup', 515, 300);

      setTool('rect');
      setColor('#4c8dff');           // 蓝框
      setRange('widthRange', 3);
      fire('pointerdown', 610, 245);
      fire('pointermove', 890, 415);
      fire('pointerup', 890, 415);

      // 填充工具上色（复用画笔色板）
      setTool('fill');
      document.querySelector('.swatch[data-color="#4c8dff"]').click();
      fire('pointerdown', 750, 330);
      fire('pointerup', 750, 330);

      setTool('arrow');
      setColor('#38d39f');           // 绿箭头
      setRange('widthRange', 5);
      fire('pointerdown', 645, 330);
      fire('pointermove', 870, 330);
      fire('pointerup', 870, 330);

      store.addShape({ id:'t1', type:'text', color:'#ffc93d', fill:'transparent', fillEnabled:false,
        width:3, opacity:1, x:245, y:462, text:'InkWell 白板', fontSize:36, align:'left' });

      setTool('note');                // 点击即弹出编辑器
      fire('pointerdown', 940, 465);
      fire('pointerup', 940, 465);
      const ta = document.getElementById('textInput');
      ta.value = '待办：\\n1. 补文档\\n2. 打包发布';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', ctrlKey:true, bubbles:true }));
      const note = store.shapes[store.shapes.length-1];
      if (!note || note.type !== 'note') throw new Error('演示便签创建失败');

      setTool('pen');
      setColor('#e8ecf4');
      return { shapes: store.shapes.length, types: store.shapes.map(s=>s.type).join(','),
               colors: store.shapes.map(s=>s.color).join(',') };
    `);
    log('演示场景: ' + JSON.stringify(paint2));

    /* ---------- 7. 导出画布内容图 ---------- */
    const dataUrl = await run(win, '导出画布', `
      const { store, renderer } = window.__inkwell;
      const c = renderer.exportPNG(store.shapes, { scale: 1, background: '#0f1115' });
      return c ? c.toDataURL('image/png') : null;
    `);
    if (dataUrl) {
      fs.writeFileSync(OUT_BOARD, Buffer.from(dataUrl.split(',')[1], 'base64'));
      log('画布内容图: ' + OUT_BOARD + ' (' + fs.statSync(OUT_BOARD).size + ' bytes)');
    }

    /* ---------- 8. 窗口截图 ---------- */
    const img = await win.webContents.capturePage();
    if (img && !img.isEmpty()) {
      fs.writeFileSync(OUT_WINDOW, img.toPNG());
      log('窗口截图: ' + OUT_WINDOW + ' (' + fs.statSync(OUT_WINDOW).size + ' bytes)');
    }

    if (errors.length) {
      log('渲染进程错误: ' + JSON.stringify(errors));
      exitCode = 1;
    } else {
      log('渲染进程无报错 ✓');
    }
    log('全部检查通过');
  } catch (err) {
    console.error('\n✗ 冒烟测试失败: ' + err.message);
    exitCode = 1;
  }

  app.exit(exitCode);
});
