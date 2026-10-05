'use strict';

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

module.exports = {
  normalizeRect,
  unionRect,
  expandRect,
  pointInRect,
  distToSegment,
  distToPolyline,
  traceSmoothPath,
  smoothPoints,
  arrowHead,
  pointInStroke,
  splitPolylineByStroke,
  clipSegmentByStroke,
  readPressure,
  hasRealPressure,
  pressureToWidth,
  strokeVariableWidth,
};
