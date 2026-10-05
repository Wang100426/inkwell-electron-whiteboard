'use strict';

/**
 * 手写笔压感专项测试。
 * 覆盖：压力读取、宽度映射、变宽渲染、笔迹点宽度持久化、笔杆橡皮端。
 * 用法：node scripts/test-pressure.js  （纯 Node，不需要 Electron）
 */

const {
  readPressure,
  pressureToWidth,
  hasRealPressure,
  strokeVariableWidth,
} = require('../src/renderer/geometry.js');

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

/** 构造伪 PointerEvent */
function ev(type, pressure, buttons = 1, pointerType = 'pen') {
  return { pointerType, pressure, buttons };
}

console.log('\n手写笔压感测试\n');

/* ---------- 1. 压力读取：按设备类型区分 ---------- */
{
  const penLight = readPressure(ev('move', 0.2, 1, 'pen'));
  const penHeavy = readPressure(ev('move', 0.95, 1, 'pen'));
  check('手写笔读到的压力随力度变化', penHeavy > penLight, { penLight, penHeavy });
  check('手写笔轻压接近 0.2', Math.abs(penLight - 0.2) < 0.01, penLight);
  check('手写笔重压接近 0.95', Math.abs(penHeavy - 0.95) < 0.01, penHeavy);

  const penZero = readPressure(ev('move', 0, 1, 'pen'));
  check('手写笔压力为 0 时兜底为极小值', penZero > 0 && penZero < 0.1, penZero);

  const mouseDown = readPressure(ev('move', 0.5, 1, 'mouse'));
  const mouseUp = readPressure(ev('move', 0, 0, 'mouse'));
  check('鼠标按下恒为满宽（无压感）', mouseDown === 1, mouseDown);
  check('鼠标未按下为 0', mouseUp === 0, mouseUp);

  const touchFlat = readPressure(ev('move', 0, 1, 'touch'));
  const touchReal = readPressure(ev('move', 0.6, 1, 'touch'));
  check('无压感触摸屏兜底为满宽', touchFlat === 1, touchFlat);
  check('有压感触摸屏读真实值', Math.abs(touchReal - 0.6) < 0.01, touchReal);
}

/* ---------- 2. 压力 → 宽度映射 ---------- */
{
  const base = 3;
  const max = 20;
  const wLight = pressureToWidth(0.1, base, max);
  const wMid = pressureToWidth(0.5, base, max);
  const wHeavy = pressureToWidth(1, base, max);

  check('压力越大笔画越粗', wLight < wMid && wMid < wHeavy, { wLight, wMid, wHeavy });
  check('零压力约等于基础宽度', Math.abs(pressureToWidth(0, base, max) - base) < 0.001);
  check('满压力等于最大宽度', Math.abs(wHeavy - max) < 0.001, wHeavy);
  check('轻压明显细于中压（指数曲线生效）', wLight < wMid * 0.6, { wLight, wMid });
  check('宽度不超出上下界', pressureToWidth(5, base, max) === max && pressureToWidth(-1, base, max) === base);
}

/* ---------- 3. 变宽渲染不抛错 ---------- */
{
  // 用极简 ctx 桩，验证绘制调用序列
  const calls = { arc: 0, stroke: 0, begin: 0 };
  const ctx = {
    save() {}, restore() {},
    beginPath() { calls.begin++; },
    moveTo() {}, lineTo() {},
    arc() { calls.arc++; },
    fill() {}, stroke() { calls.stroke++; },
    set strokeStyle(v) {}, set fillStyle(v) {},
    set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {},
  };

  const pts = [
    { x: 0, y: 0, w: 2 },
    { x: 10, y: 0, w: 8 },
    { x: 20, y: 0, w: 16 },
    { x: 30, y: 0, w: 4 },
  ];
  strokeVariableWidth(ctx, pts, '#fff', 3);
  check('变宽渲染执行了多段描边', calls.stroke >= 3, calls);
  check('变宽渲染补了接缝圆点', calls.arc >= 4, calls);

  // 空输入不应崩溃
  strokeVariableWidth(ctx, [], '#fff', 3);
  strokeVariableWidth(ctx, null, '#fff', 3);
  check('空点集不崩溃', true);

  // 单点
  const before = calls.arc;
  strokeVariableWidth(ctx, [{ x: 5, y: 5, w: 4 }], '#fff', 3);
  check('单点也能绘制', calls.arc > before, calls);
}

/* ---------- 4. 笔迹宽度数据可序列化 ---------- */
{
  const points = [{ x: 0, y: 0, w: 3 }, { x: 1, y: 1, w: 9 }];
  const round = JSON.parse(JSON.stringify(points));
  check('宽度字段可 JSON 往返', round[1].w === 9, round);

  // 缺 w 的点（鼠标/旧文件）应回退到 fallback
  const mixed = [{ x: 0, y: 0 }, { x: 5, y: 5, w: 7 }];
  const calls = { arc: 0, stroke: 0, begin: 0 };
  const ctx = {
    save() {}, restore() {}, beginPath() { calls.begin++; },
    moveTo() {}, lineTo() {}, arc() { calls.arc++; },
    fill() {}, stroke() { calls.stroke++; },
    set strokeStyle(v) {}, set fillStyle(v) {},
    set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {},
  };
  strokeVariableWidth(ctx, mixed, '#fff', 5);
  check('缺失 w 的点回退到默认宽度', calls.stroke >= 1 && calls.arc >= 2, calls);
}

/* ---------- 5. 真实压感检测 ---------- */
{
  check('识别真实压感（手写笔 0~1 之间）', hasRealPressure(ev('m', 0.4, 1, 'pen')) === true);
  check('鼠标不算真实压感', hasRealPressure(ev('m', 0.4, 1, 'mouse')) === false);
  check('触摸屏满压不算真实压感', hasRealPressure(ev('m', 1, 1, 'touch')) === false);
  check('手写笔满压不算（0~1 之外）', hasRealPressure(ev('m', 1, 1, 'pen')) === false);
}

/* ---------- 6. 压感曲线单调性 ---------- */
{
  let prev = 0;
  let monotonic = true;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const w = pressureToWidth(p, 2, 24);
    if (w < prev - 1e-9) monotonic = false;
    prev = w;
  }
  check('宽度曲线单调递增', monotonic);
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
process.exit(fail ? 1 : 0);
