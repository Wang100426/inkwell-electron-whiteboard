'use strict';
/*
 * test-format.js —— .inkwell 文件格式与版本门禁（纯 Node，不需要 Electron）
 *
 * 覆盖：
 *   A. parseVersion / compareVersion 的边界
 *   B. canOpenFileVersion 的门禁规则（只拦主版本号更高的文件）
 *   C. toJSON 写出的字段（format / appVersion / version / shapesVersion）
 *   D. loadJSON 对合法文件 / 旧格式 / 高版本文件的处理
 *   E. 拒绝时**不能污染画布**（这是版本门禁的核心保证）
 */

const assert = require('assert');
const path = require('path');

const {
  BoardStore,
  INKWELL_APP_VERSION,
  SHAPES_VERSION,
  parseVersion,
  compareVersion,
  canOpenFileVersion,
} = require(path.join('..', 'src', 'renderer', 'board.js'));

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + (detail === undefined ? '' : '  \u2192 ' + JSON.stringify(detail)));
  }
}

/* ---------- A. parseVersion / compareVersion ---------- */
console.log('\n[A] 版本号解析与比较');

check('parseVersion("1.3.0") = [1,3,0]', JSON.stringify(parseVersion('1.3.0')) === '[1,3,0]', parseVersion('1.3.0'));
check('parseVersion("2.0.0-beta.1") = [2,0,0]', JSON.stringify(parseVersion('2.0.0-beta.1')) === '[2,0,0]', parseVersion('2.0.0-beta.1'));
check('parseVersion("  1.2.10 ") 支持空格与两位数', JSON.stringify(parseVersion('  1.2.10 ')) === '[1,2,10]', parseVersion('  1.2.10 '));
check('parseVersion("abc") = null', parseVersion('abc') === null);
check('parseVersion(undefined) = null', parseVersion(undefined) === null);
check('parseVersion(130) = null（非字符串）', parseVersion(130) === null);

check('1.4.0 > 1.3.0', compareVersion('1.4.0', '1.3.0') === 1);
check('1.2.10 < 1.3.0（逐位比较，不是字符串比较）', compareVersion('1.2.10', '1.3.0') === -1);
check('1.3.0 = 1.3.0', compareVersion('1.3.0', '1.3.0') === 0);
check('2.0.0 > 1.9.9', compareVersion('2.0.0', '1.9.9') === 1);
check('缺失版本号按 0.0.0 处理', compareVersion(undefined, '1.0.0') === -1);

/* ---------- B. 门禁规则 ---------- */
console.log('\n[B] canOpenFileVersion 门禁');

check('同版本可开', canOpenFileVersion('1.3.0', '1.3.0').ok === true);
check('补丁版更高可开（1.3.5 by 1.3.0）', canOpenFileVersion('1.3.5', '1.3.0').ok === true);
check('次版本更高可开（1.4.0 by 1.3.0）', canOpenFileVersion('1.4.0', '1.3.0').ok === true);
check('低版本可开（1.0.0 by 1.3.0）', canOpenFileVersion('1.0.0', '1.3.0').ok === true);
check('没有版本号的老文件可开', canOpenFileVersion(undefined, '1.3.0').ok === true);
check('乱码版本号可开（宽松放行）', canOpenFileVersion('not-a-version', '1.3.0').ok === true);

const blocked = canOpenFileVersion('2.0.0', '1.3.0');
check('主版本更高被拒绝（2.0.0 by 1.3.0）', blocked.ok === false);
check('拒绝原因 = version-too-new', blocked.reason === 'version-too-new', blocked.reason);
check('拒绝时回带文件版本号', blocked.fileVersion === '2.0.0', blocked.fileVersion);
check('拒绝时回带当前版本号', blocked.currentVersion === '1.3.0', blocked.currentVersion);

/* ---------- C. toJSON 输出字段 ---------- */
console.log('\n[C] toJSON 写出的结构');

const store = new BoardStore();
store.shapes.push({
  id: 's1', type: 'rect', x: 10, y: 10, w: 100, h: 60,
  color: '#fff', strokeWidth: 2, opacity: 1,
});
const json = store.toJSON();
check('format = "inkwell"', json.format === 'inkwell', json.format);
check('写入 appVersion = ' + INKWELL_APP_VERSION, json.appVersion === INKWELL_APP_VERSION, json.appVersion);
check('写入 version = appVersion（兼容旧字段名）', json.version === INKWELL_APP_VERSION, json.version);
check('写入 shapesVersion = ' + SHAPES_VERSION, json.shapesVersion === SHAPES_VERSION, json.shapesVersion);
check('图形被完整带上', Array.isArray(json.shapes) && json.shapes.length === 1, json.shapes && json.shapes.length);
check('toJSON 是可序列化的纯对象', JSON.stringify(json).length > 0);

/* ---------- D. loadJSON 正常路径 ---------- */
console.log('\n[D] loadJSON 正常读取');

const store2 = new BoardStore();
const res2 = store2.loadJSON(JSON.parse(JSON.stringify(json)), INKWELL_APP_VERSION);
check('同版本文件读取成功', res2.ok === true, res2);
check('图形被还原', store2.shapes.length === 1, store2.shapes.length);
check('图形字段正确还原', store2.shapes[0].w === 100, store2.shapes[0].w);

// 旧格式：只有顶层数组（1.2.0 之前的 .inkwell.json？实际上早期是 {shapes:[...]}）
const store3 = new BoardStore();
const res3 = store3.loadJSON({ shapes: [{ id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10 }] }, INKWELL_APP_VERSION);
check('无版本号字段的旧文件可读', res3.ok === true, res3);
check('旧文件图形被还原', store3.shapes.length === 1);

/* ---------- E. 拒绝高版本文件时不得污染画布 ---------- */
console.log('\n[E] 拒绝高版本文件时的副作用');

const store4 = new BoardStore();
store4.shapes.push({ id: 'keep', type: 'rect', x: 5, y: 5, w: 20, h: 20 });
const before = store4.shapes.length;

const highFile = JSON.parse(JSON.stringify(json));
highFile.appVersion = '9.0.0';
highFile.version = '9.0.0';
const res4 = store4.loadJSON(highFile, INKWELL_APP_VERSION);

check('高版本文件被拒绝', res4.ok === false, res4);
check('拒绝原因正确', res4.reason === 'version-too-new', res4.reason);
check('画布原内容未被清空', store4.shapes.length === before, store4.shapes.length);
check('画布原图形仍在', store4.shapes[0] && store4.shapes[0].id === 'keep');

// 用高版本号字段但只有 version（兼容只用 version 的写法）
const store5 = new BoardStore();
const legacyHigh = { version: '9.0.0', shapes: [] };
const res5 = store5.loadJSON(legacyHigh, INKWELL_APP_VERSION);
check('只写 version 的高版本文件同样被拒', res5.ok === false, res5);

/* ---------- 汇总 ---------- */
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
