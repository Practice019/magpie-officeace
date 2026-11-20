// t39-cache-codearts.test.mjs（T-40）codearts provider 的缓存化。
//
// # 背景
//
// T-39 只改了 OfficeAce 那个 provider（`index.mjs`）。**同一个包里的 codearts
// provider 漏了**：约 3425 行的 `provider.models` 和约 3573 行的 `auth.usage`
// 仍是「每账号每次打上游」—— magpie 一重启就按账号数放大成 4N / 4N 次请求。
//
// # 判据（与 T-39 同一个口径）
//
//	magpie 重启 → 逐账号问 `provider.models` → **会不会对每个账号各打一次上游？**
//		有缓存 = 0 次；没有 = **1 次（网关级，不是账号数）**
//	`auth.usage` → 0 次（永远只读缓存；没有缓存就说「额度未读」）
//
// 每个用例都用**真临时目录**当缓存目录（缓存文件真落盘），并用注入的 `fetch`
// 把「哪个端点被打了几次」变成可断言的数字。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// 邀请能力默认按「注入 fetch 就关」处理（见 src/codearts/index.mjs 的 inviteEnabled），
// 这里显式关掉，免得用例写到真实缓存目录。
import { CodeArtsAuthPlugin, MODELS_CACHE_FILE, USAGE_CACHE_FILE, _internal as x } from "../src/codearts/index.mjs"
import { readCacheEntry } from "../src/cache.mjs"

const TEMP_DIRS = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codearts-t40-"))
  TEMP_DIRS.push(dir)
  return dir
}
test.after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true })
})

/** 目录缓存的键 = 网关主机：从源码里读出来（它是 `const`，没进 `_internal`）。 */
function gatewayHost() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "codearts", "index.mjs"), "utf8")
  const hit = source.match(/const\s+SNAP_HOST\s*=\s*"([^"]+)"[^\n]*the gateway host/)
  assert.ok(hit, "SNAP_HOST 那一行必须带 `// the gateway host` 标记（缓存键的真源）")
  return hit[1]
}

/** 一份「签好了」的凭据（字段与真机一致，值是明显的测试串）。 */
async function cred(overrides = {}) {
  const keyPair = await x.generateDpopKeyPair()
  const base = x.credentialFromTokenResponse(
    {
      credentials: {
        access_key_id: "AK-T40",
        secret_access_key: "SK-T40",
        security_token: "ST-T40",
        expiration: new Date(Date.now() + 3600_000).toISOString(),
      },
      refresh_token: "RT-T40",
    },
    "verifier",
    keyPair,
  )
  return {
    ...base,
    session_id: "sess-t40",
    user_phone: "138****0000",
    user_name: "hw123456789",
    ...overrides,
  }
}

const record = (inner) => ({
  type: "oauth",
  access: JSON.stringify(inner),
  refresh: inner.refresh_token,
  expires: x.expiresFromCredential(inner),
  accountId: x.accountIdentityOf(inner).id,
})

const BODY = {
  gateway: { result: { models: [] } },
  builtin: { builtinModels: [{ model_id: "GLM-5.2", model_name: "GLM-5.2\n", context_window: 200000, max_tokens: 32000 }] },
  agents: { agents: [{ agent_id: "agent-1", original_id: "build" }] },
  detail: { gpts: { models: [{ model_parameters: { model_id: "GLM-5.2", context_window: 200000 }, credit: { credit: 1 } }] } },
}

/**
 * 装上「假上游」：按 URL 记账并回最小可用的目录答案。
 * `override(url)` 返回一个 `Response` 就由它接管；返回 `undefined` 走默认。
 */
function stub(t, override) {
  const hits = []
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = String(url)
    hits.push({ url: u, method: String(init?.method ?? "GET") })
    const custom = override?.(u, init)
    if (custom !== undefined) return custom
    if (u === x.OPENGW_GATEWAY_CONFIG_URL) return Response.json(BODY.gateway)
    if (u === x.SNAP_MODEL_BUILTIN_URL) return Response.json(BODY.builtin)
    if (u === x.AGENT_LIST_URL) return Response.json(BODY.agents)
    if (u.startsWith(x.AGENT_DETAIL_URL("")) || u.includes("/agents/")) return Response.json(BODY.detail)
    if (u === x.SNAP_STATISTICS_URL) {
      return Response.json({ package: { package_name_cn: "企业版" }, metrics: [{ name: "usageTotalPackageCredit", package_credit_amount: 1000, package_credit_remain: 400 }] })
    }
    return new Response("{}", { status: 404 })
  })
  return {
    hits,
    /** 只算**业务**上游（IAM 读手机号不算：卡片要显示「谁的号」，进程内缓存 24h） */
    business: () => hits.filter((h) => !h.url.startsWith(x.IAM_HOST)),
    count: (part) => hits.filter((h) => h.url.includes(part)).length,
  }
}

const providerOf = () => ({ models: { "GLM-5.2": { id: "GLM-5.2", name: "GLM-5.2", limit: { context: 200000 }, tool_call: true } } })

// ── 1) 缓存命中 → 零上游 ────────────────────────────────────────────────
test("T40-C1) codearts auth.models 命中缓存 → 上游 **0** 次", async (t) => {
  const dir = tempDir()
  const host = gatewayHost()
  fs.writeFileSync(
    path.join(dir, MODELS_CACHE_FILE),
    JSON.stringify({
      [host]: {
        at: Date.now(),
        host,
        list: [{ id: "GLM-5.2", name: "GLM 缓存", context: 200000, output: 32000 }],
      },
    }),
  )

  const net = stub(t, () => {
    throw new Error("缓存命中还发请求 = 失败")
  })
  const plugin = await CodeArtsAuthPlugin({ directory: dir }, {})
  const models = await plugin.provider.models(providerOf(), { auth: record(await cred()) })

  assert.equal(net.hits.length, 0, `缓存命中时必须零上游（实际 ${net.hits.length} 次）`)
  assert.deepEqual(Object.keys(models), ["GLM-5.2"])
  assert.equal(models["GLM-5.2"].name, "GLM 缓存", "用的是缓存里的事实")
  assert.equal(models["GLM-5.2"].limit.context, 200000)
})

// ── 2) 多账号并发未命中 → 网关级只 1 次 ─────────────────────────────────
test("T40-C2) 多账号并发 auth.models（无缓存）→ 目录只拉 **1 次**（不是账号数）", async (t) => {
  const dir = tempDir()
  const net = stub(t)
  const plugin = await CodeArtsAuthPlugin({ directory: dir }, {})

  const accounts = await Promise.all(
    ["a", "b", "c", "d", "e"].map(async (n) => record(await cred({ session_id: `sess-${n}`, user_name: `hw-${n}` }))),
  )
  const out = await Promise.all(accounts.map((auth) => plugin.provider.models(providerOf(), { auth })))

  assert.equal(net.count("/api/v1/gateway/config"), 1, `5 个账号并发只能打 1 次 gateway/config（实际 ${net.count("/api/v1/gateway/config")} 次）`)
  assert.equal(net.count("/v1/model/builtin"), 1, `builtin 也只 1 次（实际 ${net.count("/v1/model/builtin")} 次）`)
  assert.equal(net.count("/agents"), 2, `agent 列表 + 详情各 1 次（实际 ${net.count("/agents")} 次）`)
  for (const models of out) assert.ok(models["GLM-5.2"], "每个账号都拿到目录")
})

// ── 3) 未命中 → 拉 1 次并写缓存；新实例（重启）零上游 ────────────────────
test("T40-C3) 无缓存 → 拉 1 次并写 codearts-models-cache.json；新实例零上游", async (t) => {
  const dir = tempDir()
  const net = stub(t, (u) => {
    if (u.includes("/snap-manager/v1/statistics/plugin")) return new Response("", { status: 403 })
    if (u === x.BENEFIT_CLAIM_URL) return new Response("", { status: 403 })
    if (u === x.OPENGW_GATEWAY_CONFIG_URL) return Response.json({ result: { models: [] } })
    if (u === x.SNAP_MODEL_BUILTIN_URL) {
      return Response.json({
        builtinModels: [{ model_id: "GLM-5.2", model_name: "GLM-5.2\n", context_window: 200000, max_tokens: 32000 }],
      })
    }
    if (u === x.AGENT_LIST_URL) return Response.json({ agents: [{ agent_id: "agent-1", original_id: "build" }] })
    if (/\/agents\//.test(u)) {
      return Response.json({
        gpts: { models: [{ model_parameters: { model_id: "GLM-5.2", context_window: 200000 }, credit: { credit: 1 } }] },
      })
    }
    return undefined
  })
  const auth = record(await cred())

  const first = await CodeArtsAuthPlugin({ directory: dir }, {})
  const before = net.hits.length
  const models = await first.provider.models(providerOf(), { auth })
  assert.equal(net.count("/api/v1/gateway/config"), 1, `冷启动只拉 1 次目录（实际 ${net.hits.length - before} 次台账）`)
  assert.ok(models["GLM-5.2"])

  const file = path.join(dir, MODELS_CACHE_FILE)
  assert.ok(fs.existsSync(file), "缓存文件必须落盘")
  const cache = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.ok(Array.isArray(cache[gatewayHost()]?.list), "结构是 { [网关]: { at, list } }")

  // 新实例 = magpie 重启：只读文件
  const net2 = stub(t, () => {
    throw new Error("重启后不许打上游")
  })
  const second = await CodeArtsAuthPlugin({ directory: dir }, {})
  const again = await second.provider.models(providerOf(), { auth })
  assert.deepEqual(net2.business(), [], "重启后一个业务端点都没被打（缓存命中，零上游）")
  assert.ok(again["GLM-5.2"])
})

// ── 4) 拉失败 → 不写缓存（下次仍重试）───────────────────────────────────
test("T40-C4) 目录拉取失败 → 回退静态表且**不写缓存**", async (t) => {
  const dir = tempDir()
  const net = stub(t, (u) => (u === x.SNAP_MODEL_BUILTIN_URL || u === x.OPENGW_GATEWAY_CONFIG_URL
    ? new Response("boom", { status: 500 })
    : undefined))
  const auth = record(await cred())
  const plugin = await CodeArtsAuthPlugin({ directory: dir }, {})

  const models = await plugin.provider.models(providerOf(), { auth })
  assert.deepEqual(Object.keys(models), ["GLM-5.2"], "必须回退静态表（不能给空目录）")
  assert.equal(
    readCacheEntry(dir, MODELS_CACHE_FILE, gatewayHost()),
    null,
    "失败绝不能写缓存",
  )

  await plugin.provider.models(providerOf(), { auth })
  assert.equal(net.count("/v1/model/builtin"), 2, "失败后下一次仍然重试")
})

// ── 5) usage 无缓存 → 零上游 + 「说明 · 额度未读」────────────────────────
// ── 5) usage **不做缓存**：每次被问都真读额度端点（T-42 回滚）───────────────
test("T40-C5) codearts auth.usage 每次都真读额度端点（有缓存文件也忽略它）", async (t) => {
  const dir = tempDir()
  const live = await cred()
  // 预先放一份"过期数据"的额度缓存：钩子必须**无视**它
  fs.writeFileSync(
    path.join(dir, USAGE_CACHE_FILE),
    JSON.stringify({ [x.usageCacheKeyOf(live)]: { at: 1, windows: [{ name: "额度 · 缓存套餐", used: 0, display: "0 / 1" }] } }),
  )
  const net = stub(t, (url) =>
    String(url).includes("/snap-manager/v1/statistics/plugin")
      ? Response.json({
          package: { package_name_cn: "企业版" },
          metrics: [{ name: "usageTotalPackageCredit", package_credit_amount: 1000, package_credit_remain: 400 }],
        })
      : Response.json({}),
  )
  const plugin = await CodeArtsAuthPlugin({ directory: dir }, {})

  const u = await plugin.auth.usage(async () => record(live))
  assert.ok(net.count("/snap-manager") >= 1, `usage 必须真打上游（实际 ${net.count("/snap-manager")} 次）`)
  const total = u.windows.find((w) => String(w.name) === "额度 · 总积分")
  assert.ok(total, `缺实时额度窗: ${JSON.stringify(u.windows)}`)
  assert.equal(total.limit, 1000, "用的是**实时**读到的数，不是缓存里的 1")
  assert.equal(total.amount, 600)
  assert.equal(u.error, undefined)
})
