// 给桌面壳截图准备一点数据：3 个环境（不启动内核，只要列表有内容）
import { createProfile } from '../src/store/profiles.js';

const rows = [
  { name: '演示 · 美国店', country: 'US', group_name: '演示组', remark: 'P6 桌面截图用' },
  { name: '演示 · 日本店', country: 'JP', group_name: '演示组' },
  { name: '演示 · 德国店', country: 'DE', group_name: '演示组' },
];
for (const r of rows) {
  const p = createProfile(r, { source: 'script' });
  console.log(p.id, p.name, p.country, p.timezone);
}