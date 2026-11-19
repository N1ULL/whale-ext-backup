/**
 * whale-ext —— 鲸鱼娘的外部扩展，独立于 dsh-whale-loli。
 *
 * 为什么要单独一个包：所有改动原来都在 npm 包 dsh-whale-loli 里面，
 * 升级插件会把它们全部覆盖。搬到这里之后，升级只影响那个包本身，
 * 这个包永远不动（它不在任何 npm 源里，就是 ~/.dsh/whale-ext 这个目录）。
 *
 * 两个能力：
 *   row: clock —— 把 UTC+8 当前时间当必需运行时上下文注入（required: true，
 *                 不吃人设的 complete: true，也不吃 includeRuntimeContext: false）。
 *   row: diary —— 静默 5 分钟后把当天写成一篇日记，一天只写一次。
 */

import { apply as applyClock, name as clockName } from './clock.js';
import { apply as applyDiary, name as diaryName } from './diary.js';

export { clockName, diaryName };

function applyEntry(ctx, config = {}) {
  if (config.row === 'clock') return applyClock(ctx, config);
  if (config.row === 'diary') return applyDiary(ctx, config);
}

export default {
  name: 'whale-ext',
  // systemPrompt 供时钟使用；日记走 ctx.get('llm')，不进 inject，
  // 免得宿主等一个预设作用域里可能不存在的服务。
  inject: ['systemPrompt'],
  apply: applyEntry,
};
