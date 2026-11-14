/**
 * 同步会话的 CDP binding 名。
 *
 * 为什么单独一个模块：同一个名字要出现在三处 —— 主进程 `Runtime.addBinding`、
 * 页面捕获脚本的模板、以及判据里的形状断言。三处各写一遍就会「改了实现没改判据」静默通过。
 *
 * 形状要求（与 P0 的 `__fp*` 标记同一类问题）：**不带 `fp` 子串、不带 `__` 前缀**，
 * 看起来像页面上随手起的一个局部变量。之前是 `__fpS_<8位hex>`：
 * 名字本身随机没问题，但**固定的 `__fp` 前缀就是一行判定代码** ——
 * `Object.getOwnPropertyNames(window).some(n => n.startsWith('__fp'))` 在同步期间能扫到它。
 *
 * 现在：`_s` + 8 位小写 hex（4 字节随机）。每会话一个新名字，跨会话不可关联；
 * 抓引用后立刻 `delete`，名字在页面 own names 里只存活「同一任务内的几微秒」。
 */
import crypto from 'node:crypto';

/** 允许的形状，判据与实现共用 —— 改实现必须一起改这里，否则测试立刻红。 */
export const BINDING_NAME_RE = /^_s[0-9a-f]{8}$/;

/** 本次会话的 binding 名（每次调用都是新名字）。 */
export function newBindingName() {
  return `_s${crypto.randomBytes(4).toString('hex')}`;
}