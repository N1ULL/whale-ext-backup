/**
 * 时钟：把 UTC+8 的当前时间注入成「必需的运行时上下文」。
 *
 * 为什么用 context 而不是 section：
 *   - 鲸鱼娘的人设段是 complete: true，宿主装配时会把别的 section 全丢掉；
 *   - 人设又写了 includeRuntimeContext: false，会关掉**可选**的运行时上下文。
 * 但 PromptContext.required === true 的条目在抑制时依然保留（见 dsh-system-prompt
 * 的 refreshContext：`if (suppressed && provider?.required !== true) continue`），
 * 所以这条能稳定到达模型，且完全不需要改任何人设文案。
 */

/** 时区固定 UTC+8（主人所在时区）。 */
const OWNER_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 上下文在宿主提示里的排序位置：放在最前面，模型一睁眼就看到。 */
const CONTEXT_ORDER = -1000;

function ownerParts(date = new Date()) {
  const iso = new Date(date.getTime() + OWNER_TZ_OFFSET_MS).toISOString();
  return {
    day: iso.slice(0, 10),
    stamp: iso.slice(0, 16).replace('T', ' '),
    hour: Number(iso.slice(11, 13)),
  };
}

/** 按小时给中文时段名。 */
export function ownerPhase(hour) {
  if (hour >= 5 && hour < 9) return '清晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 20) return '傍晚';
  if (hour >= 20 && hour < 23) return '晚上';
  return '深夜';
}

/** 渲染成一行给模型的文本。 */
export function clockText(date = new Date()) {
  const { day, stamp, hour } = ownerParts(date);
  const phase = ownerPhase(hour);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(date.getTime() + OWNER_TZ_OFFSET_MS).getUTCDay()];
  return `【现在】${stamp}（UTC+8 · ${weekday} · ${phase}）`;
}

export const name = 'whale-clock';

export const inject = ['systemPrompt'];

export function apply(ctx, config = {}) {
  const prompt = ctx.systemPrompt;
  if (!prompt || typeof prompt.context !== 'function') {
    console.warn('[whale-ext] 当前作用域没有 systemPrompt.context，时钟不注入');
    return;
  }
  ctx.effect(
    () =>
      prompt.context({
        name: config.contextName ?? 'whale-clock',
        order: typeof config.order === 'number' ? config.order : CONTEXT_ORDER,
        required: true,
        interpolate: false,
        text: () => clockText(),
      }),
    'whale-ext.clock',
  );
}

export default { name, inject, apply };
