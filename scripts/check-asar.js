'use strict';
/*
 * 校验打包后的 asar 里确实是**当前版本**的内容。
 *
 * 版本号从 package.json 读，不写死 —— 写死的结果就是每次发版都要改这个脚本，
 * 忘了改就会出现「版本对了但检查还在拿旧号比」的假失败。
 *
 * 路径用反斜杠：asar 内部路径是 Windows 风格（见项目约定）。
 */

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
  ['bundle 含当前版本常量', bundle.includes(`INKWELL_APP_VERSION = '${pkg.version}'`)],
  ['bundle 含 canOpenFileVersion', bundle.includes('canOpenFileVersion')],
  ['bundle 含 TOOL_GROUPS 分组表', bundle.includes('TOOL_GROUPS')],
  ['bundle 含 renderVariants（面板工具变体区）', bundle.includes('function renderVariants')],
  ['bundle 已移除 openFlyout（旧子弹层）', bundle.includes('openFlyout') === false],
  ['bundle 的 __inkwell.version = 当前版本', bundle.includes(`version: '${pkg.version}'`)],
  ['index.html 有变体区容器', idx.includes('id="variantGroup"')],
  ['index.html 已移除子弹层容器', idx.includes('id="flyout"') === false],
  ['index.html 有 tool-group 按钮', idx.includes('tool-group')],
  ['index.html 有面板头 panelHeadName', idx.includes('panelHeadName')],
  ['styles.css 有 .variant-btn 规则', css.includes('.variant-btn')],
  ['styles.css 已移除 .flyout 规则（注释不算）', cssNoComment.includes('.flyout') === false],
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
