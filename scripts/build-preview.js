'use strict';
// 仅供体验走查：执行相同的页面JS，使用浏览器替代WXML宿主与wx接口。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'miniprogram');
const sources = {};
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|json|wxml|wxss)$/.test(file)) sources[path.relative(sourceRoot, file).replace(/\\/g, '/')] = fs.readFileSync(file, 'utf8');
  }
}
walk(sourceRoot);
sources['config.js'] = "module.exports={storageMode:'local',cloudEnvId:'',subscriptionTemplateId:''};";
const shell = fs.readFileSync(path.join(__dirname, 'preview-shell.html'), 'utf8');
const html = shell.replace('/*__SOURCE_MANIFEST__*/{}', JSON.stringify(sources).replace(/</g, '\\u003c'));
const output = path.join(root, 'docs', 'interaction-preview.html');
fs.writeFileSync(output, html);
console.log('已生成浏览器演练页：' + output + '；不等于微信编译或真机验证。');
