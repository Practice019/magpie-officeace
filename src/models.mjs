// 模型表与模型条目形状
//
// ═══════════════════════════════════════════════════════════════════
// 两个表的分工
// ═══════════════════════════════════════════════════════════════════
//
//   FALLBACK_MODELS   config 钩子用 —— 未登录时也要有内容
//                     ⚠ 没有它 magpie 显示 "0 models"
//
//   provider.models   登录后拉真实目录，失败回退 FALLBACK
//
// ═══════════════════════════════════════════════════════════════════

import { FALLBACK_MODELS, OFFICIAL_MAAS_BASE } from "./constants.mjs"

/** npm 包 → 决定 API 形状 */
export const NPM = "@ai-sdk/openai-compatible"

/**
 * 服务端没给能力声明时的默认判据 —— **纯文本**。
 *
 * ⚠ 这是「上游什么都没说」时的**唯一**默认值，不是对某个模型的断言：
 * 实测（2026-11-20）`GET /v2/models`（注册表）与 `GET /v1/model-token-rates`
 * （可计费清单）都只回 id / name，**没有任何能力字段** —— 见 README
 * 「模型能力从哪来」。所以现在所有模型都是纯文本。
 *
 * 一旦上游开始下发 `capabilities`（或顶层 `vision` / `input_modalities`），
 * {@link upstreamCapabilities} 会**自动**接管，它就不再是最终答案。
 */
const TEXT_MODALITIES = ["text"]

/** 只留非空字符串并去重。 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const v of value) {
    if (typeof v !== "string") continue
    const s = v.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 模态字符串数组 → 五个显式布尔（省掉 ≠ 按 text 处理）。 */
function modalityFlags(mods) {
  const has = (m) => mods.includes(m)
  return { text: has("text"), image: has("image"), audio: has("audio"), video: has("video"), pdf: has("pdf") }
}

/**
 * 上游能力声明 → magpie 的能力/模态（**唯一一处映射**）。
 *
 * 只认上游说的话：
 *
 *	vision        `capabilities.vision === true`
 *	              ∪ `capabilities.input_modalities` 含 `image`
 *	              ∪ 顶层 `vision` / `supportsImage` 为真
 *	模态数组       上游没给 → `["text"]`
 *	toolcall      `function_calling !== false`
 *
 * vision 与模态数组必须自洽：vision 为真则把 `image` 补进数组（否则
 * `capabilities.input.image` 与 `modalities.input` 会给出两个答案）。
 *
 * @param {{capabilities?: any, vision?: boolean, supportsImage?: boolean, function_calling?: boolean}} [source]
 * @returns {{vision: boolean, toolcall: boolean, inputModalities: string[], outputModalities: string[],
 *   input: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean},
 *   output: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean}}}
 */
export function upstreamCapabilities(source) {
  const src = source && typeof source === "object" ? source : {}
  const raw = src.capabilities
  const up = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}

  const declaredIn = stringList(up.input_modalities ?? src.input_modalities)
  const declaredOut = stringList(up.output_modalities ?? src.output_modalities)

  const input = declaredIn.length > 0 ? declaredIn : [...TEXT_MODALITIES]
  const output = declaredOut.length > 0 ? declaredOut : [...TEXT_MODALITIES]

  const vision = up.vision === true || src.vision === true || src.supportsImage === true || input.includes("image")
  if (vision && !input.includes("image")) input.push("image")

  return {
    vision,
    toolcall: up.function_calling !== false && src.function_calling !== false,
    inputModalities: input,
    outputModalities: output,
    input: modalityFlags(input),
    output: modalityFlags(output),
  }
}

/**
 * 从上游行里挑出「它真的给了」的能力字段。
 *
 * 上游目前一个都不给（返回 null），挑不到就不带 —— 这样「上游没说」与
 * 「上游说了纯文本」在数据上就不是同一件事。
 *
 * @param {any} item
 * @returns {object|null}
 */
export function pickUpstreamCapabilities(item) {
  if (!item || typeof item !== "object") return null
  /** @type {Record<string, any>} */
  const out = {}
  if (item.capabilities !== undefined && item.capabilities !== null) out.capabilities = item.capabilities
  for (const k of ["vision", "supportsImage", "supports_image", "input_modalities", "output_modalities", "function_calling"]) {
    if (item[k] !== undefined && item[k] !== null) out[k] = item[k]
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 构造一个 magpie model 条目。
 *
 * 契约要求：id / name / api:{id,url,npm} / limit / capabilities / cost
 *
 * @param {{id: string, name: string, baseUrl?: string, context?: number, output?: number,
 *   upstream?: any}} input `upstream`：上游那一行（或已挑出来的能力字段），
 *   缺省 = 上游没提供能力声明 ⇒ 纯文本。
 */
export function modelEntry({ id, name, baseUrl = OFFICIAL_MAAS_BASE, context = 1_000_000, output = 128_000, upstream }) {
  const cap = upstreamCapabilities(upstream)
  return {
    id,
    name,
    api: { id, url: `${baseUrl}/v2`, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output },
    capabilities: {
      temperature: true,
      // 实测上游支持推理链
      reasoning: true,
      attachment: cap.vision,
      toolcall: cap.toolcall,
      input: cap.input,
      output: cap.output,
      interleaved: false,
    },
    // magpie 的两条「收不收图」判据，与 capabilities 同源
    modalities: { input: cap.inputModalities, output: cap.outputModalities },
    attachment: cap.vision,
    supportsImage: cap.vision,
    release_date: "",
    variants: {},
  }
}

/** 未登录时的静态表（config 钩子用）*/
export function staticModels(baseUrl = OFFICIAL_MAAS_BASE) {
  const out = {}
  for (const [id, def] of Object.entries(FALLBACK_MODELS)) {
    out[id] = modelEntry({
      id,
      name: def.name,
      baseUrl,
      context: def.limit.context,
      output: def.limit.output,
    })
  }
  return out
}

/**
 * 实测**调不通**的注册表占位 id：无论倍率表拿没拿到，一律不进列表。
 *
 * 判据是 `POST /v2/chat/completions` 的**状态码**，不是「名字看着像测试版」：
 *
 * | id | 注册表 | 计费清单 | chat 实测 |
 * |---|---|---|---|
 * | `deepseek-v4.1-flash-1017` | ✅ | ❌ | **404 `ModelArts.81009 Invalid model`** |
 * | `deepseek-v4.1-flash-bnt`  | ✅ | ❌ | **404 同上** |
 * | `deepseek-v4-pro`          | ✅ | ❌ | **404 同上** |
 * | `deepseek-v4.1-flash-0930` | ✅ | ❌ | 200，但回显 `model="deepseek-v4.1-flash"`（别名，可用） |
 *
 * ⚠ 1017 带 `maas_type: benefit` 头重试**仍然 404** —— 别照抄 CodeArts 那条
 *   「0731 缺 benefit 头」的经验，两家不是一个网关。
 * ⚠ 换官方直连 `api.modelarts-maas.com` 也救不了：那台要 AK/SK 签名，
 *   Basic 凭据回 400 `ModelArts.81002`。
 *
 * 留着这张表的意义：`liveModels` 在**倍率表不可用**时不做白名单过滤
 * （那是对的，宁可多给也不给零个），但「多给」不能包含**已知必 404** 的 id ——
 * 用户选了它，失败发生在对话时，而不是在选择时。
 */
export const UNAVAILABLE_IDS = new Set([
  "deepseek-v4.1-flash-1017",
  "deepseek-v4.1-flash-bnt",
  "deepseek-v4-pro",
])

/**
 * 把服务端拉回的目录转成 magpie 的形状。
 *
 * ⚠ 保留静态表里的配置（上下文窗口等），只更新 id/name ——
 *   上游的目录只有 id 和 name，**没有能力元数据**。
 */
export function liveModels(rows, baseUrl, rates) {
  const out = {}
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id
    if (typeof id !== "string" || id.length === 0) continue

    // ⚠ 只留有倍率的模型 —— 这是 OfficeAce 桌面端自己的做法
    //
    // /v2/models 是**注册表**，把没上线或不可用的测试版也列出来：
    //   deepseek-v4.1-flash-1017   → 404 ModelArts.81009 Invalid model
    //   deepseek-v4.1-flash-bnt    → 404（同上）
    //   deepseek-v4.1-flash-0930   → 200，但上游返回 model="deepseek-v4.1-flash"
    //                                （即路由到主模型，不单独计价）
    //
    // /v1/model-token-rates 是**可计费清单**，桌面端只显示它有的（7 个）。
    // 直接用注册表会给出 26 个，其中 19 个选不了 —— 比少给更糟。
    //
    // rates 为空（接口失败）时不做白名单过滤（宁可多给也不给零个），
    // 但**已知必 404 的 id 任何情况下都不给** —— 见 {@link UNAVAILABLE_IDS}。
    if (UNAVAILABLE_IDS.has(id)) continue
    if (rates && rates.size > 0 && !rates.has(id)) continue

    const name = typeof row?.name === "string" && row.name.length > 0 ? row.name : id
    const known = FALLBACK_MODELS[id]
    out[id] = modelEntry({
      id,
      name,
      baseUrl,
      context: known?.limit?.context ?? 1_000_000,
      output: known?.limit?.output ?? 128_000,
      // 上游那一行若带能力声明就照抄（目前它不带 —— 见 TEXT_MODALITIES 的注释）
      upstream: pickUpstreamCapabilities(row),
    })
  }
  return out
}