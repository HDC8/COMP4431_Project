# Live2D 前端资源

Chainlit 只通过 `/public/**` 暴露静态文件（且它会把路径 `resolve()` 后做校验，所以目录联接/软链会被判 400），
因此 Live2D 相关的资源都放在这里。

## 目录

```
public/
├── elements/
│   └── Live2DAvatar.jsx        # 【当前采用】自定义元素版
│                               # 位置固定：public/elements/<元素名>.jsx
│                               # 形象固定到窗口左侧，并自己注入样式给对话区留位
└── live2d/
    ├── viewer/
    │   ├── index.html          # 真正的 Live2D 页面（iframe 里加载的就是它）
    │   └── viewer.js           # 渲染 / 待机动作 / 鼠标追踪
    ├── vendor/                 # 运行时（顺序不能变：Core → PIXI → pixi-live2d-display）
    │   ├── live2dcubismcore.min.js
    │   ├── pixi.min.js                       # 必须 6.x（7/8 没有 PIXI.plugins.interaction）
    │   └── pixi-live2d-display-cubism4.min.js # 只用 cubism4 构建，不要用根入口
    └── models/
        ├── congyu/            # 丛雨（Cubism 4，画布 1500×3000，贴图 4096×2048）
        └── Amiya/             # 阿米娅（Cubism 3.3，画布 2332×2192，贴图 8192×4096）
                               # 入口 Amiya.model3.json；原始中文文件名已全部改为 ASCII（兔兔-阿米娅.* → Amiya.*）
```

## 换模型怎么做

1. 把新模型文件夹整个丢进 `public/live2d/models/` 下（保持原有的相对目录结构，贴图/动作/表情都在里面）。
2. 改 `app.py` 里的 `LIVE2D_MODEL_URL` 指向新的 `*.model3.json`（它会作为 props 传给元素）。

不用改 `viewer.js`：尺寸自适应是按模型自身画布尺寸算的，缩放/居中/DPI 都会自动处理。

## 元素版（当前采用的接入方式）

由 `app.py` 的 `on_chat_start` 发一条带 `cl.CustomElement(name="Live2DAvatar")` 的消息：

```python
avatar = cl.CustomElement(
    name="Live2DAvatar",
    props={"model": LIVE2D_MODEL_URL, "rail": 220, "height": 340},
)
await cl.Message(content="", elements=[avatar]).send()
```

它同时解决了两个曾经的问题：

| 问题 | 解法 |
|---|---|
| 形象挡住对话内容 | 元素往页面注入一条样式，给「顶栏以下的对话区」加 `padding-left`，左侧**真的空出一列**给形象，对话内容整体右移、自动换行；`#header` 被 `:not()` 排除，顶栏保持通栏 |
| 对话内容反过来盖住形象 | 形象本体用 `position: fixed` 钉在窗口左侧，**脱离消息流**（它所在的那条消息算下来是 0 高度），既不在滚动容器里也不参与排版，新消息/滚动都碰不到它 |

另外还顺手处理了一个小瑕疵：Chainlit 会给每条消息渲染一个头像，而这条消息内容是空的，
于是在对话里会留一个孤零零的头像图标 —— 组件只往消息里放一个空的 `<span class="live2d-avatar-marker">`，
样式里用 `:has(.live2d-avatar-marker)` 把这条行连同头像一起收掉。
⚠️ 这里**不能**对整条消息用 `display: none`，那会让整棵子树都不渲染。

### 为什么 DOM 不是写在 return 里（重要，关系到会不会闪屏）

Chainlit 用 react-live 渲染这个 JSX，它的实现是（摘自前端产物源码）：

```js
static getDerivedStateFromProps(props, state) {
  if (state.prevCode === props.code && state.prevScope === props.scope) return null  // 按引用比较
  return { element: evalWithScope(props) }   // new Function(...scopeKeys, code)
}
```

`scope` 是**按引用**（`===`）比较的，而 Chainlit 每次渲染都传一个**新的对象字面量**
（`{ import, props, apiClient, updateElement, ... }`）。于是：

> 每来一条消息 → 消息列表重渲染 → 本组件重渲染 → `scope` 引用变了 → react-live 重新 `new Function` 求值
> → 得到一个**全新的组件函数** → React 认为类型变了 → 整棵子树卸载重建 → `<iframe>` 被销毁重建
> → Live2D 重新加载 → **每轮对话闪一次**

所以 iframe、注入的样式、事件监听全部做成挂在 `window.__live2dAvatar` 上的**单例**，
由原生 DOM 管理、不归 React 管；组件只负责把 props 推给单例，并在卸载后**延迟 2.5 秒**才拆除
（期间重新挂载就取消）。这样 React 怎么重建，形象都完全不受影响。

⚠️ **一个只靠定时器挡不住的坑（已修）**：现在每条带 `speech` 的消息都会再挂一个本组件实例，
而单例是它们**共用**的。只要任意一个实例的重新挂载晚于 2.5 秒（实测触发场景：打开/关闭设置面板），
它排下的拆除定时器就会在「组件其实还挂在页面上」的时候到期，把盒子和注入的样式一起删掉；
而剩下的实例因为依赖项没变、不会重跑 effect，形象就再也回不来了。
因此 `destroy()` 到期后会用 `.live2d-avatar-marker` 再做一次最终裁决：**只要页面上还有标记节点就不拆**。
另外 `ensureSingleton()` 也会检查盒子是否还在 DOM 里，不在就重建，避免“状态在、形象不在”的半死状态。

### 尺寸/位置怎么调

- **列表宽 / 形象高度**：改 `app.py` 里 props 的 `rail`（默认 220，左侧留给形象的列宽）和 `height`（默认 340）。
  元素会把它们写进 `:root` 的 `--live2d-rail` / `--live2d-height`。
  窗口窄（≤900px）时列宽降到 170px、高（≤560px）时高度降到 260px。
- **形象在这一列里怎么摆**：改 `viewer/index.html` 里 canvas 上的 `data-align` / `data-offset-x` / `data-anchor-y`（默认靠左、贴底）。
- **渲染帧率**：默认上限 **60fps**（`viewer.js` 里可改）。有些显示器是 120/144Hz，不限制的话 Live2D 会跟着跑满，
  而它每帧都要重算变形/物理并重绘 4096×2048 的贴图，白烧 GPU/CPU；如果遇到「发消息时画面顿一下」这类抢资源的现象，
  可以从 Python 侧把 props 的 `fps` 调到 30，或在 URL 上加 `?fps=30`。

### 改完前端的文件后要硬刷新（很容易踩）

Chainlit 的 `/public/**` 路由**不带 `Cache-Control`**，浏览器会按启发式规则自己缓存，
所以改完 `Live2DAvatar.jsx` / `viewer.js` / `viewer/index.html` 之后**必须硬刷新（Ctrl+Shift+R）**，
否则页面还在跑旧代码，很容易得出「改了没效果」的错误结论。

### 换模型时的自动适配 & 要留意的地方

`viewer.js` 会自动处理这些差异，实测过两种完全不同的模型（congyu / Amiya）：

| 差异 | 是否自动处理 |
|---|---|
| moc3 版本 v1–v5（Cubism 3.0–5.x） | ✅ 靠 Cubism Core 向下兼容（Amiya 是 v2/Cubism 3.3，能读） |
| 画布尺寸 / 宽高比不同 | ✅ 按模型自身画布尺寸自适应，不用手调 |
| 中文 / 含空格的文件名 | ✅ URL 会编码（含空格的 `motion-cloth off.motion3.json` 正常） |
| 标准 `Groups` 里的 EyeBlink | ✅ 模型声明了就原生启用；没声明时 viewer 会兜底补上 |
| 贴图张数/尺寸不同 | ✅（但 8192×4096 这种大贴图很吃显存：约 134MB） |

**待机动作（唯一需要留意的）**：按「指定的组名 → 忽略大小写匹配 idle/待机/standby → 唯一非空组」
的顺序找一个组来循环；都不满足就**只保留呼吸 / 眨眼 / 物理 / 鼠标追踪**（不报错，控制台一行 info）。
比如 Amiya 只有一个名字为空 `""` 的组，里面 5 个都是特效动作（鼓掌 / 键盘 / 音乐 / 武器 / cloth off），
不适合当待机循环，所以它不会自动播动作。要指定就用 Python 侧 props 的 `"idle"`，关掉用 `"idle": "none"`。

**画布留白**：有的模型画布留白很大（角色显得小，Amiya 就是这样，角色只占画布宽约 55%），
可以用 props 的 `"scale"` 放大，再用 `"offsetX"`（可负）把角色挪回那一列中间，
例如 Amiya 可以试 `"scale": 1.8, "offsetX": -0.5`。

**大贴图的帧率代价**：同一环境下 cong yu（4096×2048）能跑满 60fps，
Amiya（8192×4096）约 48fps。在意的话可以把贴图缩到 4096×2048 另存一份，再改 model3.json 指向它。

### 鼠标追踪（全局）

元素本身在页面里（不在 iframe 内），所以做法是：**在页面层监听 `mousemove`**，把坐标换算成 iframe 画布坐标后
`postMessage` 给 viewer，由它调 `model.focus(x, y)`。光标在**对话文字、输入框、页头**等任何位置，形象都会看向光标。

两种来源不会打架：

- 光标在形象区域内时，浏览器的 `mousemove` 进的是 iframe，父页面收不到 → 由 viewer 里 PIXI 自己的交互处理
- 光标在形象区域外时，父页面收到事件 → 由元素转发进去

## 语音朗读（TTS）+ 口型同步

音频由 Python 侧的 **edge-tts** 合成（`core/tts.py`），以 **Chainlit 的 audio 元素**发进对话，
同时把「朗读这段音频」的指令通过 Live2D 元素的 props 下发给形象。

### 数据怎么走到浏览器

| 步骤 | 说明 |
|---|---|
| 1 | `app.py` 调 `synthesize(text)`（内部先做**朗读文本清洗**）拿到 MP3 字节与精确时长 |
| 2 | 用 `session.persist_file()` 存进会话文件目录，拼出 URL `/project/file/<id>?session_id=<sid>`（与 Chainlit 前端 `getElementUrl` 一致，**同源**） |
| 3 | URL + `seq` + `ts` 放进 Live2D 元素 props 的 `speech` 字段下发 |
| 4 | JSX 转发给 iframe；iframe `fetch` 该 URL → 解码 → 播放 |
| 5 | 播完后（`duration` + 0.4s）再发一个 `cl.Audio(url=...)` 元素，即对话里的**回放播放器**；同时撤掉「语音朗读中 / 停止」那条消息 |

几个容易踩的点：

- **不要用「先发音频元素、再读 `element.chainlit_key`」拿 URL**：那样回放按钮会立刻出现，
  用户在朗读期间点回放就会听到**两路声音叠在一起**。所以改成直接 `persist_file()` 拿 URL，
  回放元素用 `duration`（由 edge-tts 的 `SentenceBoundary` 时间戳算得）延后发出。
- **回放元素必须用 `url=` 而不是 `content=`**，否则会再存一份音频。
- **`auto_play` 必须保持 `False`**：Chainlit 自带播放器如果自动播，会和 iframe 里的播放叠成双重声音。
- **「语音朗读中」那条消息要记得撤掉**：它只是为了挂「停止」按钮。播完还留着的话，
  用户会以为还在朗读。`app.py` 的 `_drop_stop_message()` 在「播完」和「用户点停止」两条路径上都会撤掉它
  （`Message.remove()`）。
- **延后发送用 `asyncio.create_task` 时必须保留任务的强引用**：asyncio 只对 Task 持**弱引用**，
  不自己存一份的话任务可能在中途被 GC 回收（表现：代码看着完全正确，但什么也没发生，
  而且不会报错）。`app.py` 用 `_spawn()` 把任务加进一个集合、完成时移除。

### 朗读文本要先清洗

LLM 的回复是 Markdown，里面常混着 emoji、颜文字、代码块、链接。不清洗的话 TTS 会
**把这些符号念出来**（emoji 被念成“笑脸”、代码块被逐字符念、`**` 被念成“星号星号”）。
`core/tts.py` 的 `sanitize_for_speech()` 分两步处理：

1. 结构化内容先摘掉（代码块 / 图片 / 链接 / 裸 URL）；
2. 再做一次**白名单过滤**：只保留“能被读出来”的字符（CJK、假名、谚文、拉丁字母、数字、
   少量标点、空白），其余全删。

白名单比黑名单可靠得多 —— 不用逐个列举 emoji 和颜文字符号。`speech.text`（调试字段）
里放的就是**清洗后**的文本，排查“念了奇怪东西”时直接看它。

### 口型怎么驱动

两个模型都**没有可用的标准 LipSync 组**（Amiya 的 `Groups` 里 `LipSync.Ids` 是空的，congyu 干脆没有 `Groups`），
所以不能指望 pixi 自动对口型（库的 cubism4 构建里根本没有独立的口型对象，只能靠动作内嵌的
`LipSync` 曲线，而两个模型的动作里都没有），`viewer.js` 里是手动写 `ParamMouthOpenY`：

1. 解码音频为 `AudioBuffer`；
2. **一次性预计算**整段的振幅包络（60Hz 的 RMS 数组）—— 不用实时 AnalyserNode，
   之后纯按 `AudioContext.currentTime` 查表，即使 rAF 抖动/掉帧也不会和音频跑偏；
3. 加静音门限 + 张嘴快/闭嘴慢的平滑，再写入参数。

#### ⚠️ 写入时机（这里踩过一个大坑）

必须把嘴型写在 `coreModel.update()` **之前**，而不是在 `internalModel.update()` 之后
补一次 `coreModel.update()`。`Cubism4InternalModel.update()` 的真实顺序是（实测源码）：

```text
动作 → saveParameters()（记住"动作后"的基线）
     → 表情 → 眨眼 → 焦点 → 呼吸/物理/自然动作 → pose
     → coreModel.update()（用当前参数算变形）
     → coreModel.loadParameters()（把参数还原成那条基线）
```

所以 `update()` 返回时，表情/眨眼/焦点/呼吸/物理/pose **已经全部被抹掉了** ——
那时候再写嘴型 + 补一次 `core.update()`，等于拿裸基线重画一帧，
表现就是「一开口说话，身体就僵成默认姿势」。

现在的做法是包装 `coreModel.update`，在调用原始实现**之前**写参数：
既不用多加一次 pass（实测每帧仍只有一次），也不影响其他任何动态；
**不说话时不写参数**，把嘴型还给动作/物理自己管。

### 刷新页面不会“自己说话”

Chainlit 会重放全部历史消息，历史元素里的 `speech` 会被当成“刚下达的朗读指令”。
JSX 里用两道护栏挡掉（`isLiveSpeech()`）：

- 页面加载后的 `REPLAY_WINDOW`（2s）内收到的一律视为历史重放；
- `speech.ts` 超过 `SPEECH_MAX_AGE`（5s）也视为过期。

归一化时把过期的 `speech` 摘掉，好处是重放时所有历史元素算出的 `configKey` 完全一致，
配合原有的 `configKey` 比较，天然只会下发一次。iframe 侧还会按 `speech.seq` 去重，
所以 JSX 在 iframe `ready` 时补发一次配置也不会重复播放。

### 开关

走 Chainlit 原生设置面板（`cl.ChatSettings` + `Switch(id="voice_enabled")`），
在 `app.py` 的 `on_settings_update` 里写进 `cl.user_session`。关闭时**根本不调 TTS**（省算力）。

> 注意区分：这里的开关是**朗读（TTS）**；**录音（STT）** 的开关在 `.chainlit/config.toml`
> 的 `[features.audio]`，两者互不相干。

### 中途停止朗读

朗读开始后会显示「停止 / Stop」按钮。点击后会停止 Live2D 的当前播放，
并立即显示已经生成的 MP3 回放元素；不会重新调用 TTS，也不会重复生成音频。

## 查看器支持的 URL 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `model` | `models/congyu/Murasame.model3.json` | 指向 model3.json |
| `scale` | `1` | 在自动适配基础上的额外缩放倍率 |
| `align` | `left` | 水平对齐：`left` / `center` / `right` |
| `offsetX` | `0.04` | 额外水平偏移，按容器宽度的比例算，可正可负 |
| `anchorY` | `bottom` | 垂直对齐：`bottom`（人物贴底）/ `center` |
| `idle` | `Idle` | 待机动作组名（对应 model3.json 里 Motions 的 key）；`none` 关闭 |
| `eyeblink` | `ParamEyeLOpen,ParamEyeROpen` | 自动眨眼参数，仅当模型缺少标准 `Groups` 声明时才用到 |

例：`/public/live2d/viewer/index.html?model=/public/live2d/models/xxx/xxx.model3.json&scale=1.2`

## 模型摆放位置在哪里调

**改 `viewer/index.html` 里 canvas 上的 `data-*` 就行**（默认值写在那里，不用动 JS）：

| 属性 | 默认值 | 说明 |
|---|---|---|
| `data-align` | `left` | 水平对齐，默认靠左，把右侧空间让出来 |
| `data-offset-x` | `0.04` | 水平微调（容器宽度比例） |
| `data-anchor-y` | `bottom` | 贴底站 / 居中 |
| `data-scale` | `1` | 自动适配基础上的缩放倍率 |

注意：canvas 是铺满整个 iframe 的，这里调的是「模型在画布里的位置」。
缩放/居中都不是写死像素，而是按模型自身画布尺寸算出来的，所以换模型不用重调。

上面这些参数都可以被 URL 参数覆盖（`Live2DAvatar.jsx` 会把 props 里显式给了的 `align` / `offsetX` / `anchorY` / `scale` 拼进 URL）。

## 已知的格式差异（踩过的坑）

- 本模型（以及很多第三方导出的模型）用 `Controllers` / `PhysicsV2` / `Options.ScaleFactor` 这类**非标准字段**，
  标准运行时（pixi-live2d-display）会全部忽略，表现为：
  - **不自动眨眼** —— 因为没有标准 `Groups: [{Name:"EyeBlink", Ids:[...]}]`；
    `viewer.js` 里的 `normalizeModel()` 会检测并补上（已声明过的模型不动它）。
  - `Options.ScaleFactor = 0.7` 不生效 —— 我们用"自适应容器"代替，不依赖这个值。
- **待机动作不会自动起播**：pixi 只在"上一个动作播完之后"才回到 Idle，
  刚加载完时并没有任何动作在播，所以 `playIdle()` 会显式起一次。
- 本模型 12 个动作的 `Meta.Loop` 全是 `true`（包括点击动作），以后要播一次性动作记得覆盖 `loop`。

## 本阶段实现范围

已完成：**渲染**、**基础动态**（Idle 动作循环 + 自动眨眼 + 呼吸 + 物理）、**鼠标追踪**、
**语音朗读**（edge-tts 合成 + 音频元素回放 + 振幅驱动口型 + 设置面板开关）。
点击热区互动、表情联动、与 LLM 的情绪对接还没做
（viewer 的 `window.avatar` 上已暴露 `playMotion()` / `setExpression()` 方便后续直接用）。

### 后续可做的（按性价比排序）

1. **边写边说**：现在要等整段回复结束才合成一句（长回复会等较久）。
   改成按句末标点 + 长度上限切句，用 `asyncio.Queue` 解耦，就能做到“边生成边说”。
2. **打断（barge-in）**：用户发新消息时立刻停掉正在播的语音。
3. **更精细的口型**：`edge-tts` 可返回 `WordBoundary` 时间戳，可用来驱动 `ParamMouthForm`（元音口型）。

## 另外两个需要注意的点

- `Live2DAvatar.jsx` 里给对话区留位用的是**结构化选择器**（`#root > div > div > div > div:not(#header)`）。
  Chainlit 升级如果改了 DOM 层级，这一条会失效（表现：左侧不再让位、形象盖在对话上）。
  到时候用浏览器检查器确认新的层级，改这一行即可。
- 当前项目没有会话历史侧边栏（DOM 里没有 sidebar 元素），所以不存在冲突。
  如果以后开了侧边栏，它和形象都在左侧，可能需要再加一条 `body:has(...)` 规则把形象隐藏或右移。

## 版权提示

`models/` 下的模型与语音素材来自第三方作品，仅供本地测试/课程演示，请勿公开分发。
