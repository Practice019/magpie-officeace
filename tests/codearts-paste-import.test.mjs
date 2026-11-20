// codearts-paste-import.test.mjs —— CodeArts 登录弹窗里的第 3 项：
// 「从文件导入（粘贴 JSON / NDJSON）」。
//
// 另外三个 provider（OfficeAce / loomy / quwork）都有这一项，只有 CodeArts 漏了。
// 断言全部来自宿主源码（host-acc034d984c6.js）：
//   2822  oauth 方法的 authorize 必须返回带 callback 的对象
//   2853  callback() → keptAs → save 落盘
//   1346-1370  client.auth.set 是插件写账号的正规通道
//   2758-2763  save() 写的 body 是 {type:"oauth", refresh, access, expires, ...extra}
//
// ⚠ 这里注入 fetch：插件实例本身不联网，导入路径也不该联网。

process.env.MAGPIE_OFFICEACE_NO_AUTO_UPDATE = "1"

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CodeArtsAuthPlugin } from "../src/codearts/index.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"

const { privateJwk } = await generateDpopKeyPair()
const EXPIRY = "2030-01-01T00:00:00Z"
const VERIFIER = "v".repeat(64)
const LABEL = "从文件导入（粘贴 JSON / NDJSON）"

/** 一条合法的 CodeArts 导出行（`normalizeCodeArtsImport` 认的那几种形状之一：VSCode 的 auth 块）。 */
const codeArtsRow = (over = {}) => ({
  provider: "codearts",
  auth: {
    accessKeyId: over.ak ?? "CA-AK-1",
    secretAccessKey: "CA-SK-1",
    securityToken: "CA-ST-1",
    expiresAt: EXPIRY,
    refresh_token: over.refresh ?? "ca-refresh-1",
    codeVerifier: VERIFIER,
    clientId: "codearts-agent",
    userId: over.uid ?? "ca-oauth_aaaa1111",
  },
  dpop: { privateKeyJwk: privateJwk },
})

function tempAuthFile() {
  const dir = mkdtempSync(join(tmpdir(), "codearts-paste-"))
  return join(dir, "plugin-auth.json")
}

function fakeClient() {
  /** @type {Array<{key: string, body: any}>} */
  const writes = []
  /** @type {any[]} */
  const toasts = []
  const client = {
    auth: {
      set: async ({ path, body }) => {
        writes.push({ key: path.id, body })
      },
    },
    tui: { showToast: (o) => toasts.push(o) },
    app: { log: () => {} },
  }
  return { writes, toasts, client }
}

/** 只生成插件实例，不触发任何联网。 */
async function plugin(t, { file = tempAuthFile(), client = fakeClient().client } = {}) {
  const instance = await CodeArtsAuthPlugin({ client }, { authFile: file })
  return { instance }
}

const pasteMethodOf = (instance) => instance.auth.methods.find((m) => m.label === LABEL)

test("CodeArts 登录弹窗里有「从文件导入（粘贴 JSON / NDJSON）」", async (t) => {
  const { instance } = await plugin(t)
  const method = pasteMethodOf(instance)
  assert.ok(method, "CodeArts 的 auth.methods 里必须有该导入项")
  assert.equal(method.type, "oauth", "必须是 oauth：账号卡/续期都读 access + refresh")
  assert.equal(method.labels.en, "import from text (JSON / NDJSON)")
  assert.equal(method.prompts[0].type, "text")
  assert.equal(method.prompts[0].key, "text")
  assert.equal(typeof method.authorize, "function")
  // 原有的两项不能被挤掉
  assert.equal(instance.auth.methods.length, 3)
  assert.equal(instance.auth.methods[0].label, "Sign in with Huawei Cloud")
  assert.equal(instance.auth.methods[1].label, "一次验证码登录两个平台")
})

test("粘贴单个 CodeArts 账号：callback 返回 success，写盘 body 与宿主 save() 同构", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = pasteMethodOf(instance)

  const started = await method.authorize({ text: JSON.stringify(codeArtsRow()) })
  assert.equal(typeof started.callback, "function", "oauth 方法必须给 callback")
  assert.equal(started.opened, true)

  const r = await started.callback()
  assert.equal(r.type, "success")
  assert.equal(r.uid, "ca-oauth_aaaa1111")
  assert.equal(r.refresh, "ca-refresh-1")

  assert.equal(writes.length, 1)
  assert.match(writes[0].key, /^codearts#/)
  assert.equal(writes[0].body.type, "oauth")
  assert.equal(writes[0].body.refresh, "ca-refresh-1")
  assert.equal(JSON.parse(writes[0].body.access).access_key_id, "CA-AK-1")
})

test("粘贴 NDJSON 两行：两条都导入（第 1 条给宿主，第 2 条自己写）", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = pasteMethodOf(instance)

  const text = [
    JSON.stringify(codeArtsRow({ ak: "CA-AK-1", uid: "ca-oauth_one1", refresh: "r-one" })),
    JSON.stringify(codeArtsRow({ ak: "CA-AK-2", uid: "ca-oauth_two2", refresh: "r-two" })),
  ].join("\n")
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(r.uid, "ca-oauth_one1", "第 1 条交宿主保存")
  assert.deepEqual(writes.map((w) => w.body.refresh), ["r-one", "r-two"])
  assert.notEqual(writes[0].key, writes[1].key, "两个号不能抢同一个账号键")
})

test("坏行只跳过那一行：好行照样导入", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = pasteMethodOf(instance)

  const text = `${JSON.stringify(codeArtsRow())}\n{ 这一行不是 JSON`
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(writes.length, 1)
  // 宿主只在出错时转述我们的提示，成功时不会 —— 所以「哪条没进来」随结果带回（`note`）。
  // 行级错误的位置前缀是 `第 N 条`（`makeCollector` 的 `fail()` 只对「整份文件读不动」加 `文件 N`）。
  assert.match(String(r.note ?? ""), /第 2 条：这一行不是合法的 JSON/)
})

test("单次最多 100 条：101 条只处理前 100 条", async (t) => {
  const file = tempAuthFile()
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = pasteMethodOf(instance)

  const rows = Array.from({ length: 101 }, (_, i) =>
    JSON.stringify(codeArtsRow({ ak: `CA-AK-${i}`, uid: `ca-oauth_u${i}`, refresh: `r-${i}` })),
  )
  const started = await method.authorize({ text: rows.join("\n") })
  const r = await started.callback()

  assert.equal(r.type, "success")
  // `makePasteImportMethod` 的约定：第 1 条返回给宿主落盘，**其余每条**才走 client.auth.set。
  // 上限 100 条（`IMPORT_MOST`）→ 收了 100 条，插件自己写 100 条，第 101 条被挡掉。
  assert.equal(writes.length, 100)
  assert.equal(JSON.parse(writes[99].body.access).access_key_id, "CA-AK-99", "第 101 条必须被上限挡掉")
  assert.equal(r.uid, "ca-oauth_u0", "第 1 条交宿主保存")
})

test("磁盘上已有的 CodeArts 账号不重复导入（按 refresh token 去重）", async (t) => {
  const file = tempAuthFile()
  writeFileSync(file, JSON.stringify({ codearts: { type: "oauth", access: "{}", refresh: "ca-refresh-1" } }))
  const { writes, client } = fakeClient()
  const { instance } = await plugin(t, { file, client })
  const method = pasteMethodOf(instance)

  const started = await method.authorize({ text: JSON.stringify(codeArtsRow({ refresh: "ca-refresh-1" })) })
  const r = await started.callback()

  assert.equal(r.type, "failed")
  assert.match(r.error, /已经在 magpie 里/)
  assert.equal(writes.length, 0)
})

test("认不出的内容返回 {type:'failed', error} 且按「第 N 条：<原因>」报错", async (t) => {
  const file = tempAuthFile()
  const { instance } = await plugin(t, { file })
  const method = pasteMethodOf(instance)

  const empty = await method.authorize({ text: "  " })
  assert.equal(empty.type, "failed")

  const started = await method.authorize({ text: "hello world" })
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.match(String(r.error), /文件 1/)
})

test("CodeArts 用的是自己的 importer：OfficeAce 的行必须被拒", async (t) => {
  const file = tempAuthFile()
  const { instance } = await plugin(t, { file })
  const method = pasteMethodOf(instance)

  const officeRow = {
    provider: "officeace",
    access: "oa-ak",
    secret: "oa-sk",
    securityToken: "oa-st",
    refreshToken: "oa-refresh",
    expiresAt: EXPIRY,
    dpopPrivateJwk: privateJwk,
  }
  const started = await method.authorize({ text: JSON.stringify(officeRow) })
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.match(String(r.error), /provider/)
})