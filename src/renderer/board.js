'use strict';

const {
  normalizeRect,
  unionRect,
  expandRect,
  pointInRect,
  distToSegment,
  distToPolyline,
  traceSmoothPath,
  smoothPoints,
  arrowHead,
  strokeVariableWidth,
} = require('./geometry');
const { History } = require('./history');

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

module.exports = {
  BoardStore,
  BoardRenderer,
  hitTest,
  boundsOf,
  makeBase,
  normalizeShape,
  snapshot,
  AddShapeCommand,
  TransformShapesCommand,
  ReorderShapesCommand,
  reorderIds,
  uid,
  NOTE_COLOR,
  NOTE_W,
  NOTE_H,
  FILLABLE_TYPES,
};
