import { useEffect, useRef } from "react"

/**
 * Chainlit 自定义元素：Live2D 形象（常驻在对话区左侧）
 *
 * Python 侧用法：
 *   el = cl.CustomElement(name="Live2DAvatar",
 *                         props={"model": "...", "rail": 220, "height": 340})
 *   await cl.Message(content="", elements=[el]).send()
 *
 * 语音朗读：再带一个 speech 字段即可让形象开口（协议见 public/live2d/README.md）：
 *   props={"model": "...",
 *          "speech": {"url": "/project/file/<key>?session_id=<sid>",
 *                     "seq": 1, "ts": 1730000000000}}
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么 DOM 全部用原生方式创建、挂在 window 上，而不是写在 return 里？
 *
 * Chainlit 用 react-live 渲染这个 JSX，它的实现是（来自前端产物源码）：
 *
 *   static getDerivedStateFromProps(props, state) {
 *     if (state.prevCode === props.code && state.prevScope === props.scope) return null
 *     return { element: evalWithScope(props), ... }   // new Function(...scopeKeys, code)
 *   }
 *
 * 注意 scope 是**按引用**（===）比较的，而 Chainlit 每次渲染都会传一个**新的对象字面量**
 * （{ import, props, apiClient, updateElement, ... }）。于是：
 *
 *   每来一条消息 → 消息列表重渲染 → 本组件重渲染 → scope 引用变了
 *   → react-live 重新 new Function 求值 → 得到一个**全新的组件函数**
 *   → React 认为类型变了 → 整棵子树卸载重建 → <iframe> 被销毁重建
 *   → Live2D 重新加载 → **每轮对话闪一次**
 *
 * 所以这里把 iframe、注入的样式、事件监听全部做成 window 上的单例：
 * React 把本组件重挂多少次都碰不到它们，闪屏就结构性地消失了。
 * 本组件只剩两件事：① 把 props 推给单例 ② 卸载后延迟拆除（并允许被下次挂载取消）。
 * ─────────────────────────────────────────────────────────────────────────
 */

const VIEWER_SRC = "/public/live2d/viewer/index.html"
const STYLE_ID = "live2d-avatar-style"
const STATE_KEY = "__live2dAvatar" // 挂在 window 上，跨 React 重建存活

const DEFAULT_RAIL = 220 // 左侧留给形象的列宽(px)
const DEFAULT_HEIGHT = 340 // 形象高度上限(px)
const DESTROY_DELAY = 2500 // 卸载后延迟多久才真正拆除(ms)

// ── 语音朗读(speech)的两道时间护栏 ──
// 刷新页面时 Chainlit 会重放全部历史消息，历史元素里的 speech 会被当成
// “刚下达的朗读指令”，导致一刷新就自己说话。下面两条把历史重放挡掉：
const REPLAY_WINDOW = 2000 // 页面刚加载的这段时间内收到的 speech 一律视为历史重放
const SPEECH_MAX_AGE = 5000 // speech.ts 超过这么久也视为过期

/**
 * 生成要注入页面的样式。
 *
 * 关键一条是给「顶栏以下的内容区」加 padding-left。Chainlit 的层级是：
 *   #root > div.sidebar-wrapper > div.h-screen > div（应用列）
 *     ├ #header                        ← 用 :not() 排除，顶栏保持通栏
 *     └ div（内容区：消息列表 + 输入框）  ← 就是它让位
 * 用结构化选择器而不是 Tailwind 类名，Chainlit 换类名不会失效；
 * 万一层级变了（表现：左侧不再让位、形象盖在对话上），用浏览器检查器确认后改这一行即可。
 */
function buildCss(rail, height) {
  return [
    ":root { --live2d-rail: " + rail + "px; --live2d-height: " + height + "px; }",
    "#root > div > div > div > div:not(#header) { padding-left: var(--live2d-rail); }",
    ".live2d-avatar-fixed {",
    "  position: fixed;",
    "  left: 0;",
    "  bottom: 0;",
    "  width: var(--live2d-rail);",
    "  height: min(var(--live2d-height), calc(100vh - 80px));",
    "  overflow: hidden;",
    "}",
    ".live2d-avatar-fixed > iframe {",
    "  display: block; width: 100%; height: 100%; border: 0; background: transparent;",
    "}",
    ".live2d-avatar-status {",
    "  position: absolute; inset: 0;",
    "  display: flex; align-items: center; justify-content: center;",
    "  padding: 10px; text-align: center;",
    '  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;',
    "  color: #9aa0a6;",
    "}",
    ".live2d-avatar-status[hidden] { display: none; }",
    ".live2d-avatar-status.is-error { color: #e5484d; }",
    // 承载标记的那条消息内容是空的（形象不在消息流里），但 Chainlit 仍会给它渲染一个
    // 空头像 span，于是在对话里留一个孤零零的图标。挂载时给那一行加个类把它收掉。
    // 用加类而不是 `:has()`：`:has()` 在大量 DOM 变更（流式输出）时要做祖先匹配重算，更贵。
    // 注意：不能对整条消息用 display:none，那会让整棵子树都不渲染。
    ".live2d-avatar-row { height: 0; min-height: 0; margin: 0; padding: 0; }",
    ".live2d-avatar-row > span { display: none; }",
    // 窗口窄/矮时自动收窄这一列，把宽度还给对话区（媒体查询放后面，所以能覆盖上面的值）
    "@media (max-width: 900px) { :root { --live2d-rail: " + Math.min(rail, 170) + "px; --live2d-height: " + Math.min(height, 280) + "px; } }",
    "@media (max-height: 560px) { :root { --live2d-height: " + Math.min(height, 260) + "px; } }",
  ].join("\n")
}

/** 写上样式。故意不随组件卸载而移除（否则每轮对话布局都会跳一下），只在真正拆除时删。 */
function ensureStyle(rail, height) {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  const css = buildCss(rail, height)
  if (style.textContent !== css) style.textContent = css
}

/** 创建（只创建一次）常驻实例：所有 DOM 与监听器都归它管，和 React 无关 */
function ensureSingleton() {
  // 正常情况下单例已存在，直接复用。
  // 但如果状态还在、盒子却已经不在 DOM 里（异常情况，例如曾被误删），
  // 就丢掉旧状态重建，避免“状态在、形象却不在”这种半死状态。
  const existing = window[STATE_KEY]
  if (existing && existing.box.parentNode) return existing
  if (existing) delete window[STATE_KEY]

  // 兜底：万一 window 上的状态丢了但 DOM 还在（脚本被重新求值等），先清掉残留
  const stale = document.querySelector(".live2d-avatar-fixed")
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale)

  const box = document.createElement("div")
  box.className = "live2d-avatar-fixed"

  const frame = document.createElement("iframe")
  frame.title = "Live2D Avatar"
  frame.setAttribute("scrolling", "no")
  frame.setAttribute("allowtransparency", "true")
  // 语音朗读要在 iframe 里播放音频，显式声明 autoplay 权限，
  // 避免被浏览器的自动播放策略拦掉（父页面发消息本身已提供用户手势）。
  frame.setAttribute("allow", "autoplay")

  const status = document.createElement("div")
  status.className = "live2d-avatar-status"
  status.textContent = "Live2D 加载中…"

  box.appendChild(frame)
  box.appendChild(status)
  document.body.appendChild(box)

  const state = {
    box: box,
    frame: frame,
    status: status,
    src: "",
    configKey: "",
    payload: null, // 最后一次下发的配置，iframe 就绪后需要补发一次
    bootAt: Date.now(), // 用于识别“页面刚加载时的历史重放”
  }

  // ── 画布位置缓存 ──
  // getBoundingClientRect() 会强制同步布局；流式输出时 DOM 一直在变，
  // 如果每次 mousemove 都去量一次，等于把「鼠标一动就重排整页」变成常态，白白加重卡顿。
  // 这个盒子是 fixed 定位，只在窗口尺寸/自身尺寸变化时才动，所以缓存 + 失效即可。
  const rectCache = { left: 0, top: 0, dirty: true }
  const markRectDirty = function () {
    rectCache.dirty = true
  }
  const readRect = function () {
    if (rectCache.dirty) {
      const r = frame.getBoundingClientRect()
      rectCache.left = r.left
      rectCache.top = r.top
      rectCache.dirty = false
    }
    return rectCache
  }
  window.addEventListener("resize", markRectDirty)
  state.markRectDirty = markRectDirty

  // 全局鼠标追踪：元素在页面里（不在 iframe 内），所以在页面层监听，
  // 换算成 iframe 画布坐标后发给 viewer，由它调 model.focus(x, y)。
  // 这样光标在对话文字、输入框、页头等任何位置，形象都会看向光标。
  // 光标在形象区域内时浏览器的 mousemove 进的是 iframe（父页面收不到），
  // 那种情况由 viewer 里 PIXI 自己的交互处理，两者互补不冲突。
  state.onMouseMove = function (event) {
    const win = frame.contentWindow
    if (!win) return
    const rect = readRect()
    win.postMessage(
      {
        source: "chainlit",
        type: "pointer",
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      },
      "*"
    )
  }
  window.addEventListener("mousemove", state.onMouseMove, { passive: true })

  // 子页面的加载状态
  state.onMessage = function (event) {
    const data = event.data
    if (!data || data.source !== "live2d-viewer") return
    if (data.type === "ready") {
      status.hidden = true
      status.classList.remove("is-error")
      // iframe 刚加载完：把最后一次配置补发一次。
      // 顺序很重要 —— 首次 configure() 只来得及设置 src，那时 iframe 还没加载，
      // postMessage 会丢；如果这段时间里正好来了语音指令，就得靠这里补上。
      // viewer 侧按 speech.seq 去重，所以重复下发不会重复播放。
      if (state.payload) postConfig(state, state.payload)
    } else if (data.type === "error") {
      status.hidden = false
      status.classList.add("is-error")
      status.textContent = "Live2D 加载失败：" + (data.message || "未知错误")
    }
  }
  window.addEventListener("message", state.onMessage)

  window[STATE_KEY] = state
  return state
}

/**
 * speech 是不是“刚刚下达的”。
 *
 * 两条护栏缺一不可：
 *   1. REPLAY_WINDOW —— 页面刚加载的那两秒收到的一切 speech 都是历史重放；
 *   2. SPEECH_MAX_AGE —— 服务端时间戳兜底（服务端与浏览器同机演示，时钟一致）。
 */
function isLiveSpeech(speech, bootAt) {
  if (!speech || (!speech.url && !speech.stop)) return false
  if (Date.now() - bootAt < REPLAY_WINDOW) return false
  if (typeof speech.ts === "number" && Date.now() - speech.ts > SPEECH_MAX_AGE) return false
  return true
}

/**
 * 归一化要下发的配置：把历史重放的 speech 摘掉。
 * 这样重放时所有历史元素算出来的 configKey 完全一致，
 * 配合下面的 configKey 比较，天然只会下发一次。
 */
function normalizePayload(state, payload) {
  const out = Object.assign({}, payload)
  if (!isLiveSpeech(payload.speech, state.bootAt)) delete out.speech
  return out
}

/** 把配置发进 iframe */
function postConfig(state, payload) {
  const win = state.frame.contentWindow
  if (!win) return
  win.postMessage(Object.assign({ source: "chainlit", type: "config" }, payload), "*")
}

/** 把 props 推给常驻实例；内容没变就不重复发消息，避免无谓的重载 */
function configure(state, payload) {
  payload = normalizePayload(state, payload)

  const key = JSON.stringify(payload)
  if (state.configKey === key) return
  state.configKey = key
  state.payload = payload

  if (!state.src) {
    // 首次：直接把参数拼进 src，避免「先按默认值加载、再切一次」
    const params = ["model=" + encodeURIComponent(payload.model)]
    if (payload.scale !== undefined) params.push("scale=" + encodeURIComponent(String(payload.scale)))
    if (payload.align) params.push("align=" + encodeURIComponent(payload.align))
    if (payload.offsetX !== undefined) params.push("offsetX=" + encodeURIComponent(String(payload.offsetX)))
    if (payload.anchorY) params.push("anchorY=" + encodeURIComponent(payload.anchorY))
    if (payload.fps !== undefined) params.push("fps=" + encodeURIComponent(String(payload.fps)))
    if (payload.idle) params.push("idle=" + encodeURIComponent(payload.idle))
    state.src = VIEWER_SRC + "?" + params.join("&")
    state.frame.src = state.src
    return
  }

  postConfig(state, payload)
}

/**
 * 真正拆除。
 *
 * 只在「延迟到期」且「DOM 里确实没有标记节点」时执行。
 *
 * 后半句是关键：**每条 Live2D 元素消息都会挂一个 React 组件实例**，而
 * `window.__live2dAvatar` 是它们共用的单例。只要任意一个实例的重新挂载晚于
 * DESTROY_DELAY（例如开关设置面板、或历史消息重排），它排下的拆除定时器就会在
 * 「组件其实还挂在页面上」的时候到期 —— 那样会把盒子和注入的样式一起删掉，
 * 而剩下的实例因为依赖项没变、不会重跑 effect，形象就再也回不来了。
 * 用标记节点做最终裁决，可以彻底避免这种误删。
 */
function destroy() {
  const state = window[STATE_KEY]
  if (!state) return
  if (document.querySelector(".live2d-avatar-marker")) return

  window.removeEventListener("mousemove", state.onMouseMove, { passive: true })
  window.removeEventListener("message", state.onMessage)
  window.removeEventListener("resize", state.markRectDirty)
  if (state.box.parentNode) state.box.parentNode.removeChild(state.box)
  const style = document.getElementById(STYLE_ID)
  if (style && style.parentNode) style.parentNode.removeChild(style)
  delete window[STATE_KEY]
}

export default function Live2DAvatar() {
  const markerRef = useRef(null)
  const modelUrl = props.model || ""
  const rail = typeof props.rail === "number" && props.rail > 0 ? props.rail : DEFAULT_RAIL
  const height = typeof props.height === "number" && props.height > 0 ? props.height : DEFAULT_HEIGHT

  // 只传「显式指定过」的值：没传的部分用 public/live2d/viewer/index.html 里的
  // data-align / data-offset-x / data-anchor-y / data-scale 默认值
  const payload = {
    model: modelUrl,
    rail: rail,
    height: height,
    scale: typeof props.scale === "number" && props.scale > 0 ? props.scale : undefined,
    align: props.align || undefined,
    offsetX: typeof props.offsetX === "number" ? props.offsetX : undefined,
    anchorY: props.anchorY || undefined,
    // 渲染帧率上限，默认 60（viewer 里的默认值）。发烧/卡顿时可以降到 30。
    fps: typeof props.fps === "number" && props.fps > 0 ? props.fps : undefined,
    // 待机动作组名；默认用 viewer 里的 "Idle"（会自动退让），"none" 表示不起播动作。
    idle: props.idle || undefined,
    // 语音朗读指令：{url, seq, ts, text?}。是不是“新消息”由 isLiveSpeech() 判断，
    // 刷新页面时的历史重放会被摘掉。
    speech: props.speech && (props.speech.url || props.speech.stop) ? props.speech : undefined,
  }

  useEffect(
    function () {
      const state = ensureSingleton()
      // 上一次卸载排的拆除计划取消掉：说明只是 React 重建，形象不该动
      if (state.destroyTimer) {
        clearTimeout(state.destroyTimer)
        state.destroyTimer = 0
      }
      ensureStyle(rail, height)
      configure(state, payload)

      // 自身尺寸可能变了（rail/height 来自 props），位置缓存作废
      if (state.markRectDirty) state.markRectDirty()

      // 把承载标记的那条消息行收掉（形象本人不在消息流里）
      const marker = markerRef.current
      if (marker && marker.closest) {
        const row = marker.closest(".ai-message")
        if (row) row.classList.add("live2d-avatar-row")
      }

      return function () {
        // 不立刻拆：react-live 每次渲染都会换 scope 从而重建整棵子树，
        // 立刻拆掉就会变成「每轮对话闪一次」。延迟拆除，期间若重新挂载就取消；
        // 即使定时器到期，destroy() 也会再用标记节点确认一次。
        state.destroyTimer = setTimeout(destroy, DESTROY_DELAY)
      }
    },
    [modelUrl, rail, height, payload.scale, payload.align, payload.offsetX, payload.anchorY, payload.fps, payload.idle, payload.speech]
  )

  // 只为让 Chainlit 那条空消息行能被上面的样式收掉；形象本身不在消息流里
  return <span ref={markerRef} className="live2d-avatar-marker" aria-hidden="true" />
}
