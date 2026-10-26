'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const errors = [];
let scripts = 0, jsons = 0, templates = 0;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function checkTemplate(file, source) {
  const stack = [];
  const tags = source.replace(/<!--[\s\S]*?-->/g, '').match(/<\/?[\w:-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || [];
  tags.forEach(tag => {
    const name = tag.match(/^<\/?([\w:-]+)/)[1];
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) errors.push(path.relative(root, file) + ': 标签闭合不匹配 ' + name);
    } else if (!tag.endsWith('/>')) stack.push(name);
  });
  if (stack.length) errors.push(path.relative(root, file) + ': 有未闭合标签 ' + stack.join(','));
  const jsFile = file.replace(/\.wxml$/, '.js');
  if (fs.existsSync(jsFile)) {
    const logic = fs.readFileSync(jsFile, 'utf8');
    for (const match of source.matchAll(/(?:bind|catch)(?::)?[\w]+="([\w]+)"/g)) {
      if (!new RegExp('\\b' + match[1] + '\\s*\\(').test(logic)) errors.push(path.relative(root, file) + ': 事件处理器缺失 ' + match[1]);
    }
  }
}

for (const file of walk(root)) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    if (file.endsWith('.js')) { new vm.Script(source, { filename: file }); scripts++; }
    if (file.endsWith('.json')) { JSON.parse(source); jsons++; }
    if (file.endsWith('.wxml')) { checkTemplate(file, source); templates++; }
  } catch (error) { errors.push(path.relative(root, file) + ': ' + error.message); }
}
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of app.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    if (!fs.existsSync(path.join(root, 'miniprogram', page + '.' + extension))) errors.push('页面文件缺失: ' + page + '.' + extension);
  }
}
for (const tab of app.tabBar.list) if (!app.pages.includes(tab.pagePath)) errors.push('tabBar 路径无效: ' + tab.pagePath);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`静态检查通过：${scripts} 个 JS、${jsons} 个 JSON、${templates} 个 WXML；页面文件、事件绑定和导航配置齐全。此检查不等于微信编译或真机测试。`);
