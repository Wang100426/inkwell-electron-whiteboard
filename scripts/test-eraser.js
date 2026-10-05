'use strict';

/**
 * 矢量擦除专项测试（Node 环境，无需启动 Electron）。
 * 验证：橡皮是数据层裁剪，而非渲染层 destination-out。
 * 用法：node scripts/test-eraser.js
 */

const path = require('path');

// bundle 后的渲染层依赖 DOM，这里只测纯逻辑，因此直接加载源文件的算法部分
const { applyErase, shapeHit, segIntersectsRect } = (() => {
  // 极简模块加载：手写 require 桥接
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  return require('../src/renderer/eraser.js');
})();

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  \u2713 ' + name);
    pass++;
  } else {
    console.log('  \u2717 ' + name + (detail ? '  → ' + detail : ''));
    fail++;
  }
}

const pen = (id, pts, width = 4) => ({
  id, type: 'pen', color: '#fff', fill: 'transparent', fillEnabled: false,
  width, opacity: 1, points: pts,
});
const line = (id, x1, y1, x2, y2) => ({
  id, type: 'line', color: '#fff', fill: 'transparent', fillEnabled: false,
  width: 4, opacity: 1, x1, y1, x2, y2,
});
const rect = (id, x, y, w, h) => ({
  id, type: 'rect', color: '#fff', fill: 'transparent', fillEnabled: false,
  width: 3, opacity: 1, x, y, w, h,
});

console.log('\n矢量擦除测试\n');

// 1. 笔迹被中间切断 → 分成两段
{
  const pts = [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }];
  const { shapes } = applyErase([pen('p1', pts)], [{ x1: 90, y1: 100, x2: 130, y2: 100 }], 20);
  const penShapes = shapes.filter((s) => s.type === 'pen');
  check('笔迹中间被擦 → 分成 2 段', penShapes.length === 2, `实际 ${penShapes.length} 段`);
  check('分段后没有 eraser 图形', !shapes.some((s) => s.type === 'eraser'));
  check(
    '两段都保留原有端点范围',
    penShapes.length === 2 &&
      Math.min(...penShapes[0].points.map((p) => p.x)) === 0 &&
      Math.max(...penShapes[1].points.map((p) => p.x)) === 300
  );
}

// 2. 笔迹完全被覆盖 → 消失
{
  const pts = [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }];
  const { shapes } = applyErase([pen('p1', pts)], [{ x1: -20, y1: 50, x2: 120, y2: 50 }], 40);
  check('笔迹被完全擦除 → 图形消失', shapes.length === 0, `剩余 ${shapes.length}`);
}

// 3. 擦不到 → 原样返回，changed=false
{
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const r = applyErase([pen('p1', pts)], [{ x1: 0, y1: 500, x2: 100, y2: 500 }], 10);
  check('擦不到任何图形 → changed=false', r.changed === false);
  check('擦不到时图形数不变', r.shapes.length === 1);
}

// 4. 线段被切断
{
  const r = applyErase([line('l1', 0, 200, 300, 200)], [{ x1: 140, y1: 200, x2: 160, y2: 200 }], 16);
  check('线段被擦 → 变成 2 段', r.shapes.length === 2, `实际 ${r.shapes.length}`);
  check('两段都是 line 类型', r.shapes.every((s) => s.type === 'line'));
}

// 5. 矩形被碰到 → 删除
{
  const r = applyErase([rect('r1', 100, 100, 80, 80)], [{ x1: 140, y1: 140, x2: 145, y2: 145 }], 10);
  check('矩形被擦 → 删除', r.shapes.length === 0, `剩余 ${r.shapes.length}`);
}

// 6. 多个图形，只擦中一个
{
  const shapes = [
    pen('p1', [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
    pen('p2', [{ x: 0, y: 300 }, { x: 100, y: 300 }]),
  ];
  const r = applyErase(shapes, [{ x1: -10, y1: 0, x2: 110, y2: 0 }], 20);
  check('只擦中指定的图形，另一个保留', r.shapes.length >= 1 && r.shapes.some((s) => s.id.startsWith('p2')));
}

// 7. 旧数据里的 eraser 图形被丢弃
{
  const old = [{ id: 'e1', type: 'eraser', color: '#000', width: 20, opacity: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }];
  const r = applyErase(old, [{ x1: 0, y1: 0, x2: 10, y2: 10 }], 10);
  check('历史文件中的 eraser 图形被清理', !r.shapes.some((s) => s.type === 'eraser'));
}

// 8. 几何辅助函数
{
  const b = { x: 0, y: 0, w: 100, h: 100 };
  check('线段穿过矩形 → true', segIntersectsRect(-10, 50, 200, 50, b) === true);
  check('线段远离矩形 → false', segIntersectsRect(-10, 500, 200, 500, b) === false);
}

// 9. 擦除后仍能被再次擦除（幂等性检查：擦两次不报错）
{
  const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
  const first = applyErase([pen('p1', pts)], [{ x1: 90, y1: 0, x2: 110, y2: 0 }], 20);
  const second = applyErase(first.shapes, [{ x1: 20, y1: 0, x2: 40, y2: 0 }], 20);
  check('擦除结果可继续被擦除', Array.isArray(second.shapes));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
