'use strict';

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

const {
  splitPolylineByStroke,
  clipSegmentByStroke,
  distToPolyline,
  pointInStroke,
  pointInRect,
} = require('./geometry');
const { boundsOf } = require('./board');

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

module.exports = { applyErase, shapeHit, segIntersectsRect };
