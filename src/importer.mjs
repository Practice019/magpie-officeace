import { importDpopKey } from "./crypto.mjs"

const IMPORT_MOST = 100
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isText = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)

export class ImportError extends Error {}

function accountsOf(text, provider) {
  let data
  try {
    if (typeof text !== "string") throw new Error()
    data = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    throw new ImportError("需要 UTF-8 JSON；不支持 NDJSON、裸凭据或日志")
  }
  if (isObject(data) && (Object.hasOwn(data, "accounts") || Object.hasOwn(data, "version"))) {
    if (data.provider !== provider) throw new ImportError("容器的 provider 缺失或与当前供应商不匹配")
    if (data.version !== 1 || !Array.isArray(data.accounts) || Object.keys(data).length !== 3) {
      throw new ImportError("容器必须只含 provider、version（数字 1）和 accounts（数组）")
    }
    return { accounts: data.accounts, tagged: true }
  }
  return { accounts: Array.isArray(data) ? data : [data], tagged: false }
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

export function makeImportHook({ provider, label, clientId, accessField, sessionOf, toResult }) {
  return {
    importFrom: `${label} 账号 UTF-8 JSON（单对象、数组或 version: 1 容器；最多处理前 100 条，不支持 NDJSON）`,
    async import(texts, { signal } = {}) {
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
            const { provider: declared, ...cred } = row
            if ((!parsed.tagged || Object.hasOwn(row, "provider")) && declared !== provider) {
              throw new ImportError("账号的 provider 缺失或与当前供应商不匹配")
            }
            if (Object.hasOwn(cred, "oauth_client") && cred.oauth_client !== clientId) {
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
    },
  }
}
