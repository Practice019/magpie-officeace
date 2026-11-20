import test from "node:test"
import assert from "node:assert/strict"
import { OfficeAceAuthPlugin, CodeArtsAuthPlugin } from "../index.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"
import { credentialOf as officeAceCredentialOf } from "../src/credential.mjs"
import { _internal as codeArts } from "../src/codearts/index.mjs"

process.env.MAGPIE_OFFICEACE_NO_AUTO_UPDATE = "1"

const { privateJwk } = await generateDpopKeyPair()
const expiry = "2030-01-01T00:00:00Z"
const jwt = (profile, suffix) => `mock.${Buffer.from(JSON.stringify({ user_profile: profile })).toString("base64url")}.${suffix}`
const officeAceRow = {
  provider: "officeace",
  access: "test-oa-ak",
  secret: "test-oa-sk",
  securityToken: "test-oa-st",
  refreshToken: jwt({ account_id: "test-oa-domain" }, "oa"),
  expiresAt: expiry,
  dpopPrivateJwk: privateJwk,
  user_phone: "123****4567",
}
const codeArtsRow = {
  provider: "codearts",
  access_key_id: "test-ca-ak",
  secret_access_key: "test-ca-sk",
  security_token: "test-ca-st",
  refresh_token: jwt({ principal_urn: "iam::test-ca-domain:user:test-ca-user" }, "ca"),
  expires_at: expiry,
  code_verifier: "v".repeat(64),
  dpop_private_key_jwk: privateJwk,
  session_id: "a".repeat(32),
}

const vsCodeRow = {
  platform: "codearts",
  userid: "ca-oauth_test",
  auth: {
    accessKeyId: "test-vscode-ak",
    secretAccessKey: "test-vscode-sk",
    securityToken: "test-vscode-st",
    expiresAt: Math.floor(Date.parse(expiry) / 1000),
    refresh_token: jwt({ principal_urn: "iam::test-vscode-domain:user:test-vscode-user" }, "vscode"),
    clientId: "vscode-codebot",
    codeVerifier: "w".repeat(64),
  },
  dpop: { privateKeyJwk: privateJwk },
}

const json = JSON.stringify
const { provider: caProvider, ...caFields } = codeArtsRow
const wrapped = (provider, accounts) => ({ provider, version: 1, accounts })

/**
 * 一行 VSCode CodeBot 导出的凭据（`platform` + 顶层 `userid` + 嵌套 `auth`）。
 *
 * `refreshToken` 必须是一条带 `user_profile` 的 JWT：身份解析先看它，
 * 这里故意**不**在 claim 里放任何 user 字段，逼身份只能从 `userid` 来。
 */
const vsCodeAuthRow = (over = {}) => ({
  platform: "codearts",
  userid: over.userid ?? `ca-oauth_${"a1b2c3d4".repeat(8)}`,
  auth: {
    accessKeyId: over.accessKeyId ?? "test-vscode-bare-ak",
    secretAccessKey: "test-vscode-bare-sk",
    securityToken: over.securityToken ?? "test-vscode-bare-st",
    expiresAt: Math.floor(Date.parse(expiry) / 1000),
    refresh_token: jwt({}, "bare"),
    codeVerifier: "y".repeat(64),
    clientId: "vscode-codebot",
    ...(over.auth ?? {}),
  },
  dpop: { privateKeyJwk: privateJwk },
})

async function hooks(t) {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("意外的联网调用") })
  const set = t.mock.fn(() => { throw new Error("意外的宿主写入") })
  const client = { auth: { set } }
  const oa = (await OfficeAceAuthPlugin({ client }, { fetch })).auth
  const ca = (await CodeArtsAuthPlugin({ client }, { fetch })).auth
  t.after(() => {
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(set.mock.callCount(), 0)
  })
  return { oa, ca }
}

test("包入口暴露两个原生导入钩子，返回可被现有凭据读取器消费的登录结果", async (t) => {
  const { oa, ca } = await hooks(t)
  assert.match(oa.importFrom, /OfficeAce.*JSON/)
  assert.match(ca.importFrom, /CodeArts.*JSON/)
  const [office] = await oa.import([`\uFEFF${json(officeAceRow)}`])
  const [arts] = await ca.import([json(wrapped(caProvider, [caFields]))])
  assert.equal(office.type, "success")
  assert.equal(office.accountId, officeAceRow.user_phone)
  assert.equal(office.uid, "test-oa-domain")
  assert.equal(office.refresh, officeAceRow.refreshToken)
  assert.equal(office.expires, Date.parse(expiry))
  const officeCred = officeAceCredentialOf({ ...office, type: "oauth" })
  assert.deepEqual(officeCred.dpopPrivateJwk, privateJwk)
  assert.equal(officeCred.access, officeAceRow.access)
  assert.equal(arts.type, "success")
  assert.equal(arts.accountId, "iam::test-ca-domain:user:test-ca-user")
  assert.equal(arts.uid, arts.accountId)
  assert.equal(arts.refresh, codeArtsRow.refresh_token)
  assert.equal(arts.expires, Date.parse(expiry))
  const artsCred = codeArts.credentialOf({ ...arts, type: "oauth" })
  assert.deepEqual(artsCred.dpop_private_key_jwk, privateJwk)
  assert.equal(artsCred.code_verifier, codeArtsRow.code_verifier)
  assert.equal(artsCred.session_id, codeArtsRow.session_id)
})

test("导入 VS Code CodeBot 的嵌套凭据，并按 vscode-codebot 续期", async (t) => {
  const { ca } = await hooks(t)
  const [result] = await ca.import([json(vsCodeRow)])
  assert.equal(result.type, "success")
  assert.equal(result.uid, "iam::test-vscode-domain:user:test-vscode-user")
  const cred = codeArts.credentialOf({ ...result, type: "oauth" })
  assert.equal(cred.oauth_client, "vscode-codebot")
  assert.equal(cred.expires_at, "2030-01-01T00:00:00.000Z")
  assert.deepEqual(cred.dpop_private_key_jwk, privateJwk)
  let body
  const fetcher = async (url, init) => {
    assert.equal(String(url), codeArts.STS_TOKEN_ENDPOINT)
    body = new URLSearchParams(init.body)
    return Response.json({
      credentials: { access_key_id: "AK2", secret_access_key: "SK2", security_token: "ST2", expiration: expiry },
      refresh_token: "R2",
    })
  }
  const next = await codeArts.refreshCredential(cred, fetcher)
  assert.equal(body.get("client_id"), "vscode-codebot")
  assert.equal(body.get("code_verifier"), vsCodeRow.auth.codeVerifier)
  assert.equal(next.oauth_client, "vscode-codebot")
  assert.equal(next.access_key_id, "AK2")
})

test("VSCode CodeBot 行只有顶层 userid 时，身份从 row.userid 取（账号级稳定 uid）", async (t) => {
  const { ca } = await hooks(t)
  // 真机形状：身份只在顶层 `userid`（`ca-oauth_<hex>`），auth 里没有 userId。
  // 补之前 normalizeCodeArtsImport 不返回 user_id，successOf 拿不到稳定身份，
  // 整行被判「缺少可用的稳定账号身份」。
  const row = vsCodeAuthRow({ userid: `ca-oauth_${"a1b2c3d4".repeat(8)}` })

  const [first] = await ca.import([json(row)])
  assert.equal(first.type, "success", first.error)
  assert.ok(first.uid, "必须给出稳定 uid")
  assert.equal(first.accountId, first.uid)

  // 同一行再导入一次（新的 AK/STS，身份不变）必须得到同一个 uid —— 幂等，
  // 否则同一个号会在 magpie 里长成重复账号。
  const again = vsCodeAuthRow({
    userid: row.userid,
    accessKeyId: "test-vscode-bare-ak2",
    securityToken: "test-vscode-bare-st2",
  })
  const [second] = await ca.import([json(again)])
  assert.equal(second.type, "success", second.error)
  assert.equal(second.uid, first.uid)
})

test("顶层没有 userid 时回落到 auth.userId", async (t) => {
  const { ca } = await hooks(t)
  const row = vsCodeAuthRow({ userId: "ca-oauth_authlevel" })
  delete row.userid
  row.auth.userId = "ca-oauth_authlevel"

  const [result] = await ca.import([json(row)])
  assert.equal(result.type, "success", result.error)
  assert.equal(result.uid, "ca-oauth_authlevel")
})

test("既没有顶层 userid 也没有 auth.userId 时，仍按现行为失败", async (t) => {
  const { ca } = await hooks(t)
  const row = vsCodeAuthRow()
  delete row.userid

  const [result] = await ca.import([json(row)])
  assert.equal(result.type, "failed")
  assert.match(result.error, /缺少可用的稳定账号身份/)
})

test("顶层 userid 不是字符串（数字 / 对象 / 数组）时不会硬塞身份", async (t) => {
  const { ca } = await hooks(t)

  for (const userid of [12345, { id: "ca-oauth_x" }, ["ca-oauth_x"]]) {
    const [result] = await ca.import([json(vsCodeAuthRow({ userid }))])
    assert.equal(result.type, "failed", `userid=${json(userid)} 应当是 failed`)
    assert.match(result.error, /缺少可用的稳定账号身份/)
  }
})

test("秒级 expiresAt 转成 ISO，且不会被过期校验误判", async (t) => {
  const { ca } = await hooks(t)
  const seconds = Math.floor(Date.parse(expiry) / 1000)

  const [result] = await ca.import([json(vsCodeAuthRow({ userid: "ca-oauth_seconds" }))])
  assert.equal(result.type, "success", result.error)
  assert.equal(result.expires, seconds * 1000)
  const cred = codeArts.credentialOf({ ...result, type: "oauth" })
  assert.equal(cred.expires_at, "2030-01-01T00:00:00.000Z")
})

test("逐条拒绝错供应商、错误格式或身份、无效 DPoP 和非官方网关；错误不回显输入", async (t) => {
  const { oa, ca } = await hooks(t)
  const marker = "synthetic-do-not-echo"
  // 裸文本 + 一行坏行 + 一行合法 JSON：NDJSON 兼容下整份文件不再直接失败，
  // 所以这里让三条坏的都落在 **JSON 数组内**，保留「逐条拒绝」的原意。
  const results = await oa.import([
    "not-json at all\nnor this line\neither",
    json(wrapped("codearts", [officeAceRow])),
    json([{ ...officeAceRow, provider: undefined }]),
    json({ provider: "officeace", version: 2, accounts: [officeAceRow] }),
    json([
      marker,
      { ...officeAceRow, oauth_client: "some-other-client" },
      { ...officeAceRow, expiresAt: marker },
      { ...officeAceRow, accountId: marker },
      { ...officeAceRow, dpopPrivateJwk: { ...privateJwk, d: marker } },
      { ...officeAceRow, modelAppKey: marker },
      { ...officeAceRow, modelAppKey: marker, modelAppSecret: marker, maasBaseUrl: `https://${marker}.example` },
      { ...codeArtsRow, provider: "officeace" },
      { ...officeAceRow, modelAppKey: "test-model-key", modelAppSecret: "test-model-secret", maasBaseUrl: "modelgw-test.officeace.cn-southwest-2.huaweicloud-agentarts.com" },
    ]),
  ])
  assert.equal(results.length, 13)
  assert.equal(results.at(-1).type, "success")
  for (const [index, result] of results.slice(0, -1).entries()) {
    assert.equal(result.type, "failed")
    assert.deepEqual(Object.keys(result), ["type", "error"])
    assert.match(result.error, index < 4 ? /文件 \d/ : /文件 5 第 \d+ 条/)
    assert.ok(!result.error.includes(marker))
    assert.ok(!result.error.includes(officeAceRow.secret))
  }
  const badArts = await ca.import([json([
    { ...codeArtsRow, code_verifier: marker },
    { ...codeArtsRow, refresh_token: marker },
    { ...codeArtsRow, secret_access_key: "" },
    wrapped("codearts", [caFields]),
  ])])
  assert.deepEqual(badArts.map(({ type }) => type), Array(4).fill("failed"))
  assert.ok(!json(badArts).includes(marker))
})

test("批内不复用已接收的 UID、refresh token、STS AK 或 CodeArts 会话标识", async (t) => {
  const { oa, ca } = await hooks(t)
  const second = {
    ...officeAceRow,
    access: "test-oa-ak2",
    refreshToken: jwt({ account_id: "test-oa-domain2" }, "oa2"),
  }
  const results = await oa.import([
    json(officeAceRow),
    json([
      { ...second, refreshToken: jwt({ account_id: "test-oa-domain" }, "another") },
      { ...second, refreshToken: officeAceRow.refreshToken },
      { ...second, access: officeAceRow.access },
      second,
    ]),
  ])
  assert.deepEqual(results.map(({ type }) => type), ["success", "failed", "failed", "failed", "success"])
  assert.equal(results.at(-1).uid, "test-oa-domain2")

  const [firstArts, secondArts] = await ca.import([json([
    codeArtsRow,
    { ...codeArtsRow, access_key_id: "test-ca-ak2", refresh_token: jwt({ principal_urn: "test-ca-second" }, "ca2") },
  ])])
  assert.equal(firstArts.type, "success")
  assert.equal(secondArts.type, "failed")
  assert.match(secondArts.error, /同一会话标识/)
})

test("所有文件合计最多 100 条（含失败），取消不发布当前校验结果", async (t) => {
  const { oa, ca } = await hooks(t)
  const bounded = await oa.import(["broken", json(Array(102).fill(null)), json(officeAceRow)])
  assert.equal(bounded.length, 100)
  assert.ok(bounded.every(({ type }) => type === "failed"))
  assert.match(bounded.at(-1).error, /文件 2 第 99 条/)
  const aborted = new AbortController()
  aborted.abort("synthetic-cancel-reason")
  assert.deepEqual(await ca.import([json(codeArtsRow)], { signal: aborted.signal }), [])
  const during = new AbortController()
  const pending = ca.import([json(codeArtsRow), json(codeArtsRow)], { signal: during.signal })
  during.abort()
  assert.deepEqual(await pending, [])
})

// ---- NDJSON 兼容 ----------------------------------------------------------
//
// 用户要求「不要改文件格式」：VSCode 导出的凭据可能是一条一行（NDJSON），
// 之前 accountsOf() 一上来就 JSON.parse 整份文本，多行直接报「不支持 NDJSON」。
// 这组用例把「插件去兼容」钉死：行内坏一条只丢那条，不能连坐整份文件。

/** 造一条独立的 VSCode codearts 行（AK/STS/身份都不同，可同批导入）。 */
const lineRow = (n) => vsCodeAuthRow({
  userid: `ca-oauth_${String(n).padStart(8, "0").repeat(8)}`,
  accessKeyId: `ndjson-ak-${n}`,
  securityToken: `ndjson-st-${n}`,
  auth: { codeVerifier: `${n}`.padEnd(64, "n"), refresh_token: jwt({}, `ndjson-${n}`) },
})

test("NDJSON：两行完整对象 → 两条 success", async (t) => {
  const { ca } = await hooks(t)
  const text = `${json(lineRow(1))}\n${json(lineRow(2))}`
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success"])
  assert.notEqual(results[0].uid, results[1].uid)
})

test("NDJSON：三行 + 空行 + 行尾空白（含 \\r\\n）→ 三条 success", async (t) => {
  const { ca } = await hooks(t)
  const text = [json(lineRow(3)), "", `${json(lineRow(4))}   `, json(lineRow(5)), ""].join("\r\n")
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success", "success"])
})

test("NDJSON：中间一行坏掉只跳过它，其余照常成功", async (t) => {
  const { ca } = await hooks(t)
  const text = [json(lineRow(6)), "this is not json", json(lineRow(7))].join("\n")
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success"])
})

test("NDJSON：一行是数组时把元素展开", async (t) => {
  const { ca } = await hooks(t)
  const text = `${json([lineRow(8), lineRow(9)])}\n${json(lineRow(10))}`
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success", "success"])
})

test("NDJSON：注释行（# 与 //）被忽略", async (t) => {
  const { ca } = await hooks(t)
  const text = ["# exported from vscode codebot", json(lineRow(11)), "// second account", json(lineRow(12))].join("\n")
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success"])
})

test("纯垃圾文本仍按「需要 UTF-8 JSON」失败（不假装能读）", async (t) => {
  const { ca, oa } = await hooks(t)
  for (const text of ["this is a log file, not credentials", "not-json\nnor this\nnor that"]) {
    const [result] = await ca.import([text])
    assert.equal(result.type, "failed")
    assert.match(result.error, /需要 UTF-8 JSON/)

    const [office] = await oa.import([text])
    assert.equal(office.type, "failed")
    assert.match(office.error, /需要 UTF-8 JSON/)
  }
})

test("回归：单条对象、JSON 数组、version 容器三种旧输入行为不变", async (t) => {
  const { ca } = await hooks(t)

  const [single] = await ca.import([json(vsCodeRow)])
  assert.equal(single.type, "success")
  assert.equal(single.uid, "iam::test-vscode-domain:user:test-vscode-user")

  const [inArray] = await ca.import([json([{ ...vsCodeRow, userid: "ca-oauth_arr" }])])
  assert.equal(inArray.type, "success")

  const [inContainer] = await ca.import([json(wrapped(caProvider, [caFields]))])
  assert.equal(inContainer.type, "success")
  assert.equal(inContainer.uid, "iam::test-ca-domain:user:test-ca-user")
})

test("真实命令示例：三行 NDJSON 一次性导入（形状即一行一个对象）", async (t) => {
  const { ca } = await hooks(t)
  const text = [lineRow(21), lineRow(22), lineRow(23)].map(json).join("\n")
  const results = await ca.import([text])
  assert.deepEqual(results.map(({ type }) => type), ["success", "success", "success"])
  const uids = results.map(({ uid }) => uid)
  assert.equal(new Set(uids).size, 3, "三个号是三个不同的 uid")
  assert.equal(text.split("\n").length, 3)
})

// ---- register-machine 的 oa-oauth 导出结构 --------------------------------
//
// 真机文件 `accounts-export-*.jsonl` 的一行：`platform: "officeace"` + 顶层
// `userid`（`oa-oauth_<hex>`）+ 嵌套 `auth` / `dpop` / `gateway`。办公室的
// 导入钩子原本没有 normalizeRow，这行会因 `auth`/`dpop`/`gateway` 不在平铺
// 白名单里被整条拒掉（"存在不支持的字段"）。

const GATEWAY_BASE = "https://modelgw-0006.officeace.cn-southwest-2.huaweicloud-agentarts.com"

/** 造一条 register-machine 形状的 officeace 导出行（字段与真机同形）。 */
const registerMachineRow = (over = {}) => {
  const row = {
    platform: "officeace",
    userid: over.userid ?? `oa-oauth_${"ac484793dadcf71e".repeat(4)}`,
    auth: {
      accessKeyId: over.accessKeyId ?? "rm-ak",
      secretAccessKey: "rm-sk",
      securityToken: "rm-st",
      expiresAt: Math.floor(Date.parse(expiry) / 1000),
      refresh_token: jwt({ principal_urn: "iam::rm-domain:user:rm-user" }, "rm"),
      clientId: "codearts-agent",
      codeVerifier: "r".repeat(64),
      ...(over.auth ?? {}),
    },
    dpop: { privateKeyJwk: over.privateJwk ?? privateJwk },
  }
  if (over.gateway !== null) {
    row.gateway = {
      baseUrl: GATEWAY_BASE,
      modelAppKey: "rm-model-key",
      modelAppSecret: "rm-model-secret",
      ...(over.gateway ?? {}),
    }
  }
  return row
}

test("register-machine 的 oa-oauth 行（含 gateway）原样导入成功", async (t) => {
  const { oa } = await hooks(t)
  const [result] = await oa.import([json(registerMachineRow())])
  assert.equal(result.type, "success", result.error)
  assert.ok(result.uid, "必须有稳定身份")
  assert.ok(
    /^iam::rm-domain:user:rm-user$/.test(result.uid) || /^oa-oauth_/.test(result.uid),
    `uid 应是 iam:: URN 或 oa-oauth_ 前缀，实际 ${result.uid}`,
  )
})

test("同一条去掉 gateway 仍成功（缺 MaaS 不拦导入）", async (t) => {
  const { oa } = await hooks(t)
  const [result] = await oa.import([json(registerMachineRow({ gateway: null }))])
  assert.equal(result.type, "success", result.error)
  assert.ok(!("modelAppKey" in officeAceCredentialOf({ ...result, type: "oauth" })), "缺 gateway 时不写 MaaS 字段")
})

test("扁平旧格式（access/secret/securityToken…）原样通过（回归）", async (t) => {
  const { oa } = await hooks(t)
  const [result] = await oa.import([json(officeAceRow)])
  assert.equal(result.type, "success", result.error)
  assert.equal(result.uid, "test-oa-domain")
})

test('platform:"codearts" 的行传给 officeace 导入 → failed（不串味）', async (t) => {
  const { oa } = await hooks(t)
  const [result] = await oa.import([json({ ...registerMachineRow(), platform: "codearts" })])
  assert.equal(result.type, "failed")
  assert.match(result.error, /provider/)
})

test("register-machine 行的秒级 expiresAt 判成正确的未来时间（不是 1970）", async (t) => {
  const { oa } = await hooks(t)
  const seconds = Math.floor(Date.parse(expiry) / 1000)
  const [result] = await oa.import([json(registerMachineRow())])
  assert.equal(result.type, "success", result.error)
  assert.equal(result.expires, seconds * 1000)
  assert.ok(result.expires > Date.now(), "不能把过期时间落成 1970")
})

test("dpop.privateKeyJwk 映射后能被 validateImportDpop 接受（坏 key 仍被拒）", async (t) => {
  const { oa } = await hooks(t)

  const [bad] = await oa.import([
    json(registerMachineRow({ privateJwk: { ...privateJwk, d: "x".repeat(43) } })),
  ])
  assert.equal(bad.type, "failed", "映射不能绕过 DPoP 私钥校验")

  const [good] = await oa.import([json(registerMachineRow({ userid: "oa-oauth_other", accessKeyId: "rm-ak2" }))])
  assert.equal(good.type, "success", good.error)
  const cred = officeAceCredentialOf({ ...good, type: "oauth" })
  assert.deepEqual(cred.dpopPrivateJwk, privateJwk)
})
