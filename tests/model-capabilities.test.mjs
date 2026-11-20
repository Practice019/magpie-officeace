// model-capabilities.test.mjs 模型能力**从上游读**，不再写死「纯文本」。
//
// # 背景
//
// 用户原话：「每个模型它能支持什么，全部从上游获取就行了。」
//
// # 两个 provider 的上游今天到底给不给能力
//
//	officeace（华为云 MaaS / AgentArts）
//	  `GET /v2/models`（注册表）+ `GET /v1/model-token-rates`（可计费清单）
//	  都只回 id / name ⇒ **不提供能力声明**（见 README「模型能力从哪来」）
//	codearts（opengw gateway/config + builtin）
//	  只回 model_id / model_name / context_window / max_tokens ⇒ 同样不提供
//
// 所以「现在全是纯文本」是**上游的事实**，不是我们写死的判断：
// `upstreamCapabilities()` 一旦在上游行里看到 `capabilities` / `vision` /
// `input_modalities` 就接管。这里用「假装上游下发了」的 fixture 钉住那条路。
//
// ⚠ 全部是纯函数 / 注入行：本测试不打网络。

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  modelEntry,
  liveModels,
  upstreamCapabilities,
  pickUpstreamCapabilities,
} from "../src/models.mjs"
import { stripPrefix } from "../src/chat.mjs"

test("上游什么都没说 → 纯文本（这是现状，也是回归钉）", () => {
  const cap = upstreamCapabilities(undefined)

  assert.deepEqual(cap.inputModalities, ["text"])
  assert.deepEqual(cap.outputModalities, ["text"])
  assert.equal(cap.vision, false)
  assert.equal(cap.toolcall, true, "上游没否认工具能力")
  assert.deepEqual(cap.input, { text: true, image: false, audio: false, video: false, pdf: false })
})

test("上游说 vision:true → vision / 模态数组 / 布尔三项一致", () => {
  const cap = upstreamCapabilities({
    capabilities: {
      vision: true,
      function_calling: false,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
  })

  assert.equal(cap.vision, true)
  assert.deepEqual(cap.inputModalities, ["text", "image"])
  assert.equal(cap.input.image, true)
  assert.equal(cap.toolcall, false)

  // vision 为真但数组没写 image：补齐（否则两份声明互相打脸）
  const half = upstreamCapabilities({ capabilities: { vision: true } })
  assert.deepEqual(half.inputModalities, ["text", "image"])
  assert.equal(half.input.image, true)
})

test("modelEntry：模型条目带上上游的能力与模态", () => {
  const entry = modelEntry({
    id: "glm-vl",
    name: "GLM VL",
    upstream: pickUpstreamCapabilities({ id: "glm-vl", capabilities: { vision: true, input_modalities: ["text", "image"] } }),
  })

  assert.equal(entry.capabilities.input.image, true)
  assert.equal(entry.capabilities.attachment, true)
  assert.deepEqual(entry.modalities, { input: ["text", "image"], output: ["text"] })
  assert.equal(entry.attachment, true)
  assert.equal(entry.supportsImage, true)
})

test("modelEntry：没有上游能力声明 → 保持原样（纯文本、可调工具）", () => {
  const entry = modelEntry({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })

  assert.deepEqual(entry.capabilities.input, { text: true, image: false, audio: false, video: false, pdf: false })
  assert.deepEqual(entry.modalities, { input: ["text"], output: ["text"] })
  assert.equal(entry.attachment, false)
  assert.equal(entry.supportsImage, false)
  assert.equal(entry.capabilities.toolcall, true)
})

test("liveModels：上游行带能力就按映射，不带就纯文本（同一次响应里两种行）", () => {
  const out = liveModels(
    [
      { id: "sees", name: "Sees Things", capabilities: { vision: true, input_modalities: ["text", "image"] } },
      { id: "plain", name: "Plain" },
      "just-an-id",
    ],
    "https://maas.example.com",
    null,
  )

  assert.deepEqual(out.sees.modalities.input, ["text", "image"])
  assert.equal(out.sees.capabilities.input.image, true)
  assert.equal(out.sees.attachment, true)

  assert.deepEqual(out.plain.modalities, { input: ["text"], output: ["text"] })
  assert.equal(out.plain.capabilities.input.image, false)
  assert.equal(out.plain.attachment, false)

  assert.equal(out["just-an-id"].capabilities.input.image, false)
})

test("pickUpstreamCapabilities：上游没给就不带（undefined ≠ 说了纯文本）", () => {
  assert.equal(pickUpstreamCapabilities({ id: "x", name: "X" }), null)
  assert.equal(pickUpstreamCapabilities("x"), null)
  assert.equal(pickUpstreamCapabilities({ id: "x", capabilities: null }), null)
  assert.deepEqual(pickUpstreamCapabilities({ id: "x", vision: true }), { vision: true })
})

test("officeace 转发：多模态 content 数组原样透传（不裁 image_url）", () => {
  const parts = [
    { type: "text", text: "hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
  ]
  const body = JSON.stringify({
    model: "officeace/deepseek-v4.1-flash",
    messages: [{ role: "user", content: parts }],
  })

  const sent = JSON.parse(stripPrefix(body))
  assert.equal(sent.model, "deepseek-v4.1-flash", "只还原模型前缀")
  assert.deepEqual(sent.messages[0].content, parts, "image_url 段必须逐字段还在")
})
