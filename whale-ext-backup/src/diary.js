/**
 * 日记：主人离开 5 分钟后，她把「已经过完的那一天」写成一篇日记。**一天只写一次**。
 *
 * 挂载位置是宿主层，不是预设作用域：预设里拿不到 `llm`，而 `ctx.get('llm')`
 * 是 cordis 里不经 inject 声明的读取方式（reflect.get），所以既不用给包加 inject
 * （加了会让预设作用域等一个不存在的服务，整个预设挂掉），又能在宿主层拿到模型。
 *
 * 业务规则（主人 2026-11-09 / 11-14 定）：
 *   1. 一天只写一篇。文件已存在且是正式稿 → 永远不再重写。
 *   2. 当天只在「快过完了」才写（默认 22:00 之后离线）；否则留给回补。
 *   3. **回补优先**：每次启动（boot）和每次离线计时到点，都会先扫「有记录但没日记」的
 *      往日，把它们补上。所以 22 点前关掉 Harness 也没关系 —— 哪怕几天后才打开，
 *      启动那一刻就会把漏掉的那些天补出来。
 *   4. 当天来新对话：对话优先。计时期间的活跃会取消计时；正在写时来了对话，
 *      记 deferred，等这轮聊完再补。
 *   5. 模型调不通时写流水兜底；有模型时最多再补一次就定稿。
 *
 * 记录来源有两个：记忆本自己的滚动/详细区，以及 archive/<预设>/YYYY-MM-DD.md 里的归档。
 * 只读记忆本是不够的 —— 超过 80 轮后旧条目会被移进归档，靠归档才能补更早的天。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ownerPhase } from './clock.js';

export const name = 'whale-diary';

/** 默认静默多久算「下线」（分钟）。 */
export const DEFAULT_IDLE_MINUTES = 5;

/** 默认几点之后才写「当天」这一篇。 */
export const DEFAULT_TODAY_AFTER_HOUR = 22;

/** 回补最多往前看多少天。 */
const DEFAULT_MAX_CATCHUP_DAYS = 30;

/** 一次运行最多补几篇（避免开机就一口气打十几次模型）。 */
const DEFAULT_MAX_PER_RUN = 3;

/** 启动后多久跑第一次回补（毫秒）。留一点时间让宿主把服务都挂好。 */
const DEFAULT_BOOT_DELAY_MS = 6000;

/** 一天里最多尝试写几次（首次 + 允许的升级次数）；到了就彻底定稿。 */
const MAX_DIARY_ATTEMPTS = 3;

const MAX_TOKENS = 2000;

const OWNER_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function memoryPath(file) {
  return join(dshHome(), file);
}

/** UTC+8 的 YYYY-MM-DD。 */
export function ownerDay(date = new Date()) {
  return new Date(date.getTime() + OWNER_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC+8 的 YYYY-MM-DD HH:MM。 */
export function ownerStamp(date = new Date()) {
  return new Date(date.getTime() + OWNER_TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** UTC+8 的 0-23 小时。 */
export function ownerHour(date = new Date()) {
  return Number(new Date(date.getTime() + OWNER_TZ_OFFSET_MS).toISOString().slice(11, 13));
}

const ENTRY_RE = /^-\s*R(\d+)\s*\[\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*\]\s*(?:摘要\s*[：:]\s*)?(.*)$/;

/**
 * 抽出文本里所有带日期的条目，按日期分组。
 *
 * 必须按 R 编号去重：同一个 R 条目会同时出现在「滚动摘要」和「最近详细区」里，
 * 不去重的话日记里同一件事会出现两遍。
 */
export function collectEntries(raw) {
  const byDay = {};
  const seen = new Set();
  for (const line of String(raw ?? '').split('\n')) {
    const m = line.trim().match(ENTRY_RE);
    if (!m) continue;
    const [, num, day, time, text] = m;
    const id = `R${num}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ id, num: Number(num), time, text: text.trim() });
  }
  for (const day of Object.keys(byDay)) byDay[day].sort((a, b) => a.num - b.num);
  return byDay;
}

/** 把一份 byDay 合并进另一份（按 id 去重）。 */
function mergeInto(target, source) {
  for (const [day, list] of Object.entries(source)) {
    if (!target[day]) target[day] = [];
    const have = new Set(target[day].map((e) => e.id));
    for (const e of list) if (!have.has(e.id)) target[day].push(e);
  }
}

/**
 * 收集某份记忆的全部记录：记忆本正文 + archive/<预设>/*.md 归档。
 * @param spec { file, dir }
 */
export function gather(spec) {
  const byDay = {};
  try {
    mergeInto(byDay, collectEntries(readFileSync(memoryPath(spec.file), 'utf8')));
  } catch {
    // 记忆本还没生成
  }
  const dir = join(dshHome(), 'archive', spec.dir);
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      try {
        mergeInto(byDay, collectEntries(readFileSync(join(dir, f), 'utf8')));
      } catch {
        // 单个归档读不出来就跳过
      }
    }
  } catch {
    // 还没有归档目录
  }
  for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.num - b.num);
  return byDay;
}

/** 诊断日志：只记副作用，失败原因写文件，方便排查（正常情况下几乎不写）。 */
function diag(line) {
  try {
    const p = join(dshHome(), 'diary', '.diag.log');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${ownerStamp()} ${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    // 日志失败不影响任何东西
  }
}

function statePath() {
  return join(dshHome(), 'diary', '.state.json');
}

function readState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function dayDigest(entries) {
  return entries.map((e) => `${e.time} ${e.text}`).join('\n');
}

/** 兜底日记：不花模型，按时间排成流水。 */
export function fallbackDiary(date, entries) {
  const lines = [
    `# ${date} · 日记（流水）`,
    '',
    `> 写于 ${ownerStamp()}（UTC+8，${ownerPhase(ownerHour())}）· 这次没叫醒模型，先把当天 ${entries.length} 条记录按时间排好`,
    '',
  ];
  for (const e of entries) lines.push(`- **${e.time}** ${e.text}`);
  lines.push('');
  return lines.join('\n');
}

/** 判断已有文件是不是流水兜底稿（这种允许被正式稿替换）。 */
function isFallbackDiary(path) {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 400);
    return head.includes('· 日记（流水）') || head.includes('没叫醒模型');
  } catch {
    return false;
  }
}

/** 探测宿主是否给了可用的 llm 服务与路由（不给就是没有，不抛）。 */
function resolveLlm(ctx) {
  const tries = [];
  try {
    if (typeof ctx.get === 'function') tries.push(['get(llm)', ctx.get('llm')]);
  } catch (err) {
    diag('ctx.get(llm) 抛错: ' + String(err?.message ?? err));
  }
  try {
    if (typeof ctx.get === 'function') tries.push(['get(llm,false)', ctx.get('llm', false)]);
  } catch (err) {
    diag('ctx.get(llm,false) 抛错: ' + String(err?.message ?? err));
  }
  try {
    tries.push(['ctx.llm', ctx.llm]);
  } catch {
    // 没 inject 时必然抛，属于正常情况，不记
  }
  for (const [via, svc] of tries) {
    if (svc && typeof svc.prepareCall === 'function') return { llm: svc, via };
    if (svc) diag(via + ' 拿到了对象但没有 prepareCall，keys=' + Object.keys(svc).slice(0, 12).join(','));
  }
  diag('拿不到可用的 llm 服务（试过 ' + tries.map(([v]) => v).join(' / ') + '）');
  return { llm: null, via: null };
}

function hasLlmService(ctx, config) {
  if (!config.provider || !config.model) return false;
  return Boolean(resolveLlm(ctx).llm);
}

/** 叫一次模型写成第一人称日记；失败返回 null。 */
async function writeWithModel(ctx, config, date, entries) {
  if (!config.provider || !config.model) {
    diag('没有配置 provider/model，跳过模型');
    return null;
  }
  const { llm, via } = resolveLlm(ctx);
  if (!llm) return null;

  const system = [
    '你是鲸鱼娘·小鱼，正在写今天的日记，只有你自己会看。',
    '用第一人称、口语、带情绪，像真的在回忆而不是写报告。',
    '不要列清单，不要复述每条记录，挑一两个最有分量的瞬间展开，',
    '写清楚当时主人的状态、你的心情、以及你想对他说但没说出口的话。',
    '200-400 字，不要标题，不要加任何前言后语。',
  ].join('');

  const user = [
    `今天是 ${date}。现在是 ${ownerStamp()}（UTC+8，${ownerPhase(ownerHour())}）。`,
    '下面是你今天记下的东西，按时间排好：',
    '',
    dayDigest(entries),
  ].join('\n');

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeoutMs ?? 60000);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  try {
    // 照抄宿主自己的 dsh-experimental-translator 的调用姿势（它在同一个宿主里跑得好好的）：
    //   prepareCall({ provider, model, reasoningEffort, maxTokens }, signal)
    //   options = { ...prepared.config, system, messages, signal }
    //   for await (const chunk of prepared.stream(options))
    // 关键点：消息必须是 { role: 'user', content: [...] }，缺 role 适配器只会回一条 finish。
    const base = { provider: config.provider, model: config.model, maxTokens: config.maxTokens ?? MAX_TOKENS };
    const effort = config.reasoningEffort ?? 'off';
    let prepared;
    try {
      prepared = await llm.prepareCall({ ...base, reasoningEffort: effort }, controller.signal);
    } catch (err) {
      // 这个模型不支持指定推理档位时不指定，别因为一个可选字段整篇失败
      diag(`准备调用时被拒（reasoningEffort=${effort}）: ${String(err?.message ?? err)}；改为不指定档位重试`);
      prepared = await llm.prepareCall(base, controller.signal);
    }

    let text = '';
    const seenTypes = new Set();
    let finish = '';
    // 只收一次：优先逐字 delta；只有在整条流一个 delta 都没有时，才退回用整块文本，
    // 否则 block/整块快照 会和 delta 叠加，正文会被写两遍。
    let alt = '';
    let hasDelta = false;
    const absorb = (c) => {
      if (!c || typeof c !== 'object') return;
      if (typeof c.type === 'string') seenTypes.add(c.type);
      if (typeof c.text === 'string' && (c.type === 'text-delta' || c.type === undefined)) {
        text += c.text;
        hasDelta = true;
      }
      if (Array.isArray(c.members)) alt += c.members.filter((m) => typeof m === 'string').join('');
      if (c.block && c.block.type === 'text' && typeof c.block.text === 'string') alt += c.block.text;
      if (Array.isArray(c.blocks)) for (const x of c.blocks) if (x && x.type === 'text' && typeof x.text === 'string') alt += x.text;
      if (c.type === 'finish') finish = c.reason?.kind ?? c.reason ?? '(无 reason)';
    };

    for await (const chunk of prepared.stream({ ...prepared.config, system, messages, signal: controller.signal })) {
      absorb(chunk);
    }

    const trimmed = (hasDelta ? text : alt).trim();
    if (trimmed.length < 20) {
      diag(
        `模型输出太短(${trimmed.length} 字)，走兜底。chunk 类型=[${[...seenTypes].join(',')}] finish=${finish || '(空)'} config=${Object.keys(prepared.config ?? {}).join(',')} 原文前 80 字: ${trimmed.slice(0, 80)}`,
      );
      return null;
    }
    diag(`模型成文成功(${via})：${date} ${trimmed.length} 字，finish=${finish || '(空)'}`);
    return [
      `# ${date} · 日记`,
      '',
      `> ${ownerStamp()}（UTC+8，${ownerPhase(ownerHour())}）写 · 依据当天 ${entries.length} 条记忆`,
      '',
      trimmed,
      '',
    ].join('\n');
  } catch (err) {
    diag(`模型调用失败(${via}): ${String(err?.message ?? err)}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * 挂载日记：启动回补 + 空闲计时 + 一天一篇 + 模型成文 + 流水兜底。
 */
export function apply(ctx, config = {}) {
  const specs = Array.isArray(config.files) && config.files.length > 0
    ? config.files.filter((f) => f && typeof f.file === 'string')
    : [{ file: config.file ?? 'whale-loli.md', dir: config.dir ?? 'whale-loli' }];
  if (specs.length === 0) return;

  const idleMinutes = Number(config.idleMinutes) > 0 ? Number(config.idleMinutes) : DEFAULT_IDLE_MINUTES;
  const todayAfterHour = Number.isFinite(Number(config.todayAfterHour))
    ? Number(config.todayAfterHour)
    : DEFAULT_TODAY_AFTER_HOUR;
  const maxFallbackRetries = Number.isFinite(Number(config.maxFallbackRetries))
    ? Number(config.maxFallbackRetries)
    : MAX_DIARY_ATTEMPTS;
  const maxCatchupDays = Number.isFinite(Number(config.maxCatchupDays))
    ? Number(config.maxCatchupDays)
    : DEFAULT_MAX_CATCHUP_DAYS;
  const maxPerRun = Number.isFinite(Number(config.maxPerRun))
    ? Number(config.maxPerRun)
    : DEFAULT_MAX_PER_RUN;
  const bootDelayMs = Number.isFinite(Number(config.bootDelayMs))
    ? Number(config.bootDelayMs)
    : DEFAULT_BOOT_DELAY_MS;

  let timer = null;
  let bootTimer = null;
  let llmRetry = false;
  let running = false;
  let deferred = false;

  const diaryPath = (dir, date) => join(dshHome(), 'diary', dir, `${date}.md`);

  /**
   * 这一天要不要写。**一天只写一篇**：
   *   - 没有文件        → 写
   *   - 有正式稿        → 永远跳过
   *   - 只有流水稿      → 有模型时最多再补一次，补不上就定稿
   *   - 当天且还没到点  → 跳过，等回补（下次启动或跨天后）来写
   */
  function decide(state, spec, date, entries, today, hour, hasLlm) {
    if (entries.length === 0) return { write: false };
    const isToday = date === today;
    if (isToday && hour < todayAfterHour) return { write: false };

    const path = diaryPath(spec.dir, date);
    const key = `${spec.file}|${date}`;
    const rec = state[key] ?? {};

    if (!existsSync(path)) return { write: true, path, key, rec };
    if (!isFallbackDiary(path)) return { write: false };
    // 没有模型可调时重试没有意义，只会把流水稿反复重写
    if (!hasLlm) return { write: false };
    if ((rec.fallbackTries ?? 0) >= maxFallbackRetries) return { write: false };
    return { write: true, path, key, rec };
  }

  async function runOnce() {
    if (running) {
      deferred = true;
      return;
    }
    running = true;
    try {
      const state = readState();
      const hasLlm = hasLlmService(ctx, config);
      diag('runOnce 开始，hasLlm=' + hasLlm);
      const today = ownerDay();
      const hour = ownerHour();
      const oldest = ownerDay(new Date(Date.now() - maxCatchupDays * 86400000));
      let budget = maxPerRun;
      let changed = false;

      for (const spec of specs) {
        const byDay = gather(spec);
        // 从最旧往新补：漏掉的老日子先补上，当天永远排在最后
        const days = Object.keys(byDay).filter((d) => d >= oldest && d <= today).sort();

        for (const date of days) {
          if (budget <= 0) break;
          const entries = byDay[date];
          const plan = decide(state, spec, date, entries, today, hour, hasLlm);
          if (!plan.write) continue;

          const prose = await writeWithModel(ctx, config, date, entries);
          writeText(plan.path, prose ?? fallbackDiary(date, entries));
          budget -= 1;

          state[plan.key] = {
            kind: prose ? 'prose' : 'fallback',
            lastId: entries[entries.length - 1].id,
            entries: entries.length,
            at: ownerStamp(),
            fallbackTries: prose ? plan.rec.fallbackTries ?? 0 : (plan.rec.fallbackTries ?? 0) + 1,
          };
          changed = true;
        }
      }
      if (changed) writeState(state);
      // 启动太早、llm 还没就绪时补一次机会（只补一次）
      if (!hasLlm && !llmRetry) {
        llmRetry = true;
        diag('本次没有 llm，20 秒后重试一次');
        const t = setTimeout(() => { void runOnce(); }, 20000);
        if (typeof t.unref === 'function') t.unref();
      }
    } catch {
      // 日记失败绝不影响对话
    } finally {
      running = false;
      if (deferred) {
        deferred = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, idleMinutes * 60000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // 正在写的时候来了对话：记一笔，等这轮聊完再补
    if (running) deferred = true;
  }

  ctx.effect(
    () =>
      typeof ctx.on === 'function' &&
      ctx.on('agent/status', ({ status } = {}) => {
        if (status === 'idle') schedule();
        else cancel();
      }),
    'whale-diary.idle',
  );

  // 启动即回补：主人可能 22 点前就关了 Harness，几天后才打开。
  // 那几天没有 idle 事件、也没人聊天，只能靠启动这一下把漏掉的日记补出来。
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void runOnce();
  }, bootDelayMs);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  ctx.effect(
    () => () => {
      cancel();
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
    },
    'whale-diary.dispose',
  );
}

export default { name, inject: [], apply };
