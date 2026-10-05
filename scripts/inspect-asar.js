'use strict';
const a = require('@electron/asar');
const p = 'dist/win-unpacked/resources/app.asar';

const css = a.extractFile(p, 'src\\renderer\\styles.css').toString();
const js = a.extractFile(p, 'src\\renderer\\bundle.js').toString();
const html = a.extractFile(p, 'src\\renderer\\index.html').toString();

console.log('css bytes:', css.length);
console.log('首 200 字符:');
console.log(JSON.stringify(css.slice(0, 200)));
console.log('');

const hiddenOk = /\[hidden\][^}]*display:\s*none\s*!important/.test(css);
console.log('有 [hidden]{display:none!important}:', hiddenOk);

const ti = css.indexOf('[hidden]');
console.log('=== [hidden] 规则原文 ===');
console.log(css.slice(ti, ti + 120));
console.log('');

const j = css.indexOf('.text-editor {');
console.log('=== .text-editor 规则原文 ===');
console.log(css.slice(j, j + 500));
console.log('');

const k = css.indexOf('.text-editor textarea');
console.log('=== textarea 规则原文 ===');
console.log(css.slice(k, k + 500));
console.log('');

// html 结构
console.log('=== html 中 textEditor 段 ===');
const m = html.match(/<div[^>]*text-editor[\s\S]{0,400}?<\/div>/);
console.log(m ? m[0] : '(未找到)');
console.log('');

// bundle 中是否含事件绑定
console.log('bundle 含 textEditor 引用:', js.includes('textEditor'));
console.log('bundle 含 openEditor:', js.includes('openEditor'));
console.log('bundle 含边界约束 stageBox:', js.includes('stageBox'));
