const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['xuyixia-api', 'xuyixia-remind']) fs.copyFileSync(path.join(root, 'miniprogram/utils/policy.js'), path.join(root, 'cloudfunctions', name, 'policy.js'));
console.log('计划规则已同步到云函数。');
