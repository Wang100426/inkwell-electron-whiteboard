'use strict';
/* 校验打包后的 asar 里确实是 1.3.0 的内容（路径用反斜杠，见项目约定） */

const asar = require('@electron/asar');
const path = require('path');

const ASAR = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
const B = 'src\\renderer\\';

const bundle = asar.extractFile(ASAR, B + 'bundle.js').toString('utf8');
const pkg = JSON.parse(asar.extractFile(ASAR, 'package.json').toString('utf8'));
const idx = asar.extractFile(ASAR, B + 'index.html').toString('utf8');
const css = asar.extractFile(ASAR, B + 'styles.css').toString('utf8');
const main = asar.extractFile(ASAR, 'src\\main.js').toString('utf8');

/**
 * 去掉 CSS 注释后再检测 scrollbar-width。
 *
 * 直接对整份 CSS 做正则会被**注释里提到这条属性**的内容误判
 * （本项目已踩过一次：三处 `scrollbar-width: thin` 全在注释里，
 *  描述"当初为什么不能用它"）。真正要拦的是**活的声明**。
 */
function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}
const cssNoComment = stripCssComments(css);

const checks = [
  ['bundle 含 1.3.0 版本常量', bundle.includes("INKWELL_APP_VERSION = '1.3.0'")],
  ['bundle 含 canOpenFileVersion', bundle.includes('canOpenFileVersion')],
  ['bundle 含 TOOL_GROUPS 分组表', bundle.includes('TOOL_GROUPS')],
  ['bundle 含 openFlyout 子弹层', bundle.includes('function openFlyout')],
  ['bundle 的 __inkwell.version = 1.3.0', bundle.includes("version: '1.3.0'")],
  ['package.json version = 1.3.0', pkg.version === '1.3.0'],
  ['index.html 有 flyout 容器', idx.includes('id="flyout"')],
  ['index.html 有 tool-group 按钮', idx.includes('tool-group')],
  ['index.html 有面板头 panelHeadName', idx.includes('panelHeadName')],
  ['styles.css 有 .flyout 规则', css.includes('.flyout')],
  ['styles.css 无「活的」scrollbar-width 声明（注释不算）', !/scrollbar-width\s*:/.test(cssNoComment)],
  ['styles.css 无「活的」scrollbar-color 声明', !/scrollbar-color\s*:/.test(cssNoComment)],
  ['styles.css 有全局 --sb-w 变量', css.includes('--sb-w')],
  ['styles.css 保留 [hidden] 强制规则', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)],
  ['main.js 无边框窗口配置', main.includes('titleBarStyle') && main.includes('titleBarOverlay')],
  ['main.js 文件过滤只有 inkwell 主格式', main.includes("['inkwell']")],
];

let bad = 0;
checks.forEach(([name, ok]) => {
  console.log((ok ? '  OK  ' : '  BAD ') + name);
  if (!ok) bad++;
});

console.log('\nasar 内容检查 ' + (checks.length - bad) + '/' + checks.length + ' 通过');
process.exit(bad ? 1 : 0);
