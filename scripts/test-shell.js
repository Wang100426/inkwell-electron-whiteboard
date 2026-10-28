'use strict';

/**
 * 回归测试：1.3.0 无边框窗口 + 左侧栏精简为四个分组。
 *
 * 覆盖：
 *   A. 主进程窗口配置（无边框、标题栏隐藏、overlay 关闭）
 *   B. 自绘窗口控制按钮存在且接线正确（最小化/最大化/关闭走 IPC）
 *   C. 左侧栏布局：图标 / 撤销重做 / 缩放 / 工具 / 网格·导出·打开·保存 都在 rail 内
 *   D. 旧的顶部横栏与「显示网格」开关已彻底移除
 *   E. 网格图标是唯一开关源，点击/快捷键能正确翻转状态
 *   F. 应用图标用的是 assets/icon.png（不再是无意义的内联 SVG）
 *   G. 拖拽区正确：rail 可拖，但按钮全部 no-drag
 *   H. 滚动条风格统一（全局唯一定义，两处颜色一致）
 *   I. 四个分组按钮 + 面板顶部工具变体区（1.3.1，替代被遮挡的子弹层）
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/test-shell.js
 *      （或 npm run test:shell）
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');

ipcMain.handle('app:info', () => ({ version: '1.3.3', platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('file:save', () => ({ ok: false }));
ipcMain.on('app:health', () => {});
ipcMain.on('app:trace', () => {});
ipcMain.on('app:dirty', () => {});

// 记录窗口控制 IPC 是否被调用
const calls = { minimize: 0, maximize: 0, close: 0 };
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => { calls.minimize++; });
ipcMain.on('window:maximize', () => { calls.maximize++; });
ipcMain.on('window:close', () => { calls.close++; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

app.whenReady().then(async () => {
  /* ---------- A. 主进程窗口配置（静态检查源码） ---------- */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('main.js 使用 frame: false', /frame:\s*false/.test(mainSrc));
  check('main.js 使用 titleBarStyle: hidden', /titleBarStyle:\s*'hidden'/.test(mainSrc));
  check('main.js 关闭 titleBarOverlay', /titleBarOverlay:\s*false/.test(mainSrc));
  check('main.js 注册 window:minimize', /ipcMain\.on\('window:minimize'/.test(mainSrc));
  check('main.js 注册 window:maximize', /ipcMain\.on\('window:maximize'/.test(mainSrc));
  check('main.js 注册 window:close', /ipcMain\.on\('window:close'/.test(mainSrc));
  check('main.js 注册 window:is-maximized', /ipcMain\.handle\('window:is-maximized'/.test(mainSrc));
  check('关闭按钮走 mainWindow.close()（复用未保存确认）',
    /ipcMain\.on\('window:close'[\s\S]{0,400}?mainWindow\.close\(\)/.test(mainSrc));
  check('主进程广播最大化状态', /send\('window:maximized'/.test(mainSrc));

  /* ---------- preload 接口 ---------- */
  const preSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  check('preload 暴露 minimizeWindow', /minimizeWindow:/.test(preSrc));
  check('preload 暴露 toggleMaximize', /toggleMaximize:/.test(preSrc));
  check('preload 暴露 closeWindow', /closeWindow:/.test(preSrc));
  check('preload 暴露 onMaximizedChange', /onMaximizedChange:/.test(preSrc));

  /* ---------- 打开真实窗口做 DOM 断言 ---------- */
  // 高度取 620：保证 rail-tools 内容溢出、真正出现滚动条，
  // 否则滚动条相关断言测得的是"没有滚动条"的空情况。
  const win = new BrowserWindow({
    width: 1440, height: 620, show: true, useContentSize: true, backgroundColor: '#0f1115',
    frame: false, titleBarStyle: 'hidden', titleBarOverlay: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1400);

  const evalJs = async (expr) => {
    const r = await win.webContents.executeJavaScript(
      `(function(){ try { ${expr} } catch(e) { return {__err: e.message}; } })()`,
      true
    );
    return r;
  };

  /* ---------- B/C/D/F. 布局结构 ---------- */
  const dom = await evalJs(`
    const q = (id) => document.getElementById(id);
    const rail = document.querySelector('.rail');
    const inRail = (id) => { const el = q(id); return !!(el && rail && rail.contains(el)); };
    const cs = (id) => { const el = q(id); return el ? getComputedStyle(el) : null; };
    return {
      hasRail: !!rail,
      hasTopbar: !!document.querySelector('.topbar'),
      hasToolbar: !!document.querySelector('.toolbar'),
      railRect: rail ? { w: Math.round(rail.getBoundingClientRect().width), h: Math.round(rail.getBoundingClientRect().height) } : null,
      // 左侧栏内的元素
      railKids: {
        brand: !!rail.querySelector('.brand-mark'),
        undo: inRail('btnUndo'), redo: inRail('btnRedo'),
        zoomIn: inRail('btnZoomIn'), zoomOut: inRail('btnZoomOut'), zoomLabel: inRail('zoomLabel'),
        grid: inRail('btnGrid'), export: inRail('btnExport'),
        open: inRail('btnOpen'), save: inRail('btnSave'), fit: inRail('btnFit'),
      },
      toolCount: document.querySelectorAll('.rail .tool').length,
      // 1.3.0：左侧栏精简为 4 个分组按钮
      groups: Array.from(document.querySelectorAll('.rail .tool.tool-group')).map((el) => el.getAttribute('data-group')),
      groupedCount: document.querySelectorAll('.rail .tool.tool-group').length,
      legacyToolCount: document.querySelectorAll('.rail .tool:not(.tool-group)').length,
      /*
       * 1.3.1：组内工具从「向右弹出的子弹层」改为「面板顶部的变体区」。
       * 子弹层被面板压住的 bug 见 #variantGroup 相关断言。
       */
      hasVariantGroup: !!q('variantGroup'),
      hasVariantItems: !!q('variantItems'),
      flyoutGone: !q('flyout'),
      caretGone: document.querySelectorAll('.rail .tool .caret').length === 0,
      // 自绘窗口按钮
      winBtns: {
        min: !!q('btnMinimize'), max: !!q('btnMaximize'), close: !!q('btnWinClose'),
        inStage: !!(q('winControls') && q('stage') && q('stage').contains(q('winControls'))),
        minimizeCalled: typeof window.inkwell.minimizeWindow === 'function',
      },
      // 旧的网格开关应已删除
      gridToggleGone: !q('gridToggle'),
      // 应用图标用的是真实资源
      brandImg: (() => {
        const img = rail.querySelector('.brand-mark img');
        return img ? { src: img.getAttribute('src'), natural: img.naturalWidth } : null;
      })(),
      // 拖拽区
      railDrag: cs('rail') ? cs('rail').webkitAppRegion || cs('rail')['-webkit-app-region'] : null,
      saveDrag: cs('btnSave') ? cs('btnSave').webkitAppRegion || cs('btnSave')['-webkit-app-region'] : null,
      minDrag: cs('btnMinimize') ? cs('btnMinimize').webkitAppRegion || cs('btnMinimize')['-webkit-app-region'] : null,
      version: window.__inkwell.version,
    };
  `);
  if (dom.__err) { console.log('  ✗ DOM 探针异常: ' + dom.__err); fail++; }

  check('左侧栏 .rail 存在', dom.hasRail && dom.railRect && dom.railRect.w > 0, dom.railRect);
  check('旧的 .topbar 已移除', dom.hasTopbar === false);
  check('旧的 .toolbar 已移除', dom.hasToolbar === false);
  check('应用图标在左侧栏内', dom.railKids.brand);
  check('撤销/重做在左侧栏内', dom.railKids.undo && dom.railKids.redo);
  check('缩放在左侧栏内', dom.railKids.zoomIn && dom.railKids.zoomOut && dom.railKids.zoomLabel);
  check('网格在左侧栏内', dom.railKids.grid);
  check('导出在左侧栏内', dom.railKids.export);
  check('打开在左侧栏内', dom.railKids.open);
  check('保存在左侧栏内', dom.railKids.save);
  check('适应窗口在左侧栏内', dom.railKids.fit);
  check('左侧栏精简为 4 个分组按钮', dom.toolCount === 4, dom.toolCount);
  check('分组按钮不再有散落的独立工具', dom.legacyToolCount === 0, dom.legacyToolCount);
  check(
    '四个分组 = 选择/绘画/图形/文本',
    ['select', 'draw', 'shape', 'text'].every((g) => dom.groups.includes(g)) && dom.groupedCount === 4,
    dom.groups
  );
  check('变体区容器存在（面板顶部）', dom.hasVariantGroup && dom.hasVariantItems);
  check('旧的子弹层已彻底移除', dom.flyoutGone);
  check('分组按钮不再挂展开小三角', dom.caretGone);

  check('自绘三个窗口按钮存在', dom.winBtns.min && dom.winBtns.max && dom.winBtns.close);
  check('窗口按钮位于 stage 内', dom.winBtns.inStage);
  check('preload 提供 minimizeWindow', dom.winBtns.minimizeCalled);
  check('旧 gridToggle 开关已删除', dom.gridToggleGone);
  check('版本号已升到 1.3.3', dom.version === '1.3.3', dom.version);

  check('应用图标用 assets/icon.png', dom.brandImg && /icon\.png$/.test(dom.brandImg.src), dom.brandImg);
  check('图标资源实际加载成功', dom.brandImg && dom.brandImg.natural > 0, dom.brandImg && dom.brandImg.natural);

  check('rail 是拖拽区', dom.railDrag === 'drag', dom.railDrag);
  check('保存按钮 no-drag', dom.saveDrag === 'no-drag', dom.saveDrag);
  check('窗口按钮 no-drag', dom.minDrag === 'no-drag', dom.minDrag);

  /* ---------- H. 滚动条风格统一 ---------- */
  /*
   * 左侧栏工具区与右侧面板必须是同一套滚动条视觉。
   *
   * 曾经的 bug：.rail-tools 单独写了 `scrollbar-width: thin`，
   * 这条标准属性会**整体接管**该元素的滚动条渲染，
   * 使全局 ::-webkit-scrollbar-* 规则失效 —— 两处滚动条长相不一致。
   *
   * 判定标准：
   *  1. 两处都不能有 scrollbar-width / scrollbar-color 的局部覆盖
   *  2. 滑块颜色变量必须一致（同一个 --sb-thumb）
   *  3. 全局样式表里必须存在 ::-webkit-scrollbar-thumb 规则
   */
  const sb = await evalJs(`
    const rt = document.getElementById('railTools');
    const pn = document.querySelector('.panel');
    const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim();
    // 遍历样式表，找出所有含 scrollbar 的选择器
    const sel = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules || []; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && /scrollbar/i.test(r.selectorText)) sel.push(r.selectorText);
      }
    }
    return {
      railSbWidth: cs(rt, 'scrollbar-width'),
      panelSbWidth: cs(pn, 'scrollbar-width'),
      railThumb: cs(rt, '--sb-thumb'),
      panelThumb: cs(pn, '--sb-thumb'),
      railW: cs(rt, '--sb-w'),
      panelW: cs(pn, '--sb-w'),
      railInset: cs(rt, '--sb-inset'),
      panelInset: cs(pn, '--sb-inset'),
      scrollbarSelectors: sel,
      railScrollable: rt.scrollHeight > rt.clientHeight,
    };
  `);
  check('rail 未覆盖 scrollbar-width', sb.railSbWidth === 'auto', sb.railSbWidth);
  check('panel 未覆盖 scrollbar-width', sb.panelSbWidth === 'auto', sb.panelSbWidth);
  check('两处滑块颜色变量一致', sb.railThumb === sb.panelThumb && !!sb.railThumb,
    { rail: sb.railThumb, panel: sb.panelThumb });
  check('全局有 ::-webkit-scrollbar-thumb 规则',
    sb.scrollbarSelectors.some((s) => /::-webkit-scrollbar-thumb/.test(s)), sb.scrollbarSelectors);
  check('滚动条箭头按钮已隐藏',
    sb.scrollbarSelectors.some((s) => /::-webkit-scrollbar-button/.test(s)));
  // 只允许宽度/内缩不同，颜色必须同源
  check('rail 滚动条更窄（适配 74px 窄栏）',
    parseInt(sb.railW, 10) < parseInt(sb.panelW, 10), { rail: sb.railW, panel: sb.panelW });

  /* ---------- E. 网格单一状态源 ---------- */
  const grid = await evalJs(`
    const out = {};
    out.initial = window.__inkwell.renderer.options.grid;
    out.svgActiveOnStart = document.getElementById('btnGrid').classList.contains('active');
    // 点一下图标应翻转
    document.getElementById('btnGrid').click();
    out.afterClick = window.__inkwell.renderer.options.grid;
    out.activeAfterClick = document.getElementById('btnGrid').classList.contains('active');
    // setGrid 直接调用
    window.__inkwell.setGrid(true);
    out.afterSetTrue = window.__inkwell.renderer.options.grid;
    out.activeAfterSetTrue = document.getElementById('btnGrid').classList.contains('active');
    window.__inkwell.setGrid(false);
    out.afterSetFalse = window.__inkwell.renderer.options.grid;
    out.activeAfterSetFalse = document.getElementById('btnGrid').classList.contains('active');
    return out;
  `);
  check('初始网格开启且图标 active', grid.initial === true && grid.svgActiveOnStart === true, grid);
  check('点击图标翻转网格状态', grid.afterClick === false);
  check('翻转后图标 active 同步关闭', grid.activeAfterClick === false);
  check('setGrid(true) 生效且图标同步', grid.afterSetTrue === true && grid.activeAfterSetTrue === true);
  check('setGrid(false) 生效且图标同步', grid.afterSetFalse === false && grid.activeAfterSetFalse === false);

  /* ---------- I. 分组按钮 + 面板内工具变体（1.3.1） ---------- */
  /*
   * 左侧栏是 4 个分组按钮，组内具体工具铺在面板顶部、颜色之上。
   *
   * 这里同时守住 1.3.0 那个「严重 bug」：当时工具列表是向右弹出的浮层，
   * 定位在 rail 右边缘 +6px，而面板正好从 x=74 起 —— 浮层整块压进面板底下，
   * DOM 一切正常（hidden=false、items 齐全）但用户完全看不见。
   * 所以下面除了断言结构，还要断言**几何顺序**与**命中测试**。
   */
  const groupBtn = (g) => `document.querySelector('.rail-tools .tool[data-group="${g}"]')`;
  const variantHidden = `document.getElementById('variantGroup').hidden`;
  const variantTools = `Array.from(document.querySelectorAll('#variantItems .variant-btn')).map(b => b.dataset.tool)`;

  // 1) 单工具分组：选择 —— 变体区应隐藏
  const sel = await evalJs(`
    const out = {};
    ${groupBtn('select')}.click();
    out.tool = window.__inkwell.state.tool;
    out.variantHidden = ${variantHidden};
    return out;
  `);
  check('点「选择」直接切工具', sel.tool === 'select', sel.tool);
  check('选择分组不显示变体区', sel.variantHidden === true);

  // 2) 多工具分组：图形
  const g1 = await evalJs(`
    const out = {};
    ${groupBtn('shape')}.click();
    out.hidden = ${variantHidden};
    out.items = ${variantTools};
    out.label = document.getElementById('variantLabel').textContent;
    out.tool = window.__inkwell.state.tool;
    return out;
  `);
  check('点「图形」显示变体区', g1.hidden === false, g1);
  check('变体区列出组内 5 个工具', g1.items.length === 5, g1.items);
  check(
    '变体区含 矩形/椭圆/直线/箭头/填充',
    ['rect', 'ellipse', 'line', 'arrow', 'fill'].every((t) => g1.items.includes(t)),
    g1.items
  );
  check('变体区标题 = 图形', g1.label === '图形', g1.label);
  check('切到分组时自带组内默认工具', g1.tool === 'rect', g1.tool);

  // 3) 几何：变体区必须在面板里，且在颜色之上（不重叠）
  const geoVariant = await evalJs(`
    const vg = document.getElementById('variantGroup');
    const cg = document.getElementById('colorGroup');
    const panel = document.getElementById('panel');
    const vb = vg.getBoundingClientRect();
    const cb = cg.getBoundingClientRect();
    const pb = panel.getBoundingClientRect();
    const rail = document.getElementById('rail').getBoundingClientRect();
    return {
      inPanel: panel.contains(vg),
      // 变体区左边缘应在面板内（也就是在 rail 右侧之外）
      leftOfPanel: Math.round(vb.left), rightOfRail: Math.round(rail.right),
      variantTop: Math.round(vb.top), variantBottom: Math.round(vb.bottom),
      colorTop: Math.round(cb.top),
      overlapColor: vb.bottom > cb.top + 1,
    };
  `);
  check('变体区在面板内（不在 rail 里）', geoVariant.inPanel === true, geoVariant);
  check('变体区完整位于 rail 右侧（不会被 rail 的 overflow 裁掉）',
    geoVariant.leftOfPanel >= geoVariant.rightOfRail, geoVariant);
  check('变体区在颜色区上方且不重叠',
    geoVariant.variantBottom <= geoVariant.colorTop && geoVariant.overlapColor === false, geoVariant);

  // 4) 每个变体按钮都能真正被点中（elementFromPoint 命中自身）—— 1.3.0 就是栽在这
  const hitTest = await evalJs(`
    const btns = Array.from(document.querySelectorAll('#variantItems .variant-btn'));
    return btns.map((b) => {
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { tool: b.dataset.tool, hitSelf: !!(el && (el === b || b.contains(el))) };
    });
  `);
  check('变体按钮全部可被真实命中（无遮挡）',
    hitTest.length === 5 && hitTest.every((h) => h.hitSelf),
    hitTest.filter((h) => !h.hitSelf));

  // 5) 点变体区里的「椭圆」→ 切工具 + 高亮 + 左侧栏图标同步
  const g2 = await evalJs(`
    document.querySelector('#variantItems .variant-btn[data-tool="ellipse"]').click();
    const face = document.querySelector('.rail-tools .tool[data-group="shape"] .tool-face');
    return {
      tool: window.__inkwell.state.tool,
      active: (document.querySelector('#variantItems .variant-btn.active') || {}).dataset.tool,
      railFace: face ? face.dataset.face : null,
      stillVisible: ${variantHidden} === false,
    };
  `);
  check('点变体按钮切到椭圆', g2.tool === 'ellipse', g2.tool);
  check('变体区高亮当前工具', g2.active === 'ellipse', g2.active);
  check('左侧栏分组图标同步成椭圆', g2.railFace === 'ellipse', g2.railFace);
  check('选完变体区仍然可见（不是一次性浮层）', g2.stillVisible === true);

  // 6) 已在组内时再点分组按钮 → 保持当前工具，不被重置
  const g3 = await evalJs(`
    ${groupBtn('shape')}.click();
    return window.__inkwell.state.tool;
  `);
  check('在组内再点分组按钮不会重置工具', g3 === 'ellipse', g3);

  // 7) 去别的分组再回来 → 记住的是椭圆
  const g4 = await evalJs(`
    ${groupBtn('draw')}.click();
    const mid = window.__inkwell.state.tool;
    ${groupBtn('shape')}.click();
    return { mid, back: window.__inkwell.state.tool };
  `);
  check('切到绘画分组用的是组内工具', g4.mid === 'pen', g4.mid);
  check('回到图形分组恢复上次选的椭圆', g4.back === 'ellipse', g4.back);

  // 8) 文本分组：文本 / 便签
  const g5 = await evalJs(`
    ${groupBtn('text')}.click();
    return { items: ${variantTools}, tool: window.__inkwell.state.tool,
             hidden: ${variantHidden} };
  `);
  check('文本分组含 文本/便签',
    g5.items.length === 2 && g5.items.includes('text') && g5.items.includes('note'), g5.items);
  check('文本分组默认切到文本工具', g5.tool === 'text', g5.tool);

  // 9) 自由绘画分组：画笔 / 橡皮 / 抓手
  const g6 = await evalJs(`
    ${groupBtn('draw')}.click();
    return ${variantTools};
  `);
  check('绘画分组含 画笔/橡皮/抓手',
    g6 && g6.length === 3 && ['pen', 'eraser', 'hand'].every((t) => g6.includes(t)),
    g6
  );

  // 10) 快捷键切工具时，变体区也要跟着切分组并高亮
  //     （renderVariants 挂在 setTool 里，而不是只挂在按钮 click 上）
  const g7 = await evalJs(`
    window.__inkwell.setTool('pen');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', bubbles: true }));
    return {
      tool: window.__inkwell.state.tool,
      group: window.__inkwell.state.toolGroup,
      hidden: ${variantHidden},
      active: (document.querySelector('#variantItems .variant-btn.active') || {}).dataset
        ? document.querySelector('#variantItems .variant-btn.active').dataset.tool : null,
      label: document.getElementById('variantLabel').textContent,
    };
  `);
  check('按 O 切到椭圆', g7.tool === 'ellipse', g7.tool);
  check('快捷键切工具后变体区跟着切组', g7.hidden === false && g7.label === '图形', g7.label);
  check('快捷键切工具后变体区高亮同步', g7.active === 'ellipse', g7.active);

  // 收尾：切回矩形，避免影响后续断言
  await evalJs(`window.__inkwell.setTool('rect'); return 1;`);

  /* ---------- B. 点击真实按钮是否触发 IPC ---------- */
  await evalJs(`document.getElementById('btnMinimize').click(); return 1;`);
  await sleep(120);
  check('点最小化触发 window:minimize', calls.minimize === 1, calls.minimize);

  await evalJs(`document.getElementById('btnMaximize').click(); return 1;`);
  await sleep(120);
  check('点最大化触发 window:maximize', calls.maximize === 1, calls.maximize);

  /* ---------- 最大化图标切换 ---------- */
  const iconSync = await evalJs(`
    const maxIco = document.querySelector('#btnMaximize .ico-max');
    const restoreIco = document.querySelector('#btnMaximize .ico-restore');
    const beforeMax = { max: maxIco.hidden, restore: restoreIco.hidden };
    // 拿到注册的回调，手动喂一个"已最大化"
    window.inkwell.onMaximizedChange;
    const el = document.getElementById('btnMaximize');
    return {
      beforeMax,
      titleBefore: el.title,
      bothIconsExist: !!maxIco && !!restoreIco,
    };
  `);
  check('最大化按钮含两个图标（方框/还原）', iconSync.bothIconsExist);
  check('默认显示"最大化"图标、隐藏"还原"',
    iconSync.beforeMax.max === false && iconSync.beforeMax.restore === true, iconSync.beforeMax);
  check('默认 tooltip 是「最大化」', iconSync.titleBefore === '最大化', iconSync.titleBefore);

  // 用主进程真实广播驱动图标切换
  win.webContents.send('window:maximized', true);
  await sleep(150);
  const afterBroadcast = await evalJs(`
    const maxIco = document.querySelector('#btnMaximize .ico-max');
    const restoreIco = document.querySelector('#btnMaximize .ico-restore');
    return {
      maxHidden: maxIco.hidden, restoreHidden: restoreIco.hidden,
      title: document.getElementById('btnMaximize').title,
    };
  `);
  check('收到"已最大化"广播后切到还原图标',
    afterBroadcast.maxHidden === true && afterBroadcast.restoreHidden === false, afterBroadcast);
  check('tooltip 变为「还原」', afterBroadcast.title === '还原', afterBroadcast.title);

  win.webContents.send('window:maximized', false);
  await sleep(150);
  const backToNormal = await evalJs(`
    return { maxHidden: document.querySelector('#btnMaximize .ico-max').hidden,
             title: document.getElementById('btnMaximize').title };
  `);
  check('还原后又切回最大化图标', backToNormal.maxHidden === false && backToNormal.title === '最大化');

  /* ---------- 关闭按钮 ---------- */
  await evalJs(`document.getElementById('btnWinClose').click(); return 1;`);
  await sleep(120);
  check('点关闭触发 window:close（不当场销毁窗口）', calls.close === 1 && !win.isDestroyed(), calls.close);

  /* ---------- 窗口按钮几何：必须在可视区域内 ---------- */
  const geo = await evalJs(`
    const b = document.getElementById('btnWinClose').getBoundingClientRect();
    return { right: Math.round(b.right), top: Math.round(b.top),
             vw: window.innerWidth, inView: b.right <= window.innerWidth + 1 && b.top >= -1 };
  `);
  check('关闭按钮完整落在视口内（未被裁掉）', geo.inView, geo);
  check('关闭按钮贴着窗口右上角', geo.vw - geo.right < 12 && geo.top < 12, geo);

  console.log('');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  app.exit(fail === 0 ? 0 : 1);
});
