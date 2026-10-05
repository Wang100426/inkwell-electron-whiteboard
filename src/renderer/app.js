'use strict';

const { readPressure, pressureToWidth } = require('./geometry');

const { BoardStore, BoardRenderer, hitTest, boundsOf, makeBase, TransformShapesCommand, snapshot, FILLABLE_TYPES, NOTE_W, NOTE_H, reorderIds } = require('./board');
const { applyErase } = require('./eraser');

/* ============================ DOM ============================ */

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const stage = $('stage');
const store = new BoardStore();
const renderer = new BoardRenderer(canvas);

const state = {
  tool: 'pen',
  style: {
    color: '#e8ecf4',
    // 填充色由「填充」工具使用；新图形一律无填充（见 makeBase）
    fill: '#4c8dff',
    width: 3,
    opacity: 1,
    fontSize: 20,
    pressureSensitive: true,   // 手写笔压感开关
    pressureMax: 18,           // 压感满时的最大线宽
  },
  draft: null,
  selection: [],
  hoverId: null,
  spaceDown: false,
  panning: false,
  drawing: false,
  dragShape: null,
  filePath: null,
  dirty: false,
  activePointerType: 'mouse',
  lastPressure: 0,
};

const TOOL_NAMES = {
  select: '选择', pen: '画笔', eraser: '橡皮', fill: '填充', rect: '矩形',
  ellipse: '椭圆', line: '直线', arrow: '箭头', text: '文字', note: '便签', hand: '抓手',
};

const PALETTE = [
  '#ffffff', '#e8ecf4', '#9aa4b5', '#5b6472', '#3a4150', '#232834',
  '#4c8dff', '#5ac8fa', '#38d39f', '#7b5cff', '#c86bff', '#ff5f6b',
  '#ff8a3d', '#ffc93d', '#a3e635', '#4ade80', '#14b8a6', '#2dd4bf',
  '#f472b6', '#fb7185', '#e879f9', '#93c5fd', '#fcd34d', '#94a3b8',
];

/** 橡皮擦除直径（世界坐标），与画笔线宽解耦 */
const ERASER_SIZE = 22;

/* ============================ Toast ============================ */

/* ============================ 交互追踪 ============================ */

/**
 * 把关键动作写进 inkwell.log（%APPDATA%\inkwell-whiteboard\inkwell.log）。
 *
 * 用途：用户报"点了没反应"但本地复现不出来时，让用户跑一次，
 * 看日志断在哪一步 —— 是工具没切过去，还是点了画布没进 openEditor。
 * 出问题的地方一目了然，不用再猜。
 */
function trace(msg) {
  try {
    if (window.inkwell && window.inkwell.trace) window.inkwell.trace(msg);
  } catch (_) {
    /* 追踪失败绝不影响主流程 */
  }
}

/* ============================ Toast ============================ */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, 2200);
}

/* ============================ 渲染调度 ============================ */

/**
 * 双保险调度：
 * rAF 在窗口隐藏/失焦（软件渲染、后台标签）时可能长时间不触发，
 * 此时 pending 标志会一直挂着，导致后续所有重绘被去重逻辑丢弃、画布僵死。
 * 因此额外用定时器兜底：rAF 没跑成就由它补上。
 */
let rafId = null;
let rafPending = false;
let timerId = null;

function paint() {
  rafPending = false;
  // 图形数据来自 store，state 只承载交互态（草稿/选中/悬停）
  renderer.render(state, store.shapes);
  updateStatus();
}

function requestRender() {
  if (rafPending) return;
  rafPending = true;

  clearTimeout(timerId);
  timerId = setTimeout(() => {
    if (rafPending) {
      // rAF 没来（窗口不可见等），同步补一帧
      cancelAnimationFrame(rafId);
      rafId = null;
      paint();
    }
  }, 60);

  rafId = requestAnimationFrame(() => {
    rafId = null;
    clearTimeout(timerId);
    timerId = null;
    if (rafPending) paint();
  });
}

store.on(() => {
  state.dirty = true;
  // 撤销/重做会替换图形对象，按 id 重新绑定选中项
  if (store.rebind) {
    state.selection = store.rebind(state.selection);
    if (state.hoverId && !store.shapes.some((s) => s.id === state.hoverId)) state.hoverId = null;
    store.rebind = null;
  }
  reportDirty();
  requestRender();
  updateHistoryButtons();
  updateEmptyHint();
});

/**
 * 把"有未保存内容"状态同步给主进程。
 * close 事件里只能同步读缓存，所以必须主动 push，不能等主进程来查。
 */
let dirtyReported = false;
function reportDirty() {
  if (!window.inkwell || !window.inkwell.setDirty) return;
  const dirty = state.dirty && store.shapes.length > 0;
  if (dirty === dirtyReported) return;
  dirtyReported = dirty;
  try {
    window.inkwell.setDirty(dirty);
  } catch (_) {
    /* 预加载未就绪时忽略 */
  }
}

function updateStatus() {
  $('statusCount').textContent = `${store.shapes.length} 个图形`;
  $('zoomLabel').textContent = `${Math.round(renderer.view.scale * 100)}%`;
  const sel = state.selection.length;
  $('btnDuplicate').disabled = !sel;
  $('btnDelete').disabled = !sel;
  updateLayerButtons();
}

/**
 * 上移/下移按钮的可用性。
 * 选中的已经全在最上层就没有"上移"的余地了，反之亦然 ——
 * 置灰比点了没反应更清楚。
 */
function updateLayerButtons() {
  const sel = state.selection;
  const has = sel.length > 0;
  $('btnRaise').disabled = !has || !canReorder(sel, 'up');
  $('btnLower').disabled = !has || !canReorder(sel, 'down');
}

function updateHistoryButtons() {
  $('btnUndo').disabled = !store.history.canUndo();
  $('btnRedo').disabled = !store.history.canRedo();
}

function updateEmptyHint() {
  $('emptyHint').classList.toggle('hidden', store.shapes.length > 0);
}

/* ============================ 工具与样式 UI ============================ */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  stage.className = 'stage tool-' + tool;
  $('statusTool').textContent = TOOL_NAMES[tool] || tool;
  trace('setTool -> ' + tool);
  // 面板按工具显示相关项
  // 填充工具复用画笔调色板：选中它时色板改的是「填充色」，而非描边色
  $('btnNoFill').hidden = tool !== 'fill';
  $('colorLabel').textContent = tool === 'fill' ? '填充色' : '颜色';
  $('textGroup').hidden = tool !== 'text';
  // 压感只对绘画类工具有意义
  $('pressureGroup').hidden = !['pen', 'eraser'].includes(tool);
  if (tool !== 'select') clearSelection();
  syncStyleUI();
  requestRender();
}

function buildSwatches() {
  const wrap = $('swatches');
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    // 同一块色板两用：填充工具下改填充色，其余工具改描边色。
    // 这样用户不用在两个色板之间来回找颜色。
    b.addEventListener('click', () => setSwatchColor(c));
    wrap.appendChild(b);
  });

  $('widthPresets').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      state.style.width = parseInt(b.dataset.w, 10);
      $('widthRange').value = state.style.width;
      syncStyleUI();
    });
  });
}

/** 色板点击：按当前工具决定改描边色还是填充色 */
function setSwatchColor(c) {
  if (state.tool === 'fill') {
    state.style.fill = c;
    syncStyleUI();
    return;
  }
  setColor(c);
}

function setColor(c) {
  state.style.color = c;
  $('colorPicker').value = c;
  // 选中的图形跟随改色
  if (state.selection.length) {
    const before = snapshot(store.shapes);
    state.selection.forEach((s) => (s.color = c));
    store.history.push(new TransformShapesCommand(store, before, snapshot(store.shapes)));
    requestRender();
  }
  syncStyleUI();
}

function updateDeviceHint() {
  const el = $('pressureDevice');
  const hint = $('pressureHint');
  if (!el || !hint) return;

  const type = state.activePointerType;
  const p = state.lastPressure;
  const names = { pen: '手写笔', touch: '触摸', mouse: '鼠标' };
  el.textContent = names[type] || '未知';

  if (type === 'mouse') {
    hint.textContent = '未检测到手写笔。用手写笔书写时，笔画粗细会随力度变化。';
    hint.classList.remove('active');
  } else if (type === 'pen') {
    const pct = Math.round(p * 100);
    hint.textContent = state.style.pressureSensitive
      ? `压感已启用 · 当前笔压 ${pct}%`
      : `检测到手写笔，但压感开关已关闭（笔压 ${pct}%）`;
    hint.classList.toggle('active', state.style.pressureSensitive);
  } else {
    hint.textContent = `触摸输入 · 笔压 ${Math.round(p * 100)}%（多数触摸屏不提供真实压感）`;
    hint.classList.toggle('active', state.style.pressureSensitive);
  }
}

function syncStyleUI() {
  const isFill = state.tool === 'fill';
  // 色板高亮跟着当前用途走：填充工具看填充色，其余看描边色
  const cur = isFill ? state.style.fill : state.style.color;
  const active = cur;
  // <input type="color"> 只接受 #rrggbb，写 "transparent" 会抛
  // "does not conform to the required format"。无填充时退回默认值。
  $('colorHex').textContent = cur === 'transparent' ? '无填充' : cur.toUpperCase();
  $('colorPicker').value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#4c8dff';
  document.querySelectorAll('.swatch').forEach((b) =>
    b.classList.toggle('active', b.dataset.color === active)
  );
  document.querySelectorAll('#widthPresets button').forEach((b) =>
    b.classList.toggle('active', parseInt(b.dataset.w, 10) === state.style.width)
  );
  $('widthValue').textContent = state.style.width;
  $('opacityValue').textContent = Math.round(state.style.opacity * 100) + '%';
  $('fontSizeValue').textContent = state.style.fontSize;
  if ($('pressureMaxValue')) {
    $('pressureMaxValue').textContent = state.style.pressureMax;
    $('pressureToggle').checked = state.style.pressureSensitive;
  }
  updateDeviceHint();
}

/* ============================ 指针交互 ============================ */

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pick(wx, wy) {
  const tol = 6 / renderer.view.scale;
  for (let i = store.shapes.length - 1; i >= 0; i--) {
    const s = store.shapes[i];
    if (s.locked) continue;
    if (hitTest(s, wx, wy, tol)) return s;
  }
  return null;
}

/**
 * 填充工具的拾取。
 *
 * 不能直接用 hitTest：它对**未填充**的矩形/椭圆只认边框（内部不算命中），
 * 于是"要点中才能填充、要填充才能点中"形成死循环 —— 点内部没反应。
 */
function fillTargetAt(wx, wy) {
  // 1) 先按精确命中找最上层图形，正确处理遮挡与笔迹这类稀疏图形
  const top = pick(wx, wy);
  if (top) return { shape: top, fillable: FILLABLE_TYPES.includes(top.type) };

  // 2) 精确命中为空 —— 多半是点在未填充矩形/椭圆的内部，补一次包围盒判定
  for (let i = store.shapes.length - 1; i >= 0; i--) {
    const s = store.shapes[i];
    if (s.locked || !FILLABLE_TYPES.includes(s.type)) continue;
    const b = boundsOf(s);
    if (b && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
      return { shape: s, fillable: true };
    }
  }
  return null;
}

/**
 * 油漆桶：给点中的图形切换填充。
 *
 * 规则（按直觉设计，避免"点了没反应"或"想换色却取消了"）:
 *   未填充        → 用当前填充色填充
 *   已填充·同色   → 取消填充（再点一次收起）
 *   已填充·异色   → 改用当前填充色
 * 「无填充色」(transparent) 视为取消填充。
 */
function applyFill(wx, wy) {
  const found = fillTargetAt(wx, wy);
  if (!found) return;                       // 点在空白处，什么都不做
  if (!found.fillable) {
    toast('这个图形不支持填充', true);       // 线/箭头/笔迹/文字
    return;
  }
  const hit = found.shape;

  const color = state.style.fill;
  const clearing = color === 'transparent';
  // 已经是这个颜色 → 再点一次取消
  const sameColor = hit.fillEnabled && hit.fill === color;
  const next = clearing || sameColor ? false : true;

  if (hit.fillEnabled === next && (!next || hit.fill === color)) return; // 无变化

  const before = snapshot(store.shapes);
  hit.fillEnabled = next;
  if (next) hit.fill = color;
  store.history.push(new TransformShapesCommand(store, before, snapshot(store.shapes)));
  store.history.seal();
  store.emit('edit');
  requestRender();
}

function clearSelection() {
  state.selection = [];
  requestRender();
}

/** setPointerCapture 在合成事件或指针已释放时会抛错，包一层避免打断绘制流程 */
function safeCapture(e) {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 忽略：不影响绘制 */
  }
}

canvas.addEventListener('pointerdown', (e) => {
  // 正在编辑时点击画布：先提交当前内容，再开始新的交互。
  // 否则 openEditor 会被再次调用覆盖 editing，导致之前输入的文字永远提交不了。
  if (editing) commitEdit();

  // 笔杆橡皮端：部分手写笔尾部是橡皮，浏览器报 buttons 位 32 (0x20)，button 可能是 5
  const barrelEraser = e.pointerType === 'pen' && (e.buttons & 32) !== 0;
  const tool = barrelEraser ? 'eraser' : state.tool;

  if (e.button === 1 || state.spaceDown || tool === 'hand') {
    state.panning = true;
    stage.classList.add('panning');
    safeCapture(e);
    return;
  }
  // 只放行主键与笔杆橡皮端，其余（右键、中键）忽略
  if (e.button !== 0 && !barrelEraser) {
    trace('pointerdown 被忽略: button=' + e.button);
    return;
  }

  const p = pos(e);
  const w = renderer.toWorld(p.x, p.y);
  safeCapture(e);
  trace('pointerdown tool=' + tool + ' world=' + Math.round(w.x) + ',' + Math.round(w.y));

  // 输入设备检测：让用户知道压感是否真的被用上了
  const pType = e.pointerType || 'mouse';
  if (pType !== state.activePointerType) {
    state.activePointerType = pType;
    updateDeviceHint();
  }
  if (pType === 'pen' || pType === 'touch') {
    const pr = readPressure(e);
    if (pr !== state.lastPressure) {
      state.lastPressure = pr;
      updateDeviceHint();
    }
  }
  state.drawing = true;
  state.startWorld = w;

  const style = { ...state.style };

  if (tool === 'select') {
    const hit = pick(w.x, w.y);
    if (hit) {
      if (e.shiftKey) {
        const i = state.selection.indexOf(hit);
        i >= 0 ? state.selection.splice(i, 1) : state.selection.push(hit);
      } else if (!state.selection.includes(hit)) {
        state.selection = [hit];
      }
      // 准备拖动
      state.dragShape = {
        start: w,
        before: snapshot(store.shapes),
        origins: state.selection.map((s) => ({ shape: s, snapshot: JSON.parse(JSON.stringify(s)) })),
      };
    } else {
      clearSelection();
    }
    requestRender();
    return;
  }

  if (tool === 'eraser') {
    // 矢量擦除：只记录扫过的线段，不产生 draft 图形。
    // 压感橡皮：轻擦细、重擦粗，宽度按笔压在 ERASER_SIZE~2.5x 之间变化
    state.erasing = {
      paths: [{ x1: w.x, y1: w.y, x2: w.x, y2: w.y }],
      width: ERASER_SIZE,
      base: store.shapes.slice(),
    };
    return;
  }

  if (tool === 'fill') {
    // 油漆桶：点击已有图形切换填充。不进 draft，不产生新图形。
    applyFill(w.x, w.y);
    state.drawing = false;
    return;
  }

  if (tool === 'pen') {
    const base = makeBase(tool, style);
    // 只有真正能提供压感的设备才启用变宽渲染。
    // 鼠标的 pressure 恒为 0.5，若也走变宽路径只会白白损失性能。
    const pType = e.pointerType || 'mouse';
    const p = readPressure(e);
    const usePressure = state.style.pressureSensitive && pType !== 'mouse' && p > 0;
    const draft = {
      ...base,
      pressureSensitive: usePressure,
      points: [{ x: w.x, y: w.y, w: usePressure ? pressureToWidth(p, base.width, base.pressureMax) : base.width }],
    };
    state.draft = draft;
    state.mergeKey = `pen_${e.pointerId}`;
    state.activePointerType = pType;
    return;
  }

  if (tool === 'rect' || tool === 'ellipse') {
    state.draft = { ...makeBase(tool, style), x: w.x, y: w.y, w: 0, h: 0 };
    return;
  }

  if (tool === 'line' || tool === 'arrow') {
    state.draft = { ...makeBase(tool, style), x1: w.x, y1: w.y, x2: w.x, y2: w.y };
    return;
  }

  if (tool === 'text' || tool === 'note') {
    // 点击即弹出编辑器，无需先画出草图
    /*
     * preventDefault 必须加，否则真实鼠标下编辑器会"打开即关闭"。
     *
     * 原因：pointerdown 的默认行为是「把焦点移到被点击的元素」（这里是 canvas）。
     * 我们在 openEditor 里 input.focus() 把焦点给 textarea，但处理器返回后，
     * 浏览器执行 mousedown 的默认聚焦 → 焦点被抢回 canvas → textarea 触发
     * focusout → commitEdit() → 编辑器立刻隐藏（实测下一帧 rect 就变 0,0,0,0）。
     *
     * 合成事件（dispatchEvent）不执行默认行为，所以诊断脚本里一直复现不出来 ——
     * 这是本项目第二次栽在「真实焦点转移 vs 合成事件」上（第一次见 focusout 注释）。
     * 阻止默认聚焦后，textarea 才能稳稳拿到焦点。
     */
    e.preventDefault();
    trace('进入 text/note 分支 -> openEditor');
    openEditor({ kind: tool, wx: w.x, wy: w.y });
    state.drawing = false;
    return;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pos(e);
  const w = renderer.toWorld(p.x, p.y);

  $('statusPos').textContent = `x: ${Math.round(w.x)}  y: ${Math.round(w.y)}`;

  // 压感实时反馈（手写笔笔压）
  const pType = e.pointerType || 'mouse';
  if (pType === 'pen' || pType === 'touch') {
    const pr = readPressure(e);
    if (Math.abs(pr - state.lastPressure) > 0.02) {
      state.lastPressure = pr;
      updateDeviceHint();
    }
  }

  if (state.panning) {
    renderer.view.x += e.movementX;
    renderer.view.y += e.movementY;
    requestRender();
    return;
  }

  if (state.tool === 'select' && !state.drawing) {
    const hit = pick(w.x, w.y);
    const id = hit ? hit.id : null;
    if (id !== state.hoverId) {
      state.hoverId = id;
      canvas.style.cursor = hit ? 'move' : 'default';
      requestRender();
    }
    return;
  }

  if (state.erasing) {
    // 追加扫过的线段，实时预览擦除结果
    const last = state.erasing.paths[state.erasing.paths.length - 1];
    const d = Math.hypot(w.x - last.x2, w.y - last.y2);
    if (d * renderer.view.scale > 1.2) {
      state.erasing.paths.push({ x1: last.x2, y1: last.y2, x2: w.x, y2: w.y });
      // 实时把 store 换成擦除后的结果
      const res = applyErase(state.erasing.base, state.erasing.paths, state.erasing.width);
      store.shapes = res.shapes;
      requestRender();
    }
    return;
  }

  if (!state.draft && !state.dragShape) return;

  // Shift 约束：直线 45° 吸附
  let end = w;
  if (e.shiftKey && (state.draft?.type === 'line' || state.draft?.type === 'arrow')) {
    const s = state.startWorld;
    const dx = w.x - s.x;
    const dy = w.y - s.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    end = { x: s.x + Math.cos(ang) * len, y: s.y + Math.sin(ang) * len };
  }
  // Shift 正方形
  if (e.shiftKey && (state.draft?.type === 'rect' || state.draft?.type === 'ellipse' || state.draft?.type === 'note')) {
    const s = state.startWorld;
    const d = Math.max(Math.abs(w.x - s.x), Math.abs(w.y - s.y));
    end = { x: s.x + Math.sign(w.x - s.x || 1) * d, y: s.y + Math.sign(w.y - s.y || 1) * d };
  }

  if (state.dragShape) {
    const dx = w.x - state.startWorld.x;
    const dy = w.y - state.startWorld.y;
    state.dragShape.origins.forEach(({ shape, snapshot }) => {
      if (shape.type === 'pen' || shape.type === 'eraser') {
        shape.points = snapshot.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
      } else if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'note') {
        shape.x = snapshot.x + dx;
        shape.y = snapshot.y + dy;
      } else if (shape.type === 'line' || shape.type === 'arrow') {
        shape.x1 = snapshot.x1 + dx;
        shape.y1 = snapshot.y1 + dy;
        shape.x2 = snapshot.x2 + dx;
        shape.y2 = snapshot.y2 + dy;
      } else if (shape.type === 'text') {
        shape.x = snapshot.x + dx;
        shape.y = snapshot.y + dy;
      }
    });
    requestRender();
    return;
  }

  if (state.draft.type === 'pen') {
    const last = state.draft.points[state.draft.points.length - 1];
    // 压感笔迹需要更密的采样点，否则分段描边会出现"鳞片"状接缝
    const minDist = state.style.pressureSensitive ? 0.8 : 1.2;
    if (Math.hypot(w.x - last.x, w.y - last.y) * renderer.view.scale > minDist) {
      // 压感笔迹：每个采样点按当前压力定宽。
      // 必须同时校验设备类型 —— 鼠标的 pressure 恒为 1，
      // 若只看开关会把鼠标笔迹误判为压感，白白走变宽渲染。
      const pType = e.pointerType || 'mouse';
      let width = state.draft.width;
      if (state.style.pressureSensitive && pType !== 'mouse') {
        const p = readPressure(e);
        if (p > 0) {
          // 一旦检测到真实压感就整笔启用（有些设备起笔才上报压力）
          state.draft.pressureSensitive = true;
          width = pressureToWidth(p, state.draft.width, state.draft.pressureMax);
        }
      }
      // 平滑：压力突变时做轻微低通，避免笔迹忽粗忽细显得锯齿
      const prevW = typeof last.w === 'number' ? last.w : width;
      const smoothed = prevW + (width - prevW) * 0.35;
      state.draft.points.push({ x: w.x, y: w.y, w: smoothed });
    }
  } else if (state.draft.type === 'rect' || state.draft.type === 'ellipse' || state.draft.type === 'note') {
    state.draft.x = Math.min(state.startWorld.x, end.x);
    state.draft.y = Math.min(state.startWorld.y, end.y);
    state.draft.w = Math.abs(end.x - state.startWorld.x);
    state.draft.h = Math.abs(end.y - state.startWorld.y);
  } else if (state.draft.type === 'line' || state.draft.type === 'arrow') {
    state.draft.x2 = end.x;
    state.draft.y2 = end.y;
  }
  requestRender();
});

function finishPointer(e) {
  if (state.panning) {
    state.panning = false;
    stage.classList.remove('panning');
  }

  if (state.dragShape) {
    const moved = state.dragShape.origins.some(
      ({ shape, snapshot }) => JSON.stringify(shape) !== JSON.stringify(snapshot)
    );
    if (moved) {
      // 拖动前整份快照 → 拖动后整份快照，undo/redo 直接整体换回去
      store.history.push(
        new TransformShapesCommand(store, state.dragShape.before, snapshot(store.shapes))
      );
    }
    state.dragShape = null;
  }

  if (state.erasing) {
    const base = state.erasing.base;
    const after = store.shapes;
    if (JSON.stringify(base) !== JSON.stringify(after)) {
      // 擦除是一次不可分割的操作，用整份快照记录，撤销可完整恢复
      store.history.push(new TransformShapesCommand(store, base, after));
    } else {
      store.shapes = base; // 没擦到任何东西，还原
    }
    state.erasing = null;
  }

  if (state.draft) {
    const d = state.draft;
    const tiny =
      d.type === 'pen'
        ? d.points.length < 2
        : d.w !== undefined
          ? d.w < 3 && d.h < 3
          : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3;

    if (!tiny) {
      store.addShape(d, d.type === 'pen' ? { mergeKey: state.mergeKey } : {});
    }
    state.draft = null;
    state.mergeKey = null;
    store.history.seal();
  }

  state.drawing = false;
  requestRender();
}

canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', finishPointer);
canvas.addEventListener('pointerleave', () => {
  if (state.hoverId) {
    state.hoverId = null;
    requestRender();
  }
});

canvas.addEventListener('dblclick', (e) => {
  const p = pos(e);
  const w = renderer.toWorld(p.x, p.y);
  const hit = pick(w.x, w.y);
  trace('dblclick hit=' + (hit ? hit.type + '#' + hit.id : 'null'));
  if (!hit) return;
  if (hit.type === 'text') {
    openEditor({ kind: 'text', shape: hit, wx: hit.x, wy: hit.y });
  } else if (hit.type === 'note') {
    // 对齐纸片左上角（openEditor 内部再按 pad 内缩），
    // 不要用双击点定位 —— 那会让输入框出现在鼠标处、和纸片错位。
    openEditor({ kind: 'note', shape: hit, wx: hit.x, wy: hit.y });
  }
});

/* 滚轮缩放 */
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const p = pos(e);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      renderer.zoomAt(p.x, p.y, factor);
    } else {
      renderer.view.x -= e.deltaX;
      renderer.view.y -= e.deltaY;
    }
    requestRender();
  },
  { passive: false }
);

/* ============================ 文字 / 便签编辑 ============================ */

let editing = null;

/**
 * 打开编辑浮层。文字与便签共用同一套 UI ——
 * 早前便签用 window.prompt()，而 Electron 默认禁用该 API，导致双击便签毫无反应。
 * @param {object} opts
 * @param {'text'|'note'} opts.kind
 * @param {object} [opts.shape] 传入则为编辑现有图形，否则为新建
 * @param {number} opts.wx 世界坐标 x
 * @param {number} opts.wy 世界坐标 y
 */
function openEditor({ kind, shape = null, wx, wy }) {
  // 重复打开前先提交上一次，避免输入内容被覆盖丢失
  if (editing) commitEdit();

  const editor = $('textEditor');
  const input = $('textInput');
  const isNote = kind === 'note';

  const scr = renderer.toScreen(wx, wy);
  // 便签按矩形定位到内部偏移；文字对齐左上
  const pad = isNote ? 12 : 0;

  // 宽度随纸片；内层 textarea 用 width:100% 撑满（见 styles.css），
  // 两边宽度必须只在一处定义，否则会溢出被裁。
  // 新建便签时用 NOTE_W/NOTE_H，跟 commitEdit 里落盘的尺寸保持一致。
  const w = shape ? shape.w : (isNote ? NOTE_W : 320);
  const boxW = isNote ? Math.max(160, Math.min(420, w - pad * 2)) : 320;

  // 便签编辑框跟随纸片高度，避免输入区域和纸片大小对不上、
  // 点纸片下半部分时输入框"浮"在上面看起来像没反应。
  const h = shape ? shape.h : (isNote ? NOTE_H : 0);
  // 文字高度按字号估算，用于边界约束
  const boxH = isNote ? Math.max(88, h - pad * 2) : Math.max(88, state.style.fontSize * 3.2);

  /*
   * 边界约束（关键）：
   * .stage 是 overflow:hidden 的定位父元素。编辑器如果定位到画布右下角
   * 之外，会被整个裁掉 —— 表现为"点了半天没反应"。
   * 实测点画布右下区域时编辑器落在 (1200,656)，而画布只有 1126x766，
   * 右边界直接出界。这里把它夹回可视范围内。
   */
  const stageBox = stage.getBoundingClientRect();
  const margin = 8;
  let left = scr.x + pad;
  let top = scr.y + pad;
  // 右边放不下就往左挪
  if (left + boxW > stageBox.width - margin) left = stageBox.width - margin - boxW;
  // 下边放不下就往上挪
  if (top + boxH > stageBox.height - margin) top = stageBox.height - margin - boxH;
  // 再兜底夹一次，防止小窗口下算出负数
  left = Math.max(margin, left);
  top = Math.max(margin, top);

  editor.style.left = Math.round(left) + 'px';
  editor.style.top = Math.round(top) + 'px';
  editor.style.width = boxW + 'px';
  editor.style.height = isNote ? boxH + 'px' : '';
  editor.classList.toggle('is-note', isNote);

  editor.hidden = false;
  input.style.fontSize = (isNote ? 16 : state.style.fontSize) + 'px';
  input.style.color = isNote ? 'rgba(30,30,40,0.88)' : state.style.color;
  input.value = shape ? shape.text || '' : '';

  // editing 必须**先**赋值再聚焦：focus 可能同步触发 focusout
  // （真实鼠标下 mousedown 默认聚焦会抢焦点），那时 commitIfEditing
  // 要能读到 editing 才知道该提交谁。
  editing = { kind, shape, wx, wy };

  /*
   * 聚焦要"两段式"：立即一次 + 下一个宏任务再一次。
   *
   * 立即聚焦负责正常情况；延后那次负责兜底——真实鼠标点画布时，
   * pointerdown 处理器返回后浏览器才执行 mousedown 的默认聚焦行为
   * （把焦点给 canvas/body），会把刚给 textarea 的焦点抢走。
   * 那次抢焦点发生在当前宏任务里，所以用 setTimeout(0) 排队一次重新聚焦，
   * 此时默认行为已执行完，不会再有东西来抢。
   *
   * 没有这一步时：真实点击 → 焦点被抢 → focusout → commitEdit →
   * 编辑器闪一下就消失（下一帧 rect=0,0,0,0），用户完全看不到输入框。
   */
  input.focus();
  input.select();
  setTimeout(() => {
    if (editing && editing.kind === kind) {
      input.focus();
      input.select();
    }
  }, 0);

  // 状态栏提示 + 强制滚入可视区。
  // 有用户反馈"点了没反应"，日志证明编辑器其实已打开（hidden=false、
  // 焦点在输入框），只是没被注意到。给两处主动反馈，避免再次误判。
  $('statusTool').textContent = isNote ? '正在编辑便签…' : '正在输入文字…';
  try {
    editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch (_) {
    /* 老版本不支持 options 对象，忽略即可 */
  }

  // 记录实际落位：如果编辑器被定位到屏幕外或尺寸为 0，这里一眼能看出来
  const box = editor.getBoundingClientRect();
  const cs = getComputedStyle(editor);
  trace(
    'openEditor kind=' + kind + ' size=' + Math.round(box.width) + 'x' + Math.round(box.height) +
    ' pos=' + Math.round(box.left) + ',' + Math.round(box.top) +
    ' display=' + cs.display + ' hidden=' + editor.hidden +
    ' active=' + (document.activeElement && document.activeElement.id)
  );

  /*
   * 延迟一帧再自检一次「到底可不可见」。
   *
   * 上面那条 trace 只说明 DOM 正常；用户报"完全看不到框"时，靠它区分不了
   * 「真没打开」和「打开了但没被绘制/被遮住」。这里在下一帧测量：
   *   opacity / visibility  —— 是否被动画或样式弄成不可见
   *   四角是否落在 viewport 内 —— 是否压根在屏幕外
   *   elementFromPoint       —— 编辑器中心点上最顶层的是不是它自己
   * 三项一起看，就能直接定位是哪一类问题，不用再猜。
   */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const b = editor.getBoundingClientRect();
      const s = getComputedStyle(editor);
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const inView =
        b.left >= 0 && b.top >= 0 &&
        b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1;
      trace(
        'openEditor自检 opacity=' + s.opacity + ' visibility=' + s.visibility +
        ' transform=' + s.transform +
        ' rect=' + [b.left, b.top, b.width, b.height].map(Math.round).join(',') +
        ' viewport=' + window.innerWidth + 'x' + window.innerHeight +
        ' 全在视口内=' + inView +
        ' 中心命中=' + (hit ? hit.id || hit.tagName : 'null') +
        ' 命中textarea=' + (hit === input)
      );
    });
  });
}

function commitEdit() {
  if (!editing) return;
  const input = $('textInput');
  const val = input.value;
  const { kind, shape, wx, wy } = editing;
  $('textEditor').hidden = true;
  editing = null;
  state.drawing = false;
  // 还原状态栏（openEditor 会把它临时改成"正在输入…"）
  $('statusTool').textContent = TOOL_NAMES[state.tool] || state.tool;

  if (shape) {
    // 编辑现有图形：内容有变化才记一条历史
    if (val !== (shape.text || '')) {
      const before = snapshot(store.shapes);
      shape.text = val;
      store.history.push(new TransformShapesCommand(store, before, snapshot(store.shapes)));
      store.history.seal(); // 编辑是独立操作，不与后续笔迹合并
      store.emit('edit');
    }
  } else if (val.trim()) {
    if (kind === 'note') {
      store.addShape({ ...makeBase('note', state.style), x: wx, y: wy, w: NOTE_W, h: NOTE_H, text: val });
    } else {
      // fontSize / align 必须显式带上：boundsOf 与 drawShape 都依赖它们，
      // 缺失会让包围盒变成 NaN 导致无法命中、双击打不开编辑器。
      store.addShape({
        ...makeBase('text', state.style),
        x: wx, y: wy, text: val,
        fontSize: state.style.fontSize,
        fontFamily: 'Segoe UI',
        align: 'left',
      });
    }
  }
  requestRender();
}

function cancelEdit() {
  $('textEditor').hidden = true;
  editing = null;
  state.drawing = false;
  $('statusTool').textContent = TOOL_NAMES[state.tool] || state.tool;
  requestRender();
}

$('textInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
    return;
  }
  if (e.key === 'Enter') {
    // Ctrl+Enter 始终提交；单看 Enter 时，文字工具直接提交，
    // 便签需要多行则交给 blur 处理（不拦截）
    const isNote = editing && editing.kind === 'note';
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      commitEdit();
    } else if (!isNote && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    }
  }
});

/**
 * 失焦提交。
 *
 * 只用 focusout 一条路径，**不要**再加全局 focusin 监听或轮询兜底。
 *
 * 踩坑记录：曾经加过「全局 focusin + 200ms 轮询」以为更可靠，结果适得其反 ——
 * 真实鼠标点击时会有焦点转移（textarea → body），
 * 于是编辑器刚打开就被判定"失焦"、立刻提交空内容并关闭，
 * 表现为「文字和便签根本编辑不了」。合成事件测试测不出这个问题，
 * 因为 dispatchEvent 不触发真实焦点转移。
 *
 * 现在只保留三处明确提交点：
 *   1. focusout（点击别处 / 切走）—— 延迟一 tick 判定，见 commitIfEditing
 *   2. Enter / Ctrl+Enter / Esc（键盘）
 *   3. 画布 pointerdown（点击画布先提交）
 *
 * 补充坑（第二期）：即使只用 focusout 也不够 —— pointerdown 处理器返回后，
 * 浏览器会执行 mousedown 的默认聚焦行为，把 textarea 的焦点抢回 canvas，
 * 于是刚打开就 focusout 被提交掉。现在靠三处配合解决：
 *   a) text/note 分支 pointerdown 里 preventDefault()，不执行默认聚焦
 *   b) openEditor 里 setTimeout(0) 二次聚焦兜底
 *   c) focusout 延迟一 tick 判焦点是否真的离开（抖动则忽略）
 */
function commitIfEditing() {
  if (!editing) return;
  /*
   * 延迟一 tick 再判，而不是立刻提交。
   *
   * 真实鼠标点画布打开编辑器时，焦点会抖一下：
   *   pointerdown → input.focus()（焦点到 textarea）
   *   → 处理器返回 → 浏览器执行 mousedown 默认聚焦（焦点被抢到 canvas）
   *   → 我们排的 setTimeout(0) 重新聚焦（焦点回到 textarea）
   * 中间的"被抢走"会触发一次 focusout。如果立刻提交，编辑器就闪一下没了。
   *
   * 所以这里等一个宏任务，看焦点最终落在哪：
   * 还在 textarea 上 → 是抖动，忽略；真的在别处 → 才提交。
   */
  setTimeout(() => {
    if (!editing) return;
    const active = document.activeElement;
    if (active === $('textInput')) return;   // 焦点又回来了，是抖动
    commitEdit();
  }, 0);
}

$('textInput').addEventListener('focusout', commitIfEditing);

/* ============================ 文件操作 ============================ */

async function save() {
  if (!store.shapes.length) {
    toast('画布是空的，没什么可存的', true);
    return false;
  }
  const defaultName = (state.filePath ? state.filePath.split(/[\\/]/).pop() : '未命名白板') + '.inkwell.json';
  const res = await window.inkwell.saveFile(defaultName, JSON.stringify(store.toJSON(), null, 2));
  if (res.ok) {
    state.filePath = res.filePath;
    state.dirty = false;
    $('fileName').textContent = res.filePath.split(/[\\/]/).pop();
    reportDirty();
    toast('已保存 ✓');
    return true;
  }
  return false; // 用户取消
}

async function open() {
  if (store.shapes.length && !confirm('当前白板未保存，确定要打开新文件吗？')) return;
  const res = await window.inkwell.openFile();
  if (!res.ok) return;
  try {
    store.loadJSON(res.data);
    store.history.clear();
    state.filePath = res.filePath;
    state.dirty = false;
    state.selection = [];
    $('fileName').textContent = res.filePath.split(/[\\/]/).pop();
    reportDirty();
    fitToContent();
    toast('已打开 ✓');
  } catch (err) {
    toast('文件格式不对，读取失败', true);
  }
}

async function exportPNG() {
  if (!store.shapes.length) {
    toast('画布是空的', true);
    return;
  }
  const c = renderer.exportPNG(store.shapes, { scale: 2, background: '#0f1115' });
  if (!c) return;
  const res = await window.inkwell.exportImage((state.filePath ? state.filePath.split(/[\\/]/).pop() : 'inkwell') + '.png', c.toDataURL('image/png'));
  if (res.ok) toast('图片已导出 ✓');
}

function fitToContent() {
  const bounds = store.shapes.map(boundsOf).filter(Boolean);
  if (!bounds.length) {
    renderer.resetView();
    requestRender();
    return;
  }
  const x = Math.min(...bounds.map((b) => b.x));
  const y = Math.min(...bounds.map((b) => b.y));
  const r = Math.max(...bounds.map((b) => b.x + b.w));
  const bt = Math.max(...bounds.map((b) => b.y + b.h));
  const pad = 60;
  const scale = Math.min(
    (renderer.cssWidth - pad * 2) / Math.max(r - x, 1),
    (renderer.cssHeight - pad * 2) / Math.max(bt - y, 1),
    3
  );
  renderer.view.scale = Math.max(0.1, scale);
  renderer.view.x = (renderer.cssWidth - (r - x) * scale) / 2 - x * scale;
  renderer.view.y = (renderer.cssHeight - (bt - y) * scale) / 2 - y * scale;
  requestRender();
}

/* ============================ 快捷键 ============================ */

const TOOL_KEYS = { v: 'select', b: 'pen', e: 'eraser', f: 'fill', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', n: 'note', h: 'hand' };

window.addEventListener('keydown', (e) => {
  if (document.activeElement === $('textInput')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  if (e.code === 'Space' && !state.spaceDown) {
    state.spaceDown = true;
    stage.classList.add('panning');
    e.preventDefault();
    return;
  }

  if (mod && k === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (mod && k === 'y') {
    e.preventDefault();
    store.redo();
    return;
  }
  if (mod && k === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (mod && k === 'o') {
    e.preventDefault();
    open();
    return;
  }
  if (mod && e.shiftKey && k === 'e') {
    e.preventDefault();
    exportPNG();
    return;
  }
  if (mod && k === 'd') {
    e.preventDefault();
    duplicate();
    return;
  }
  /*
   * 图层顺序：Ctrl+] 上移一层，Ctrl+[ 下移一层；
   * 加 Shift（即 Ctrl+} / Ctrl+{）是置顶 / 置底。
   * 注意 k 已经是小写的 e.key，Shift 时 ']' 会变成 '}'，两种都要接。
   */
  if (mod && (k === ']' || k === '}')) {
    e.preventDefault();
    reorderSelection(e.shiftKey ? 'top' : 'up');
    return;
  }
  if (mod && (k === '[' || k === '{')) {
    e.preventDefault();
    reorderSelection(e.shiftKey ? 'bottom' : 'down');
    return;
  }
  if (mod && (k === '=' || k === '+')) {
    e.preventDefault();
    renderer.zoomAt(renderer.cssWidth / 2, renderer.cssHeight / 2, 1.15);
    requestRender();
    return;
  }
  if (mod && k === '-') {
    e.preventDefault();
    renderer.zoomAt(renderer.cssWidth / 2, renderer.cssHeight / 2, 1 / 1.15);
    requestRender();
    return;
  }
  if (mod && k === '0') {
    e.preventDefault();
    fitToContent();
    return;
  }
  if (mod && k === 'a') {
    e.preventDefault();
    state.selection = store.shapes.filter((s) => !s.locked);
    requestRender();
    return;
  }
  if (e.shiftKey && e.key === '!') {
    e.preventDefault();
    fitToContent();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection.length) {
      e.preventDefault();
      store.removeShapes(state.selection.slice());
      state.selection = [];
      requestRender();
    }
    return;
  }
  if (e.key === 'Escape') {
    clearSelection();
    return;
  }
  // 选中单个文字/便签后按 Enter 直接编辑
  if (e.key === 'Enter' && state.selection.length === 1) {
    const s = state.selection[0];
    if (s.type === 'text' || s.type === 'note') {
      e.preventDefault();
      openEditor({ kind: s.type, shape: s, wx: s.x, wy: s.y });
      return;
    }
  }
  if (TOOL_KEYS[k] && !mod) {
    setTool(TOOL_KEYS[k]);
  }
  if (k === 'g' && !mod) {
    setGrid(!renderer.options.grid);
  }
  // 方向键微调
  const nudge = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  if (nudge && state.selection.length) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const before = snapshot(store.shapes);
    const snapshots = state.selection.map((s) => ({ s, d: JSON.parse(JSON.stringify(s)) }));
    snapshots.forEach(({ s, d }) => {
      const dx = nudge[0] * step;
      const dy = nudge[1] * step;
      if (s.type === 'pen' || s.type === 'eraser') s.points = d.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      else if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'note') { s.x = d.x + dx; s.y = d.y + dy; }
      else if (s.type === 'line' || s.type === 'arrow') { s.x1 = d.x1 + dx; s.y1 = d.y1 + dy; s.x2 = d.x2 + dx; s.y2 = d.y2 + dy; }
      else if (s.type === 'text') { s.x = d.x + dx; s.y = d.y + dy; }
    });
    store.history.push(new TransformShapesCommand(store, before, snapshot(store.shapes)));
    requestRender();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    state.spaceDown = false;
    if (!state.panning) stage.classList.remove('panning');
  }
});

/**
 * 未保存保护（页面内确认框）。
 *
 * 为什么不用原生弹框：原生 `showMessageBoxSync` 在部分环境下不显示或阻塞，
 * 表现为"点了叉关不掉"；`beforeunload` 更是静默拦截、什么都不提示。
 * 页面内 HTML 弹框完全可控、可见、可测。
 *
 * close 事件（同步派发）→ 主进程 preventDefault → 通知渲染进程弹框
 * → 用户选择后 ipcRenderer.send('app:close-choice', choice)
 */
function showCloseConfirm() {
  const mask = $('closeMask');
  if (!mask || !mask.hidden) return;
  mask.hidden = false;
  const btn = $('closeSave');
  if (btn) btn.focus();
}

function hideCloseConfirm() {
  const mask = $('closeMask');
  if (mask) mask.hidden = true;
}

function chooseClose(choice) {
  hideCloseConfirm();
  window.inkwell.closeChoice(choice);
}

window.inkwell.onConfirmClose(showCloseConfirm);

$('closeCancel').addEventListener('click', () => chooseClose('cancel'));
$('closeDiscard').addEventListener('click', () => chooseClose('discard'));
$('closeSave').addEventListener('click', () => chooseClose('save'));

// 弹框内键盘操作：Esc 取消，Enter 保存
$('closeMask').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); chooseClose('cancel'); }
  else if (e.key === 'Enter') { e.preventDefault(); chooseClose('save'); }
});

// 用户选择「保存」后主进程发来的存盘请求
window.inkwell.onSaveAndClose(async () => {
  try {
    await save();
    window.inkwell.saveDone(true);
  } catch (err) {
    window.inkwell.saveDone(false);
  }
});

function duplicate() {
  if (!state.selection.length) return;
  const copies = state.selection.map((s) => {
    const c = JSON.parse(JSON.stringify(s));
    c.id = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const dx = 18;
    const dy = 18;
    if (c.type === 'pen' || c.type === 'eraser') c.points = c.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    else if (c.type === 'rect' || c.type === 'ellipse' || c.type === 'note') { c.x += dx; c.y += dy; }
    else if (c.type === 'line' || c.type === 'arrow') { c.x1 += dx; c.y1 += dy; c.x2 += dx; c.y2 += dy; }
    else if (c.type === 'text') { c.x += dx; c.y += dy; }
    return c;
  });
  copies.forEach((c) => store.addShape(c));
  state.selection = copies;
  requestRender();
}

/* ============================ 图层顺序 ============================ */

/**
 * 判断选中的图形还能不能再往指定方向挪。
 * 用来置灰按钮，避免"点了没反应"。
 */
function canReorder(shapes, mode) {
  if (!shapes.length) return false;
  const ids = store.shapes.map((s) => s.id);
  const chosen = new Set(shapes.map((s) => s.id));
  const next = reorderIds(ids, chosen, mode);
  return next.some((id, i) => id !== ids[i]);
}

/** 调整选中图形的图层顺序。mode: up / down / top / bottom */
function reorderSelection(mode) {
  if (!state.selection.length) return;
  const ok = store.reorder(state.selection.slice(), mode);
  if (!ok) return;
  const label = { up: '上移一层', down: '下移一层', top: '置顶', bottom: '置底' }[mode] || '调整顺序';
  toast(`${state.selection.length > 1 ? state.selection.length + ' 个图形' : '图形'}已${label}`);
  requestRender();
  updateStatus();
}

/* ============================ 事件绑定 ============================ */

document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

$('colorPicker').addEventListener('input', (e) => {
  if (state.tool === 'fill') {
    state.style.fill = e.target.value;
    syncStyleUI();
    return;
  }
  setColor(e.target.value);
});

// 清除填充：把当前填充色设为无。之后点图形即取消其填充。
$('btnNoFill').addEventListener('click', () => {
  state.style.fill = 'transparent';
  syncStyleUI();
  toast('填充色已设为「无」，点图形即可清除填充');
});
$('widthRange').addEventListener('input', (e) => {
  state.style.width = parseInt(e.target.value, 10);
  syncStyleUI();
});
$('opacityRange').addEventListener('input', (e) => {
  state.style.opacity = parseInt(e.target.value, 10) / 100;
  syncStyleUI();
});
$('fontSizeRange').addEventListener('input', (e) => {
  state.style.fontSize = parseInt(e.target.value, 10);
  syncStyleUI();
});
$('pressureToggle').addEventListener('change', (e) => {
  state.style.pressureSensitive = e.target.checked;
  syncStyleUI();
});

$('pressureMaxRange').addEventListener('input', (e) => {
  state.style.pressureMax = parseInt(e.target.value, 10);
  $('pressureMaxValue').textContent = state.style.pressureMax;
});

/**
 * 网格开关的唯一入口（1.2.0）。
 *
 * 原来状态源是一个隐藏的 `#gridToggle` 复选框，侧栏图标只是它的代理点击。
 * 1.2.0 删掉了那个开关（改由左侧栏网格图标直接切换），
 * 所以这里改成单一函数 + `renderer.options.grid` 作为唯一状态源，
 * 图标激活态与快捷键都走它，避免出现"图标和实际状态不一致"。
 */
function setGrid(on) {
  renderer.options.grid = !!on;
  const btn = $('btnGrid');
  // .active 让图标自身显示开关状态（图标式工具栏的通行做法）
  if (btn) btn.classList.toggle('active', renderer.options.grid);
  requestRender();
}

$('btnUndo').addEventListener('click', () => store.undo());
$('btnRedo').addEventListener('click', () => store.redo());
$('btnSave').addEventListener('click', save);
$('btnOpen').addEventListener('click', open);
$('btnExport').addEventListener('click', exportPNG);
// 网格：纯图标开关，点一下翻转
$('btnGrid').addEventListener('click', () => setGrid(!renderer.options.grid));
$('btnZoomIn').addEventListener('click', () => {
  renderer.zoomAt(renderer.cssWidth / 2, renderer.cssHeight / 2, 1.2);
  requestRender();
});
$('btnZoomOut').addEventListener('click', () => {
  renderer.zoomAt(renderer.cssWidth / 2, renderer.cssHeight / 2, 1 / 1.2);
  requestRender();
});
$('zoomLabel').addEventListener('click', fitToContent);
$('btnFit').addEventListener('click', fitToContent);

/* ---------------- 自绘窗口控制（1.2.0 无边框标题栏） ---------------- */

$('btnMinimize').addEventListener('click', () => window.inkwell.minimizeWindow());
$('btnMaximize').addEventListener('click', () => window.inkwell.toggleMaximize());
/*
 * 关闭按钮：交给主进程走 mainWindow.close()，
 * 这样"有未保存内容先弹确认框"的既有逻辑照常生效。
 * 不要在渲染进程里直接 window.close()，那会绕过确认流程。
 */
$('btnWinClose').addEventListener('click', () => window.inkwell.closeWindow());

/**
 * 最大化/还原图标切换。
 * 两个 svg 常驻 DOM，靠 `hidden` 切换（样式表首部有 [hidden]{display:none!important}，
 * 比动态改 innerHTML 更稳，也不会触发重排闪烁）。
 */
function syncMaximizeIcon(isMax) {
  const maxIco = document.querySelector('#btnMaximize .ico-max');
  const restoreIco = document.querySelector('#btnMaximize .ico-restore');
  if (!maxIco || !restoreIco) return;
  maxIco.hidden = !!isMax;
  restoreIco.hidden = !isMax;
  $('btnMaximize').title = isMax ? '还原' : '最大化';
  $('btnMaximize').setAttribute('aria-label', isMax ? '还原' : '最大化');
}

if (window.inkwell.onMaximizedChange) {
  window.inkwell.onMaximizedChange(syncMaximizeIcon);
}
// 兜底：挂载后主动查一次，避免 did-finish-load 广播早于监听注册
if (window.inkwell.isMaximized) {
  window.inkwell.isMaximized().then(syncMaximizeIcon).catch(() => {});
}

$('btnDuplicate').addEventListener('click', duplicate);
$('btnRaise').addEventListener('click', () => reorderSelection('up'));
$('btnLower').addEventListener('click', () => reorderSelection('down'));
$('btnDelete').addEventListener('click', () => {
  if (!state.selection.length) return;
  store.removeShapes(state.selection.slice());
  state.selection = [];
  requestRender();
});
$('btnClear').addEventListener('click', () => {
  if (!store.shapes.length) return;
  if (confirm('清空整张画布？可以用 Ctrl+Z 撤销。')) {
    store.clear();
    state.selection = [];
    requestRender();
  }
});

/* 右键：快速菜单 */
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const p = pos(e);
  const w = renderer.toWorld(p.x, p.y);
  const hit = pick(w.x, w.y);
  if (hit) {
    state.selection = [hit];
    requestRender();
  }
});

/* ============================ 初始化 ============================ */

const ro = new ResizeObserver(() => {
  renderer.resize();
  requestRender();
});
ro.observe(stage);

renderer.resize();
buildSwatches();
syncStyleUI();
setTool('pen');
updateHistoryButtons();
updateEmptyHint();
// 网格图标初始态必须与 renderer.options.grid 一致（默认开）
setGrid(renderer.options.grid !== false);
requestRender();

window.addEventListener('resize', () => {
  renderer.resize();
  requestRender();
});

// 打开时先落在视口中心
renderer.view.x = 40;
renderer.view.y = 40;
requestRender();

window.inkwell.getInfo().then((info) => {
  console.log(`InkWell v${info.version} · Electron ${info.electron} · ${info.platform}`);
});

// 暴露给自动化测试 / 控制台调试使用
window.__inkwell = {
  version: '1.2.0',
  store,
  renderer,
  state,
  requestRender,
  setTool,
  setGrid,
  applyErase,
  hitTest,
  boundsOf,
  makeBase,
  reorderIds,
  updateStatus,
  snapshot: () => JSON.parse(JSON.stringify(store.toJSON())),
  health: () => ({
    ok: true,
    tool: state.tool,
    shapes: store.shapes.length,
    canvasW: canvas.width,
    canvasH: canvas.height,
    cssW: Math.round(canvas.getBoundingClientRect().width),
    cssH: Math.round(canvas.getBoundingClientRect().height),
    hasPointerCapture: typeof canvas.setPointerCapture === 'function',
  }),
};

// 启动自检回报给主进程，落盘到 inkwell.log
Promise.resolve()
  .then(() => window.inkwell.reportHealth(window.__inkwell.health()))
  .catch(() => { /* 预加载未就绪时忽略 */ });

// 全局错误捕获：把未处理异常连同堆栈打到控制台，主进程会写进日志
window.addEventListener('error', (e) => {
  console.error('[InkWell 未捕获异常] ' + e.message + ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  console.error('[InkWell 未处理 Promise] ' + (r && r.message ? r.message : String(r)));
});
