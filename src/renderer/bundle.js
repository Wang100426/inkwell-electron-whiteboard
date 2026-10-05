'use strict';
// 本文件由 build-bundle.js 自动生成，请勿直接修改。
// 源文件：geometry.js / history.js / board.js / app.js
/* ===== geometry.js ===== */
/** 几何工具：包围盒、点线距、贝塞尔平滑 */

/** 归一化矩形（允许负宽高） */
function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}

function expandRect(r, pad) {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 点到线段距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distToPolyline(px, py, pts) {
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (d < min) min = d;
  }
  return min;
}

/** 生成平滑曲线路径（二次贝塞尔中点法） */
function traceSmoothPath(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length < 3) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/** 用 Catmull-Rom 转 bezier 采样点，得到更干净的曲线 */
function smoothPoints(pts, tension = 0.5) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    for (let t = 0; t < 1; t += 1 / 8) {
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t * (2 * tension) +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t * (2 * tension) +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 箭头头部多边形点 */
function arrowHead(x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const baseX = x2 - size * Math.cos(angle - spread);
  const baseY = y2 - size * Math.sin(angle - spread);
  const baseX2 = x2 - size * Math.cos(angle + spread);
  const baseY2 = y2 - size * Math.sin(angle + spread);
  return [
    { x: x2, y: y2 },
    { x: baseX, y: baseY },
    { x: baseX2, y: baseY2 },
  ];
}

/* ==================== 矢量擦除几何 ==================== */

/**
 * 判断点是否落在以 path 为中心、宽度 width+2*pad 的笔画内
 */
function pointInStroke(px, py, path, width, pad = 0) {
  return distToSegment(px, py, path.x1, path.y1, path.x2, path.y2) <= width / 2 + pad;
}

/**
 * 折线（笔迹）被橡皮扫过后的分段结果。
 * 思路：把折线按"是否落入橡皮笔画内"标记，再切成连续的存活段。
 * @returns {Array<Array<{x,y}>>} 存活的分段，每段是点数组
 */
function splitPolylineByStroke(points, eraserPaths, eraserWidth) {
  if (!points.length) return [];
  const hit = (p) => eraserPaths.some((e) => pointInStroke(p.x, p.y, e, eraserWidth, 1));

  const alive = points.map((p) => !hit(p));
  // 全被擦掉
  if (alive.every((a) => !a)) return [];
  // 完全没被擦
  if (alive.every((a) => a)) return [points.slice()];

  const segments = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (alive[i]) {
      cur.push(points[i]);
    } else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  }
  if (cur.length) segments.push(cur);
  return segments.filter((s) => s.length > 0);
}

/**
 * 线段被橡皮切断后的结果（保留两端，含零长度时返回 null）
 */
function clipSegmentByStroke(x1, y1, x2, y2, eraserPaths, eraserWidth) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.001) return null;

  // 采样求交区间：粗略但对 2px 精度的橡皮足够
  const steps = Math.max(8, Math.ceil(len / 1.5));
  let inside = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    if (eraserPaths.some((e) => pointInStroke(px, py, e, eraserWidth, 0))) {
      inside.push(t);
    }
  }
  if (!inside.length) return { x1, y1, x2, y2 };

  const from = Math.min(...inside);
  const to = Math.max(...inside);
  const cutX1 = x1 + (x2 - x1) * from;
  const cutY1 = y1 + (y2 - y1) * from;
  const cutX2 = x1 + (x2 - x1) * to;
  const cutY2 = y1 + (y2 - y1) * to;

  // 切掉后剩下的两段（离得太近就丢弃）
  const keep = (ax, ay, bx, by) => (Math.hypot(bx - ax, by - ay) < 1.2 ? null : { x1: ax, y1: ay, x2: bx, y2: by });
  const parts = [
    keep(x1, y1, cutX1, cutY1),
    keep(cutX2, cutY2, x2, y2),
  ].filter(Boolean);

  return parts.length ? parts : 'REMOVED';
}

/* ==================== 变宽笔迹（压感） ==================== */

/**
 * 从 PointerEvent 提取压感信息。
 *
 * pressure 取值范围规范上是 0~1，但实际设备千差万别：
 *   - 鼠标：按下恒为 0.5（或 0），移动也是 0.5
 *   - 触摸：多数设备报 0 或 1
 *   - 手写笔：真实的 0~1 压力值
 * 因此要按 pointerType 分别处理，不能一刀切。
 */
function readPressure(e) {
  const type = e.pointerType || 'mouse';
  let p = typeof e.pressure === 'number' ? e.pressure : 0;

  if (type === 'mouse') {
    // 鼠标无压感：按住恒定返回 1（满宽），保持既有手感
    return e.buttons ? 1 : 0;
  }
  if (type === 'touch') {
    // 多数触摸屏不报压力，兜底为满宽；少数设备会报真实值
    return p > 0 && p < 1 ? p : 1;
  }
  // pen：真实压感。过滤掉明显无效的 0（多为笔尖刚接触或悬停）
  if (p <= 0) return 0.02;
  if (p >= 1) return 1;
  return p;
}

/** 该设备是否报告真实压感（用于 UI 提示） */
function hasRealPressure(e) {
  return (e.pointerType === 'pen' || e.pointerType === 'touch')
    && typeof e.pressure === 'number' && e.pressure > 0 && e.pressure < 1;
}

/**
 * 把压力映射为线宽。
 * @param {number} pressure 0~1
 * @param {number} base     基础线宽
 * @param {number} max      压感满时的线宽
 * @param {number} gamma    曲线指数，>1 让轻触更细（更接近真实笔尖）
 */
function pressureToWidth(pressure, base, max, gamma = 1.6) {
  const p = Math.max(0, Math.min(1, pressure));
  // 指数曲线：压感是类感知曲线，线性映射手感不对
  const shaped = Math.pow(p, gamma);
  return base + (max - base) * shaped;
}

/**
 * 绘制变宽笔迹。
 * 做法：逐段 stroke，每段线宽取该段两端压力的插值；
 *      再在每个采样点补一个圆，填平分段之间的接缝。
 *      （单一路径统一 lineWidth 无法表现粗细变化）
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,w?:number}>} points 已带宽度信息的点
 * @param {string} color
 * @param {number} fallbackWidth 点上没有 w 时使用
 */
function strokeVariableWidth(ctx, points, color, fallbackWidth) {
  if (!points || !points.length) return;
  const w = (i) => {
    const v = points[i] && points[i].w;
    return typeof v === 'number' && v > 0 ? v : fallbackWidth;
  };

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1) 补起点圆（单点/短笔也能正确显示）
  ctx.beginPath();
  ctx.arc(points[0].x, points[0].y, w(0) / 2, 0, Math.PI * 2);
  ctx.fill();

  // 2) 逐段描边。
  //    线宽取"较细一端"再放大一点：若取两端平均，快速转折处会出现
  //    笔画宽度超出实际轮廓的"鳞片"感。取 min 并加微量补偿更贴合笔尖形状。
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const wa = w(i - 1);
    const wb = w(i);
    const width = Math.min(wa, wb) * 1.06;
    if (width <= 0) continue;
    ctx.beginPath();
    ctx.lineWidth = width;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 3) 采样点补圆，填平接缝（尤其快速移动时）
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, w(i) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/* ===== history.js ===== */
/**
 * 历史记录：命令模式 + 合并策略
 * 连续绘制同一条笔迹合并为一条历史，避免 Ctrl+Z 一下只退一个点
 */
class History {
  constructor(limit = 300) {
    this.limit = limit;
    this.stack = [];
    this.index = -1; // 指向最后一条已执行的命令
    this._pending = null;
  }

  push(command, { mergeKey = null } = {}) {
    // 合并：与栈顶同 key 且处于连续操作中
    if (mergeKey && this._pending && this._pending.key === mergeKey) {
      this.stack[this.index] = command;
      this._pending = { key: mergeKey, command };
      return;
    }

    this.stack.length = this.index + 1; // 丢弃 redo 分支
    this.stack.push(command);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._pending = mergeKey ? { key: mergeKey, command } : null;
  }

  /** 结束合并窗口（下一次 push 若 key 不同则不会合并） */
  seal() {
    this._pending = null;
  }

  canUndo() {
    return this.index >= 0;
  }

  canRedo() {
    return this.index < this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo()) return null;
    const cmd = this.stack[this.index];
    cmd.undo();
    this.index -= 1;
    this._pending = null;
    return cmd;
  }

  redo() {
    if (!this.canRedo()) return null;
    const cmd = this.stack[this.index + 1];
    cmd.redo();
    this.index += 1;
    this._pending = null;
    return cmd;
  }

  clear() {
    this.stack = [];
    this.index = -1;
    this._pending = null;
  }

  toJSON() {
    return this.stack.slice(0, this.index + 1);
  }
}

/* ===== board.js ===== */
let idSeed = 1;
const uid = () => `s${idSeed++}_${Date.now().toString(36)}`;

/** 便签的固定底色。便签永远是这个颜色，不受填充工具/色板影响。 */
const NOTE_COLOR = '#f5c451';

/** 便签新建时的默认尺寸（世界坐标）。
 *  编辑器浮层与落盘图形必须共用这一对常量，
 *  否则会各写一份 240/220 导致输入框和纸片对不齐。 */
const NOTE_W = 220;
const NOTE_H = 160;

/** 支持填充的图形类型（便签固定色，线/箭头/笔迹无可填区域） */
const FILLABLE_TYPES = ['rect', 'ellipse'];

/* ============================ 命令 ============================ */

class AddShapeCommand {
  constructor(store, shape) {
    this.store = store;
    this.shape = shape;
  }
  redo() {
    // 若数组在别处被整体替换过，按 id 找不到了就补回，避免重复添加
    if (!this.store.shapes.some((s) => s.id === this.shape.id)) {
      this.store.shapes.push(this.shape);
    }
  }
  undo() {
    // 必须按 id 匹配：变换类命令会整体替换 shapes 数组（深拷贝），
    // 之前保存的对象引用会失效，indexOf 找不到会导致撤销无效。
    const i = this.store.shapes.findIndex((s) => s.id === this.shape.id);
    if (i >= 0) this.store.shapes.splice(i, 1);
  }
}

/**
 * 删除图形。与 AddShapeCommand 一样按 id 匹配 ——
 * 变换类命令会整体替换 shapes 数组（深拷贝），对象引用会失效。
 */
class RemoveShapesCommand {
  constructor(store, shapes) {
    this.store = store;
    this.ids = shapes.map((s) => s.id);
    this.snapshot = shapes.map((s) => JSON.parse(JSON.stringify(s)));
    this.indexes = [];
  }
  redo() {
    const ids = new Set(this.ids);
    this.indexes = [];
    this.store.shapes.forEach((s, i) => {
      if (ids.has(s.id)) this.indexes.push(i);
    });
    this.store._swapShapes(this.store.shapes.filter((s) => !ids.has(s.id)));
  }
  undo() {
    const arr = this.store.shapes.slice();
    // 按记录的索引升序插回原位，保持原有图层顺序
    [...this.indexes].sort((a, b) => a - b).forEach((pos, k) => {
      arr.splice(pos, 0, JSON.parse(JSON.stringify(this.snapshot[k])));
    });
    this.store._swapShapes(arr);
  }
}

class TransformShapesCommand {
  constructor(store, before, after) {
    this.store = store;
    this.before = before;
    this.after = after;
  }
  apply(list) {
    this.store._swapShapes(list);
  }
  redo() {
    this.apply(this.after);
  }
  undo() {
    this.apply(this.before);
  }
}

/** 深拷贝整个图形数组，用于变换类命令的快照（浅拷贝会导致撤销失效） */
function snapshot(shapes) {
  return shapes.map((s) => JSON.parse(JSON.stringify(s)));
}

/**
 * 计算调整图层顺序后的 id 数组（纯函数，便于单测）。
 *
 * @param {string[]} ids 当前顺序（越靠后越在上层）
 * @param {Set<string>} chosen 被移动的 id 集合
 * @param {'up'|'down'|'top'|'bottom'} mode
 * @returns {string[]} 新顺序
 *
 * up 的实现要点：从后往前扫（上层优先处理），遇到"选中且它后面那个没被选中"
 * 就交换 —— 这样一组相邻的选中项会整体上移一格，而不会被逐个推开。
 * 例：[A,B*,C*,D] up
 *   C 后面是 D（未选中）→ 交换 → [A,B*,D,C*]
 *   B 后面是 D（未选中）→ 交换 → [A,D,B*,C*]
 *   结果 A,D,B,C ——B、C 一起上移了一层。正确。
 */
function reorderIds(ids, chosen, mode) {
  const out = ids.slice();

  if (mode === 'top' || mode === 'bottom') {
    const picked = out.filter((id) => chosen.has(id));
    const rest = out.filter((id) => !chosen.has(id));
    return mode === 'top' ? rest.concat(picked) : picked.concat(rest);
  }

  if (mode === 'up') {
    // 从上层往下层扫，让相邻选中块整体上移
    for (let i = out.length - 2; i >= 0; i--) {
      if (chosen.has(out[i]) && !chosen.has(out[i + 1])) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
      }
    }
    return out;
  }

  if (mode === 'down') {
    // 从下层往上层扫，让相邻选中块整体下移
    for (let i = 1; i < out.length; i++) {
      if (chosen.has(out[i]) && !chosen.has(out[i - 1])) {
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
      }
    }
    return out;
  }

  return out;
}

class ReplaceAllCommand {
  constructor(store, before, after) {
    this.store = store;
    this.before = before;
    this.after = after;
  }
  redo() {
    this.store._swapShapes(this.after);
  }
  undo() {
    this.store._swapShapes(this.before);
  }
}

/**
 * 调整图层顺序（上移一层 / 下移一层 / 置顶 / 置底）。
 *
 * 实现方式：直接记录调整前后的**完整顺序**，而不是记录"交换了哪两个"。
 * 原因：多选时要整体移动（选中集合的相对顺序不能乱），
 * 记录最终顺序比推演每一步交换更简单可靠，也不怕边界情况。
 *
 * 注意：不能用对象引用做交换 —— 变换类命令会整体替换数组为深拷贝，
 * 外部引用会失效。这里按 id 重排，和 RemoveShapesCommand 一致。
 */
class ReorderShapesCommand {
  constructor(store, beforeIds, afterIds) {
    this.store = store;
    this.beforeIds = beforeIds;
    this.afterIds = afterIds;
  }
  _applyOrder(ids) {
    const byId = new Map(this.store.shapes.map((s) => [s.id, s]));
    // 按目标顺序取出对应图形；万一有新增/删除导致对不上，丢弃缺失项
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    // 兜底：把不在目标顺序里的图形补在末尾，避免"丢图形"
    this.store.shapes.forEach((s) => {
      if (!ids.includes(s.id)) next.push(s);
    });
    this.store._swapShapes(next);
  }
  redo() {
    this._applyOrder(this.afterIds);
  }
  undo() {
    this._applyOrder(this.beforeIds);
  }
}

/* ============================ Store ============================ */

class BoardStore {
  constructor() {
    this.shapes = [];
    this.history = new History();
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type = 'change') {
    this.listeners.forEach((fn) => fn(type));
  }

  addShape(shape, opts) {
    this.history.push(new AddShapeCommand(this, shape), opts);
    this.shapes.push(shape);
    this.emit('add');
  }

  /**
   * 变换类命令会整体替换 shapes 数组，外部持有的图形引用会失效。
   * 替换后按 id 重新绑定，保证选中框、hover 不掉。
   */
  _swapShapes(next) {
    const byId = new Map(this.shapes.map((s) => [s.id, s]));
    this.shapes = next;
    this.rebind = (refs) => refs.map((s) => byId.get(s.id) || s);
    this.emit('swap');
  }

  removeShapes(shapes) {
    if (!shapes.length) return;
    const cmd = new RemoveShapesCommand(this, shapes);
    this.history.push(cmd);
    cmd.redo();
  }

  /**
   * 调整图层顺序。
   *
   * @param {Array} shapes 选中的图形（按 id 匹配，不能用引用）
   * @param {'up'|'down'|'top'|'bottom'} mode 移动方式
   *
   * 数组顺序即图层顺序：越靠后越在上层（后画的盖住先画的）。
   * - up     ：每个选中项尽量向后（向上）移一格
   * - down   ：每个选中项尽量向前（向下）移一格
   * - top    ：选中项整体移到数组末尾，保持其内部相对顺序
   * - bottom ：选中项整体移到数组开头，保持其内部相对顺序
   *
   * 多选时按"相对顺序不变"整体移动，且相邻的选中项不会互相挤占
   * （一次操作最多整体上/下移一层，而不是被逐个推着走）。
   */
  reorder(shapes, mode) {
    if (!shapes.length) return false;
    const chosen = new Set(shapes.map((s) => s.id));
    const beforeIds = this.shapes.map((s) => s.id);
    const afterIds = reorderIds(beforeIds, chosen, mode);
    // 顺序没变就什么都不做，避免塞一条无意义的撤销记录
    if (afterIds.every((id, i) => id === beforeIds[i])) return false;
    const cmd = new ReorderShapesCommand(this, beforeIds, afterIds);
    this.history.push(cmd);
    cmd.redo();
    return true;
  }

  replaceAll(newShapes, { record = true } = {}) {
    const before = this.shapes;
    if (record) this.history.push(new ReplaceAllCommand(this, before, newShapes));
    this.shapes = newShapes;
    this.emit('replace');
  }

  undo() {
    const c = this.history.undo();
    if (c) this.emit('undo');
    return c;
  }

  redo() {
    const c = this.history.redo();
    if (c) this.emit('redo');
    return c;
  }

  clear() {
    if (!this.shapes.length) return;
    this.replaceAll([]);
  }

  toJSON() {
    return { version: 1, shapes: this.shapes };
  }

  loadJSON(data) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const shapes = Array.isArray(parsed) ? parsed : parsed.shapes || [];
    this.replaceAll(shapes.map(normalizeShape));
  }
}

/* ============================ 图形 ============================ */

function makeBase(tool, style) {
  const base = {
    id: uid(),
    type: tool,
    color: style.color,
    fill: style.fill,
    // 新图形一律不带填充 —— 填充改由「填充」工具显式施加。
    // 这样切工具（尤其便签）不会污染后续图形的外观。
    fillEnabled: false,
    width: style.width,
    opacity: style.opacity ?? 1,
    locked: false,
  };
  // 文字专属字段：必须在这里给全默认值。
  // 缺失 fontSize 会让 boundsOf 算出 NaN，命中检测静默失效（双击/选中都无效）。
  if (tool === 'text') {
    base.text = '';
    base.fontSize = style.fontSize || 20;
    base.fontFamily = 'Segoe UI';
    base.align = 'left';
  }
  if (tool === 'note') {
    base.text = '';
    // 便签是固定黄色纸片，与填充色板完全解耦。
    // 曾经便签工具会写全局 style.fill/fillEnabled，导致之后画的矩形
    // 莫名被填成黄色 —— 那个耦合已移除，这里写死便签自己的颜色。
    base.fill = NOTE_COLOR;
    base.fillEnabled = true;
  }
  // 压感笔迹：pressureSensitive 标记该笔迹按压力变宽（每个点带 w）
  if (tool === 'pen' || tool === 'eraser') {
    base.pressureSensitive = !!style.pressureSensitive;
    if (tool === 'pen') {
      base.pressureMax = style.pressureMax || style.width * 4;
    }
  }
  return base;
}

function normalizeShape(s) {
  const base = {
    id: s.id || uid(),
    type: s.type || 'pen',
    color: s.color || '#e8ecf4',
    fill: s.fill || 'transparent',
    fillEnabled: !!s.fillEnabled,
    width: s.width || 3,
    opacity: s.opacity ?? 1,
    locked: !!s.locked,
  };
  if (base.type === 'pen' || base.type === 'eraser') {
    // 必须保留每个采样点的宽度 w，否则读档后压感笔迹会退化成等宽
    base.points = (s.points || []).map((p) => {
      const pt = { x: p.x, y: p.y };
      if (typeof p.w === 'number' && p.w > 0) pt.w = p.w;
      return pt;
    });
    base.pressureSensitive = !!s.pressureSensitive;
    if (s.pressureMax) base.pressureMax = s.pressureMax;
  } else if (base.type === 'rect' || base.type === 'ellipse') {
    Object.assign(base, normalizeRect(s.x, s.y, s.x + s.w, s.y + s.h));
  } else if (base.type === 'line' || base.type === 'arrow') {
    base.x1 = s.x1;
    base.y1 = s.y1;
    base.x2 = s.x2;
    base.y2 = s.y2;
  } else if (base.type === 'text') {
    base.x = s.x;
    base.y = s.y;
    base.text = s.text || '';
    base.fontSize = s.fontSize || 20;
    base.fontFamily = s.fontFamily || 'Segoe UI';
    base.align = s.align || 'left';
  } else if (base.type === 'note') {
    Object.assign(base, normalizeRect(s.x, s.y, s.x + s.w, s.y + s.h));
    base.text = s.text || '';
  }
  return base;
}

/** 图形包围盒（世界坐标） */
function boundsOf(shape) {
  switch (shape.type) {
    case 'pen':
    case 'eraser': {
      if (!shape.points.length) return null;
      let r = null;
      for (const p of shape.points) {
        r = unionRect(r, { x: p.x, y: p.y, w: 0, h: 0 });
      }
      return expandRect(r, shape.width / 2 + 1);
    }
    case 'rect':
    case 'ellipse':
    case 'note':
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case 'line':
    case 'arrow':
      return normalizeRect(shape.x1, shape.y1, shape.x2, shape.y2);
    case 'text': {
      // 防御：fontSize 缺失时不能让包围盒变成 NaN，
      // 否则命中检测静默失效（双击/选中都打不开），且极难排查。
      const fs = Number(shape.fontSize) > 0 ? shape.fontSize : 20;
      const text = String(shape.text == null ? '' : shape.text);
      const w = Math.max(10, text.length * fs * 0.55);
      return { x: shape.x, y: shape.y - fs, w, h: fs * 1.35 };
    }
    default:
      return null;
  }
}

/** 命中检测：返回最上层命中的图形 */
function hitTest(shape, wx, wy, tolerance) {
  const tol = Math.max(tolerance, shape.width / 2 + 3);
  switch (shape.type) {
    case 'pen':
    case 'eraser':
      return distToPolyline(wx, wy, shape.points) <= tol;
    case 'rect': {
      const r = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
      if (shape.fillEnabled && pointInRect(wx, wy, r)) return true;
      return (
        distToSegment(wx, wy, r.x, r.y, r.x + r.w, r.y) <= tol ||
        distToSegment(wx, wy, r.x + r.w, r.y, r.x + r.w, r.y + r.h) <= tol ||
        distToSegment(wx, wy, r.x + r.w, r.y + r.h, r.x, r.y + r.h) <= tol ||
        distToSegment(wx, wy, r.x, r.y + r.h, r.x, r.y) <= tol
      );
    }
    case 'ellipse': {
      const cx = shape.x + shape.w / 2;
      const cy = shape.y + shape.h / 2;
      const rx = Math.max(shape.w / 2, 0.001);
      const ry = Math.max(shape.h / 2, 0.001);
      const nx = (wx - cx) / rx;
      const ny = (wy - cy) / ry;
      const d = Math.hypot(nx, ny);
      if (shape.fillEnabled && d <= 1) return true;
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
    }
    case 'line':
      return distToSegment(wx, wy, shape.x1, shape.y1, shape.x2, shape.y2) <= tol;
    case 'arrow': {
      if (distToSegment(wx, wy, shape.x1, shape.y1, shape.x2, shape.y2) <= tol) return true;
      const head = arrowHead(shape.x1, shape.y1, shape.x2, shape.y2, Math.max(12, shape.width * 3));
      return (
        distToSegment(wx, wy, head[0].x, head[0].y, head[1].x, head[1].y) <= tol ||
        distToSegment(wx, wy, head[0].x, head[0].y, head[2].x, head[2].y) <= tol
      );
    }
    case 'text':
    case 'note': {
      const b = boundsOf(shape);
      return b ? pointInRect(wx, wy, expandRect(b, 4)) : false;
    }
    default:
      return false;
  }
}

/* ============================ Renderer ============================ */

class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.view = { x: 0, y: 0, scale: 1 };
    this.options = { grid: true, gridSize: 28, snap: false };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
  }

  /** 屏幕坐标 → 世界坐标 */
  toWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.scale, y: (sy - this.view.y) / this.view.scale };
  }

  toScreen(wx, wy) {
    return { x: wx * this.view.scale + this.view.x, y: wy * this.view.scale + this.view.y };
  }

  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    const next = Math.min(8, Math.max(0.1, this.view.scale * factor));
    this.view.scale = next;
    this.view.x = sx - before.x * next;
    this.view.y = sy - before.y * next;
  }

  resetView() {
    this.view = { x: 0, y: 0, scale: 1 };
  }

  drawGrid(ctx) {
    if (!this.options.grid) return;
    const gs = this.options.gridSize * this.view.scale;
    if (gs < 8) return;
    const ox = this.view.x % gs;
    const oy = this.view.y % gs;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < this.cssWidth; x += gs) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.cssHeight);
    }
    for (let y = oy; y < this.cssHeight; y += gs) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.cssWidth, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 绘制单个图形（ctx 已处于世界坐标系） */
  drawShape(ctx, shape) {
    ctx.save();
    ctx.globalAlpha = shape.opacity ?? 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.fill;
    ctx.lineWidth = shape.width;

    switch (shape.type) {
      case 'pen': {
        if (!shape.points.length) break;
        // 变宽笔迹（压感）走专用渲染：逐段插值线宽 + 接缝补圆。
        // 统一 lineWidth 的单路径 stroke 无法表现粗细变化。
        if (shape.pressureSensitive && shape.points.some((p) => typeof p.w === 'number')) {
          strokeVariableWidth(ctx, shape.points, shape.color, shape.width);
        } else {
          ctx.beginPath();
          traceSmoothPath(ctx, shape.points);
          ctx.stroke();
          // 单点补一个圆点
          if (shape.points.length === 1) {
            ctx.beginPath();
            ctx.arc(shape.points[0].x, shape.points[0].y, shape.width / 2, 0, Math.PI * 2);
            ctx.fillStyle = shape.color;
            ctx.fill();
          }
        }
        break;
      }
      case 'eraser': {
        if (!shape.points.length) break;
        ctx.beginPath();
        traceSmoothPath(ctx, shape.points);
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.stroke();
        break;
      }
      case 'rect': {
        const r = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        const radius = Math.min(8, shape.w / 6, shape.h / 6);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, radius);
        else ctx.rect(r.x, r.y, r.w, r.h);
        if (shape.fillEnabled) ctx.fill();
        ctx.stroke();
        break;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(
          shape.x + shape.w / 2,
          shape.y + shape.h / 2,
          Math.max(shape.w / 2, 0.1),
          Math.max(shape.h / 2, 0.1),
          0,
          0,
          Math.PI * 2
        );
        if (shape.fillEnabled) ctx.fill();
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(shape.x2, shape.y2);
        ctx.stroke();
        break;
      }
      case 'arrow': {
        const size = Math.max(12, shape.width * 3.2);
        const head = arrowHead(shape.x1, shape.y1, shape.x2, shape.y2, size);
        // 缩短主线让箭头更干净
        const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
        const sx = shape.x2 - size * 0.82 * Math.cos(angle);
        const sy = shape.y2 - size * 0.82 * Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(head[0].x, head[0].y);
        ctx.lineTo(head[1].x, head[1].y);
        ctx.lineTo(head[2].x, head[2].y);
        ctx.closePath();
        ctx.fillStyle = shape.color;
        ctx.fill();
        break;
      }
      case 'text': {
        const fs = Number(shape.fontSize) > 0 ? shape.fontSize : 20;
        ctx.fillStyle = shape.color;
        ctx.font = `${fs}px "${shape.fontFamily || 'Segoe UI'}", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = shape.align || 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(shape.text == null ? '' : shape.text), shape.x, shape.y);
        break;
      }
      case 'note': {
        const r = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 6;
        ctx.fillStyle = shape.fill && shape.fill !== 'transparent' ? shape.fill : NOTE_COLOR;
        if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 10);
        else ctx.rect(r.x, r.y, r.w, r.h);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(30,30,40,0.88)';
        ctx.font = `16px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textBaseline = 'top';
        wrapText(ctx, String(shape.text == null ? '' : shape.text), r.x + 14, r.y + 14, r.w - 28, 22);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  /**
   * @param {object} state 交互状态（tool/draft/selection/hoverId）
   * @param {Array} shapes 图形数据。单独传入而非从 state 解构 ——
   *        图形的所有权在 store，state 只是"正在画的那个"。
   */
  render(state, shapes = []) {
    const ctx = this.ctx;
    const { draft, selection, hoverId } = state;
    const list = Array.isArray(shapes) ? shapes : [];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 背景
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawGrid(ctx);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);

    // 橡皮已改为矢量擦除（数据层面裁剪），渲染只需按序绘制普通图形。
    // 兼容旧数据：若文件中残留 eraser 图形则跳过，避免 destination-out 破坏画面。
    for (const s of list) {
      if (s.type === 'eraser') continue;
      this.drawShape(ctx, s);
    }

    // 橡皮拖动时的实时预览
    if (state.erasing) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = state.erasing.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      state.erasing.paths.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
      });
      ctx.stroke();
      ctx.restore();
    }

    if (draft) this.drawShape(ctx, draft);

    // 选中框
    if (selection && selection.length) {
      const b = selection.map(boundsOf).filter(Boolean).reduce((a, r) => unionRect(a, r), null);
      if (b) {
        const pad = 6 / this.view.scale;
        ctx.save();
        ctx.strokeStyle = '#4c8dff';
        ctx.lineWidth = 1.5 / this.view.scale;
        ctx.setLineDash([6 / this.view.scale, 4 / this.view.scale]);
        ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    if (hoverId && !(selection && selection.length)) {
      const s = list.find((x) => x.id === hoverId);
      const b = s && boundsOf(s);
      if (b) {
        const pad = 3 / this.view.scale;
        ctx.save();
        ctx.strokeStyle = 'rgba(76,141,255,0.6)';
        ctx.lineWidth = 1 / this.view.scale;
        ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
        ctx.restore();
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** 导出 PNG：可指定背景色（null = 透明） */
  exportPNG(shapes, { scale = 2, background = '#ffffff', padding = 48 } = {}) {
    const bounds = shapes.map(boundsOf).filter(Boolean).reduce((a, r) => unionRect(a, r), null);
    if (!bounds) return null;
    const b = expandRect(bounds, padding);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(b.w * scale);
    canvas.height = Math.ceil(b.h * scale);
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(scale, 0, 0, scale, -b.x * scale, -b.y * scale);

    // 橡皮已改为矢量擦除，这里不存在 destination-out 逻辑；
    // 仅跳过历史文件里可能残留的 eraser 图形。
    shapes.forEach((s) => {
      if (s.type === 'eraser') return;
      this.drawShape(ctx, s);
    });

    // 附带 bounds，方便调用方（如导出裁剪、测试）换算坐标
    canvas.__bounds = b;
    canvas.__scale = scale;
    return canvas;
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  if (!text) return;
  const paragraphs = String(text).split('\n');
  let cy = y;
  for (const para of paragraphs) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, cy);
        line = ch;
        cy += lineHeight;
      } else {
        line = test;
      }
    }
    ctx.fillText(line, x, cy);
    cy += lineHeight;
  }
}

/* ===== eraser.js ===== */
/**
 * 矢量擦除：橡皮不再作为"图形"参与渲染，而是真正修改它覆盖的图形数据。
 *
 * 早前实现把 eraser 存进 shapes 数组、靠 z-order 混合渲染（destination-out），
 * 带来两个问题：
 *   1. 橡皮会出现在选区、图形计数、保存的 JSON 里，语义混乱；
 *   2. 导出 PNG、撤销、命中检测都得特判 eraser，逻辑四处分散。
 *
 * 现在改为纯数据操作：
 *   - pen/eraser 笔迹 → 按擦除区间切成多段（splitPolylineByStroke）
 *   - line/arrow      → 线段被切断（clipSegmentByStroke）
 *   - rect/ellipse    → 整块命中即删除（部分裁剪留给后续增强）
 *   - text/note       → 命中即删除
 */



/** 单个图形是否与擦除路径相交 */
function shapeHit(shape, paths, width) {
  switch (shape.type) {
    case 'pen':
      return distToPolyline && paths.some((p) => {
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const px = p.x1 + (p.x2 - p.x1) * t;
          const py = p.y1 + (p.y2 - p.y1) * t;
          if (distToPolyline(px, py, shape.points) <= width / 2) return true;
        }
        return false;
      });
    case 'line':
    case 'arrow':
      return paths.some((p) => {
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const px = p.x1 + (p.x2 - p.x1) * t;
          const py = p.y1 + (p.y2 - p.y1) * t;
          if (pointInStroke(px, py, p, width)) return true;
        }
        return false;
      });
    case 'rect':
    case 'note':
      return paths.some((p) => {
        const b = boundsOf(shape);
        // 线段与矩形相交（粗判：端点在内 或 线段中点在矩形内 或 边相交）
        if (pointInRect(p.x1, p.y1, b) || pointInRect(p.x2, p.y2, b)) return true;
        const mx = (p.x1 + p.x2) / 2;
        const my = (p.y1 + p.y2) / 2;
        if (pointInRect(mx, my, b)) return true;
        return segIntersectsRect(p.x1, p.y1, p.x2, p.y2, b);
      });
    case 'ellipse': {
      const cx = shape.x + shape.w / 2;
      const cy = shape.y + shape.h / 2;
      const rx = Math.max(shape.w / 2, 0.001);
      const ry = Math.max(shape.h / 2, 0.001);
      return paths.some((p) => {
        const steps = 12;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const px = p.x1 + (p.x2 - p.x1) * t;
          const py = p.y1 + (p.y2 - p.y1) * t;
          const nx = (px - cx) / rx;
          const ny = (py - cy) / ry;
          // 线宽的一半换算到归一化空间（近似）
          if (Math.hypot(nx, ny) <= 1 + (width / 2) / Math.min(rx, ry)) return true;
        }
        return false;
      });
    }
    case 'text': {
      const b = boundsOf(shape);
      return paths.some((p) => {
        if (pointInRect(p.x1, p.y1, b) || pointInRect(p.x2, p.y2, b)) return true;
        const mx = (p.x1 + p.x2) / 2;
        const my = (p.y1 + p.y2) / 2;
        return pointInRect(mx, my, b);
      });
    }
    default:
      return false;
  }
}

/** 线段与矩形是否相交（含边相交） */
function segIntersectsRect(x1, y1, x2, y2, r) {
  const inside = (x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  const seg = (ax, ay, bx, by) => {
    // Liang-Barsky 线段裁剪
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - r.x, r.x + r.w - ax, ay - r.y, r.y + r.h - ay];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        const t = q[i] / p[i];
        if (p[i] < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
      }
    }
    return true;
  };
  return (
    seg(x1, y1, x2, y2, r) ||
    seg(x1, y1, x2, y2, { x: r.x, y: r.y, w: r.w, h: r.h })
  );
}

/**
 * 对图形数组施加一次擦除，返回新数组。
 * @param {Array} shapes  原图形数组（不会被修改）
 * @param {Array<{x1,y1,x2,y2}>} paths 本次橡皮扫过的线段集合
 * @param {number} width 橡皮宽度
 * @returns {{shapes: Array, changed: boolean}}
 */
function applyErase(shapes, paths, width) {
  if (!paths.length) return { shapes: shapes.slice(), changed: false };

  const out = [];
  let changed = false;

  for (const s of shapes) {
    if (s.type === 'eraser') {
      // 兼容旧数据：历史文件里可能存有 eraser，直接丢弃
      changed = true;
      continue;
    }

    if (!shapeHit(s, paths, width)) {
      out.push(s);
      continue;
    }

    changed = true;

    if (s.type === 'pen') {
      const segs = splitPolylineByStroke(s.points, paths, width);
      segs.forEach((pts) => {
        out.push({ ...s, id: s.id + '_' + Math.random().toString(36).slice(2, 7), points: pts });
      });
      continue;
    }

    if (s.type === 'line' || s.type === 'arrow') {
      const res = clipSegmentByStroke(s.x1, s.y1, s.x2, s.y2, paths, width);
      if (res === 'REMOVED') continue;
      if (Array.isArray(res)) {
        res.forEach((p, i) => {
          out.push({ ...s, id: s.id + '_' + i + '_' + Math.random().toString(36).slice(2, 7), ...p });
        });
      } else {
        out.push({ ...s, x1: res.x1, y1: res.y1, x2: res.x2, y2: res.y2 });
      }
      continue;
    }

    // rect / ellipse / text / note：整块删除
  }

  return { shapes: out, changed };
}

/* ===== app.js ===== */
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
