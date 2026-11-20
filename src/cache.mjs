// cache.mjs 磁盘缓存的**唯一**读写入口（T-39）。
//
// # 为什么需要它（用户原话）
//
//	「所有的东西都需要缓存。更新缓存是我们来控制的，不要自动更新缓存」
//	「重启项目的时候，我不希望它就会自动去发送什么请求」
//
// 改造前：`provider.models` 每次被 magpie 问就对一个账号打
// `hydratedCredential`（1~2 次）+ `/v2/models` + `/v1/model-token-rates`；
// magpie 一重启就会对**每个账号**问一次 —— N 个账号 = 3N 次上游请求
// （loomy 的 `auth.models` 每个账号一次是同一个坑）。
//
// 改造后：钩子**只读缓存**，缓存只由**用户动作**（登录 / 重新登录）写。
//
// # 文件（都在 magpie 的配置目录，即 `plugin-auth.json` 旁边）
//
//	officeace-models-cache.json   { [baseUrl|accountKey]: { at, list } }
//	officeace-usage-cache.json    { [accountKey]:          { at, windows } }
//
// ⚠ 结构就是上面这两层，没有 `version` / `updatedAt` 之类的旁支键 ——
//   缓存文件是给人看、给人删的（删掉 = 下次重新读）。
//
// # 三条自律
//
//	① 读失败/文件损坏 → 当作**没有缓存**（`null`），从不抛
//	② 写失败 → 返回 false，从不抛（缓存写不进去不该让钩子失败）
//	③ 写是原子的（临时文件 + rename），半截文件不会把缓存读坏

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** 模型目录缓存（按网关 baseUrl / 无 key 账号的账号键分桶）。 */
export const MODELS_CACHE_FILE = "officeace-models-cache.json"

/** 额度缓存（按账号分键）。 */
export const USAGE_CACHE_FILE = "officeace-usage-cache.json"

/**
 * 规范化缓存目录：空/非字符串 → `""`（= 关闭缓存）。
 *
 * ⚠ 关闭缓存时钩子退回「实时读」而不是永远显示「未读」—— 没有可写的目录就
 *   无处缓存，这时让它读一次比让用户永远看不到数据更诚实。生产环境 magpie
 *   一定给 `input.directory`，所以正常安装永远走缓存路径。
 *
 * @param {any} dir
 * @returns {string}
 */
export function cacheDirOf(dir) {
  return String(dir ?? "").trim()
}

/**
 * 缓存的绝对路径（目录为空时返回空串）。
 * @param {string} dir
 * @param {string} file
 * @returns {string}
 */
export function cacheFilePath(dir, file) {
  const base = cacheDirOf(dir)
  return base ? join(base, file) : ""
}

/**
 * 读一整份缓存表。
 * @param {string} dir
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readCacheTable(dir, file) {
  const path = cacheFilePath(dir, file)
  if (!path) return {}
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * 读一条缓存。
 * @param {string} dir
 * @param {string} file
 * @param {string} key
 * @returns {any|null}
 */
export function readCacheEntry(dir, file, key) {
  const table = readCacheTable(dir, file)
  const hit = table[String(key ?? "")]
  return hit && typeof hit === "object" && !Array.isArray(hit) ? hit : null
}

/**
 * 写一整份缓存表（原子）。
 * @param {string} dir
 * @param {string} file
 * @param {Record<string, any>} table
 * @returns {boolean}
 */
export function writeCacheTable(dir, file, table) {
  const path = cacheFilePath(dir, file)
  if (!path) return false
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8")
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * 写一条缓存（其余条目原样保留）。
 * @param {string} dir
 * @param {string} file
 * @param {string} key
 * @param {Record<string, any>} value
 * @returns {boolean}
 */
export function writeCacheEntry(dir, file, key, value) {
  const k = String(key ?? "").trim()
  if (!k || !value || typeof value !== "object") return false
  const table = readCacheTable(dir, file)
  table[k] = value
  return writeCacheTable(dir, file, table)
}
