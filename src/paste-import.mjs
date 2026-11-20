// paste-import.mjs —— 登录弹窗里的第 4 个按钮：「从文件导入（粘贴 JSON / NDJSON）」。
//
// # 为什么要它
//
// 「从文件导入账号…」只在**供应商详情页**，而那个页面会把所有账号全列出来
// （账号一多，导入按钮就被挤到最底下）。把它做成一个**登录方式**之后，
// 「用哪种方式登录 OfficeAce?」这个弹窗里就能直接导入。
//
// # 为什么是 `type: "oauth"`（读宿主源码确认，不是猜）
//
// 真源：`C:\Users\21877\.cache\magpie\plugin-host\host-acc034d984c6.js`
//
//	2480-2488  methods()：只投影 type / label / labels / keyless / keyAsked / placeholder
//	2496-2498  keyAsked()：api + prompts + authorize ⇒ 宿主不再额外问 key
//	2963-2978  apiKey()：api 方法的返回值必须含 `key`，save() 写成 `{type:"api", key}`
//	2814       oauth 方法：authorize(inputs, {signal})
//	2822       oauth 方法**必须**返回带 `callback()` 的对象
//	2849-2858  callback() 必须是 `{type:"success", …}`，再经 keptAs → save 落盘
//	2758-2763  save() 写的 body 是 `{type:"oauth", refresh, access, expires, …extra}`
//
// OfficeAce 的账号卡 / 续期 / 签到都读 `auth.access`（JSON）+ `auth.refresh`
// （见 `src/credential.mjs` 顶部的形状说明），所以必须是 oauth 形状。
//
// # 一次粘很多条（宿主一次登录只保存一个）
//
//	① 第 1 条返回给宿主，由它按正常登录落盘；
//	② 其余每条走 `client.auth.set`（host.js:1346-1370，宿主写完会发 `{event:"auth"}`，
//	   面板自动刷新，不用重启）。
//
// ⚠ 解析/校验与 `auth.import` 是**同一段代码**（`src/importer.mjs` 的
//   `makeCollector`），这里只负责「多条怎么落盘」+「磁盘上已有的怎么去重」。

import { officeAceAccountRefs } from "./accounts.mjs"

/** 按钮文案。 */
export const PASTE_LABEL = "从文件导入（粘贴 JSON / NDJSON）"

/** 多语言文案（宿主 `byLang`，host.js:2464-2475）。 */
export const PASTE_LABELS = Object.freeze({ en: "import from text (JSON / NDJSON)" })

/** 输入框标题。 */
export const PASTE_MESSAGE = "账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）"

/** 输入框标题的多语言版本。 */
export const PASTE_MESSAGES = Object.freeze({
  en: "account text (one object, an array, or an object per line)",
})

/**
 * 宿主 `save()` 写进 `plugin-auth.json` 的 body（host.js:2758-2763 的同构实现）。
 *
 * @param {any} result
 * @returns {object}
 */
export function authBodyOf(result) {
  const { type: _type, provider: _provider, refresh, access, expires, ...extra } = result ?? {}
  return { type: "oauth", refresh, access, expires, ...extra }
}

/**
 * NDJSON 里**解析不了的行**（1 起的行号），与 `src/importer.mjs` 的 `parseLines`
 * 同一口径：空行、`#` / `//` 注释行不算坏行；整段本身是合法 JSON 时不算。
 *
 * @param {string} text
 * @returns {string[]} 形如 `第 2 条：这一行不是合法的 JSON`
 */
export function countBadLines(text) {
  const raw = String(text ?? "")
  const body = raw.replace(/^\uFEFF/, "")
  try {
    JSON.parse(body)
    return [] // 整段就一份 JSON：没有「行」的概念
  } catch {
    /* 往下按行看 */
  }
  /** @type {string[]} */
  const bad = []
  for (const [index, rawLine] of body.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    try {
      JSON.parse(line)
    } catch {
      bad.push(`第 ${index + 1} 条：这一行不是合法的 JSON`)
    }
  }
  return bad
}

/**
 * 分配一个没被占用的账号键：`officeace` → `officeace#<6 位 base36>`。
 *
 * 与宿主 `freshKey()`（host.js:1243-1250）同一形态。**必须带 `#`**：在登录
 * 作用域里写裸 provider id 会被 `keyFor()`（host.js:1229-1232）改写成
 * 「本次登录的键」，多出来的号就全挤在一个位置上了。
 *
 * @param {string} provider
 * @param {Set<string>} taken 已被占用的键（会被就地更新）
 * @returns {string}
 */
export function nextAccountKey(provider, taken) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const key = `${provider}#${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(key)) {
      taken.add(key)
      return key
    }
  }
  const key = `${provider}#${Date.now().toString(36).slice(-6)}`
  taken.add(key)
  return key
}

/**
 * 把已通过校验的账号逐条写进 `plugin-auth.json`（via 宿主的 client.auth.set）。
 *
 * @param {{client?: any, provider: string, authFile?: string, successes: any[]}} opts
 * @returns {Promise<{written: string[], errors: string[]}>}
 */
export async function writeAccounts(opts) {
  const provider = String(opts.provider ?? "officeace")
  const successes = Array.isArray(opts.successes) ? opts.successes : []
  /** @type {string[]} */
  const written = []
  /** @type {string[]} */
  const errors = []

  if (typeof opts.client?.auth?.set !== "function") {
    if (successes.length > 1) {
      errors.push(`当前宿主没有 client.auth.set，只导入了第 1 条（其余 ${successes.length - 1} 条未写入）`)
    }
    return { written, errors }
  }

  const taken = new Set(officeAceAccountRefs({ file: opts.authFile, provider }).keys)
  for (const [index, result] of successes.entries()) {
    const key = nextAccountKey(provider, taken)
    try {
      await opts.client.auth.set({ path: { id: key }, body: authBodyOf(result) })
      written.push(key)
    } catch (e) {
      errors.push(`第 ${index + 1} 条：写入失败（${String(e?.message ?? e)}）`)
    }
  }
  return { written, errors }
}

/**
 * 导入本身：解析 → 逐条校验（复用 importer）→ 与磁盘已有账号去重 → 写盘。
 *
 * @param {{text: string, provider: string, authFile?: string, client?: any,
 *   log?: any, collect: (texts: string[]) => Promise<object[]>}} opts
 * @returns {Promise<object>} 宿主 `callback()` 要的结果
 */
export async function importPastedText(opts) {
  /** @type {object[]} */
  let results
  try {
    results = await opts.collect([opts.text])
  } catch (e) {
    return { type: "failed", error: `导入失败：${String(e?.message ?? e)}` }
  }
  if (!Array.isArray(results)) results = results ? [results] : []

  // 宿主 `accountsOf`（src/importer.mjs）对 NDJSON 里**解析不了的行**是**静默跳过**的
  // （xvfb 导出里夹注释很常见，不能因此判整份失败）。用户看不见就以为导进去了，
  // 所以这里按同一口径（空行 / `#` / `//` 跳过）自己数一遍，把坏行报出来。
  const badLines = countBadLines(opts.text)

  // 与磁盘上已有的账号去重：同一个 refresh token 已经是一个账号，不重复写。
  const known = officeAceAccountRefs({ file: opts.authFile, provider: opts.provider }).refreshes
  /** @type {object[]} */
  const successes = []
  /** @type {string[]} */
  const failures = []
  for (const [index, r] of results.entries()) {
    if (r?.type !== "success") {
      const why = String(r?.error ?? "").trim()
      if (why) failures.push(why)
      continue
    }
    const refresh = String(r?.refresh ?? "")
    if (refresh && known.has(refresh)) {
      failures.push(`第 ${index + 1} 条：该账号已经在 magpie 里了`)
      continue
    }
    if (refresh) known.add(refresh)
    successes.push(r)
  }

  if (successes.length === 0) {
    return { type: "failed", error: [...badLines, ...failures].join("；") || "没从粘贴的内容里认出账号" }
  }

  const { written, errors } = await writeAccounts({
    client: opts.client,
    provider: opts.provider,
    authFile: opts.authFile,
    successes,
  })

  const saved = written.length > 0 ? written.length : 1
  const skipped = [...badLines, ...failures]
  const message = [
    `已导入 ${saved} 个账号`,
    skipped.length > 0 ? `跳过 ${skipped.length} 条（${skipped.slice(0, 3).join("；")}）` : "",
    errors.length > 0 ? errors.slice(0, 3).join("；") : "",
  ]
    .filter(Boolean)
    .join("；")
  notify({ client: opts.client, log: opts.log, message, variant: skipped.length || errors.length ? "warning" : "info" })

  // 调用方（`callback()`）手上也要能看到「哪几条没进来」——
  // 宿主只显示错误，成功时它不会转述我们的提示。
  if (skipped.length > 0 || errors.length > 0) {
    const first = [...skipped, ...errors].join("；")
    return { ...successes[0], note: first }
  }
  return successes[0]
}

function notify({ client, log, message, variant }) {
  try {
    client?.tui?.showToast?.({ title: PASTE_LABEL, message, variant })
  } catch {
    /* 没有 toast 通道就算了 */
  }
  try {
    log?.(`officeace: ${message}`, variant === "warning" ? "warn" : "info")
  } catch {
    /* 日志失败不是业务失败 */
  }
}

/**
 * 构建登录弹窗里的导入 method。
 *
 * @param {{provider?: string, authFile?: string, client?: any, log?: Function,
 *   collect: (texts: string[], ctx?: {signal?: AbortSignal}) => Promise<object[]>}} opts
 * @returns {object} `auth.methods` 的一项
 */
export function makePasteImportMethod(opts) {
  const provider = String(opts?.provider ?? "officeace")
  const authFile = typeof opts?.authFile === "string" ? opts.authFile : ""
  const client = opts?.client
  const log = opts?.log
  const collect = opts?.collect

  return {
    type: "oauth",
    label: PASTE_LABEL,
    labels: { ...PASTE_LABELS },
    get prompts() {
      return [
        {
          type: "text",
          key: "text",
          message: PASTE_MESSAGE,
          messages: { ...PASTE_MESSAGES },
          validate: (v) => (String(v ?? "").trim() ? null : "请粘贴账号内容（JSON / 数组 / NDJSON）"),
        },
      ]
    },
    async authorize(inputs = {}) {
      const text = String(inputs?.text ?? "").trim()
      if (!text) return { type: "failed", error: "请粘贴账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）" }

      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: "正在导入账号…（单次最多 100 条；导入后账号列表会自动刷新）",
        async callback() {
          return importPastedText({ text, provider, authFile, client, log, collect })
        },
      }
    },
  }
}
