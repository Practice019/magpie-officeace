import { importDpopKey } from "./crypto.mjs"

const IMPORT_MOST = 100
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isText = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)

export class ImportError extends Error {}

/**
 * Parse NDJSON / 多行 JSON 对象。
 *
 * 用户不该为了导入去改文件格式：VSCode 导出的凭据常常是「一行一个对象」。
 * 这里逐行解析，坏行**只丢那一行**（结果里自然少一条），空行与 `#` / `//`
 * 注释行直接跳过。一行是数组时把元素展开（`[{...},{...}]` 也认）。
 *
 * 全部行都解析失败时返回空数组，由调用方抛原有错误 —— 裸凭据/日志不能
 * 因为「看起来像多行」就被当成账号。
 *
 * @param {string} text
 * @returns {any[]}
 */
function parseLines(text) {
  const rows = []
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (Array.isArray(parsed)) rows.push(...parsed)
    else rows.push(parsed)
  }
  return rows
}

/** 一条原始条目「自称」是哪个 provider（`provider` 或 `platform` 字段）。 */
function declaredProviderOf(row) {
  if (!isObject(row)) return undefined
  if (Object.hasOwn(row, "provider")) return String(row.provider ?? "").trim()
  if (Object.hasOwn(row, "platform")) return String(row.platform ?? "").trim()
  return undefined
}

function accountsOf(text, provider) {
  const cleaned = String(text ?? "").replace(/^\uFEFF/, "")
  let data
  try {
    if (typeof text !== "string") throw new Error()
    // 先整份解析：单对象 / 数组 / version 容器的行为与错误文案保持原样。
    data = JSON.parse(cleaned)
  } catch {
    // 再按行解析（NDJSON）：一条坏行不该让整份文件失败。
    const rows = parseLines(cleaned)
    if (!rows.length) {
      throw new ImportError("需要 UTF-8 JSON（对象、数组或每行一个对象的 NDJSON）；不支持裸凭据或日志")
    }
    data = rows.length === 1 ? rows[0] : rows
  }
  if (isObject(data) && (Object.hasOwn(data, "accounts") || Object.hasOwn(data, "version"))) {
    if (data.provider !== provider) throw new ImportError("容器的 provider 缺失或与当前供应商不匹配")
    if (data.version !== 1 || !Array.isArray(data.accounts) || Object.keys(data).length !== 3) {
      throw new ImportError("容器必须只含 provider、version（数字 1）和 accounts（数组）")
    }
    return { accounts: data.accounts, tagged: true }
  }
  const accounts = Array.isArray(data) ? data : [data]

  // ⚠ 一条**自称是别的 provider** 的行（`provider: "officeace"` / `platform: "codearts"`）
  // 不能当成「没标 provider 的裸行」放过去：把 A 家的凭据写进 B 家的账号里，
  // 用户看到的是「导入成功」，用起来却是 401。
  //
  // 整套粘贴只有一个 provider 标签（`tagged: false`）时，行上的 provider 是
  // 用户手上那份导出自带的标记，必须与当前 provider 一致；只有当标记**不一致的
  // 行不止一种**（把好几家的导出拼在一起），才退回老口径：让 toResult 自己判
  // 字段结构（loomy 的 session-only 行也能导）。
  const declared = new Set(accounts.map(declaredProviderOf).filter((p) => p !== undefined))
  const mixed = declared.size > 1
  return { accounts, tagged: mixed ? false : declared.size === 1 && declared.has(provider) }
}

export function importFields(row, required, optional, keyField) {
  const allowed = new Set([...required, ...optional, keyField])
  if (Object.keys(row).some((field) => !allowed.has(field))) {
    throw new ImportError("存在不支持的字段；请使用当前供应商的凭据结构")
  }
  for (const field of required) {
    if (!isText(row[field])) throw new ImportError(`${field} 必须为非空字符串且不含首尾空白或控制字符`)
  }
  for (const field of optional) {
    if (Object.hasOwn(row, field) && row[field] !== "" && !isText(row[field])) {
      throw new ImportError(`${field} 必须为字符串且不含首尾空白或控制字符`)
    }
  }
  if (row.user_phone && !/^\d{3}\*{4}\d{4}$/.test(row.user_phone)) {
    throw new ImportError("user_phone 必须是已打码的手机号")
  }
}

export async function validateImportDpop(jwk) {
  if (isObject(jwk) && jwk.kty === "EC" && jwk.crv === "P-256" &&
      [jwk.x, jwk.y, jwk.d].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value))) {
    try {
      await importDpopKey(jwk)
      return
    } catch {}
  }
  throw new ImportError("需要可用于签名的原始 P-256 DPoP 私钥 JWK")
}

export function validateImportExpiry(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !(Date.parse(value) > 0)) {
    throw new ImportError("到期时间必须为带时区的 ISO 8601 字符串")
  }
}

export function validateImportVerifier(value) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) throw new ImportError("PKCE verifier 格式无效")
}

export function validateImportMaas(key, secret, base) {
  if (Boolean(key) !== Boolean(secret)) throw new ImportError("MaaS 的 key 和 secret 必须成对提供")
  if (base && !/^(?:https:\/\/)?(?:api\.modelarts-maas\.com|(?:modelgw-[a-z0-9-]+\.)?officeace\.[a-z0-9-]+\.huaweicloud-agentarts\.com)\/?$/i.test(base)) {
    throw new ImportError("MaaS 地址只接受已知官方 HTTPS 网关或对应裸域名")
  }
}

export function makeImportHook({ provider, label, clientId, allowedClients = [clientId], accessField, sessionOf, toResult, normalizeRow }) {
  return {
    importFrom: `${label} 账号 UTF-8 JSON（单对象、数组、version: 1 容器，或每行一个对象的 NDJSON；最多处理前 100 条）`,
    import: makeCollector({ provider, clientId, allowedClients, accessField, sessionOf, toResult, normalizeRow }),
  }
}

/**
 * 同一个解析器，换个入口：登录弹窗的「从文件导入（粘贴）」要自己拿结果
 * （宿主一次登录只能保存一个账号，其余的要插件用 `client.auth.set` 写）。
 *
 * ⚠ 与 `auth.import` 是**同一段代码**：不许为粘贴再写一套解析器。
 *
 * @param {{provider: string, clientId: string, allowedClients?: string[],
 *   accessField: string, sessionOf?: Function, toResult: Function, normalizeRow?: Function}} cfg
 * @returns {(texts: string[], ctx?: {signal?: AbortSignal}) => Promise<object[]>}
 */
export function makeCollector({ provider, clientId, allowedClients = [clientId], accessField, sessionOf, toResult, normalizeRow }) {
  return async function collect(texts, { signal } = {}) {
    if (signal?.aborted) return []
    if (!Array.isArray(texts) || texts.length === 0) return [{ type: "failed", error: "没有可导入的 JSON 文件" }]
    const results = []
    const uids = new Set()
    const tokens = new Set()
    const keys = new Set()
    const sessions = new Set()
    const fail = (location, err) => results.push({
      type: "failed",
      error: `${location}：${err instanceof ImportError ? err.message : "凭据校验失败"}`,
    })
    for (const [file, text] of texts.entries()) {
      if (signal?.aborted || results.length >= IMPORT_MOST) break
      const location = `文件 ${file + 1}`
      let parsed
      try {
        parsed = accountsOf(text, provider)
        if (!parsed.accounts.length) throw new ImportError("没有账号条目")
      } catch (err) {
        fail(location, err)
        continue
      }
      for (const [index, row] of parsed.accounts.entries()) {
        if (signal?.aborted || results.length >= IMPORT_MOST) break
        try {
          if (!isObject(row)) throw new ImportError("账号必须是结构化 JSON 对象")
          const declared = row.provider ?? row.platform
          if ((!parsed.tagged || Object.hasOwn(row, "provider") || Object.hasOwn(row, "platform")) && declared !== provider) {
            throw new ImportError("账号的 provider 缺失或与当前供应商不匹配")
          }
          const normalized = normalizeRow ? await normalizeRow(row) : row
          if (!isObject(normalized)) throw new ImportError("账号必须是结构化 JSON 对象")
          const { provider: _provider, platform: _platform, ...cred } = normalized
          if (Object.hasOwn(cred, "oauth_client") && !allowedClients.includes(cred.oauth_client)) {
            throw new ImportError("OAuth client 与当前供应商不匹配")
          }
          const result = await toResult(cred)
          if (signal?.aborted) break
          if (!isText(result.uid)) throw new ImportError("缺少可用的稳定账号身份")
          if (uids.has(result.uid) || tokens.has(result.refresh) || keys.has(cred[accessField])) {
            throw new ImportError("本批次已导入同一账号或 STS 凭据")
          }
          const session = sessionOf?.(cred, result)
          if (session && sessions.has(session)) throw new ImportError("本批次已使用同一会话标识")
          uids.add(result.uid)
          tokens.add(result.refresh)
          keys.add(cred[accessField])
          if (session) sessions.add(session)
          results.push(result)
        } catch (err) {
          if (signal?.aborted) break
          fail(`${location} 第 ${index + 1} 条`, err)
        }
      }
    }
    return results
  }
}
