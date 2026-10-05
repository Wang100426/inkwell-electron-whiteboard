'use strict';

/**
 * 回归测试：1.2.0 无边框窗口 + 左侧栏重排。
 *
 * 覆盖：
 *   A. 主进程窗口配置（无边框、标题栏隐藏、overlay 关闭）
 *   B. 自绘窗口控制按钮存在且接线正确（最小化/最大化/关闭走 IPC）
 *   C. 左侧栏布局：图标 / 撤销重做 / 缩放 / 工具 / 网格·导出·打开·保存 都在 rail 内
 *   D. 旧的顶部横栏与「显示网格」开关已彻底移除
 *   E. 网格图标是唯一开关源，点击/快捷键能正确翻转状态
 *   F. 应用图标用的是 assets/icon.png（不再是无意义的内联 SVG）
 *   G. 拖拽区正确：rail 可拖，但按钮全部 no-drag
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

ipcMain.handle('app:info', () => ({ version: '1.2.0', platform: process.platform, electron: process.versions.electron }));
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
  check('11 个绘图工具都在', dom.toolCount === 11, dom.toolCount);

  check('自绘三个窗口按钮存在', dom.winBtns.min && dom.winBtns.max && dom.winBtns.close);
  check('窗口按钮位于 stage 内', dom.winBtns.inStage);
  check('preload 提供 minimizeWindow', dom.winBtns.minimizeCalled);
  check('旧 gridToggle 开关已删除', dom.gridToggleGone);
  check('版本号已升到 1.2.0', dom.version === '1.2.0', dom.version);

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
