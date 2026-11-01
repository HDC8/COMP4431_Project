# COMP4431 Group Project

一个本地运行的 Chainlit AI 助手：

- **打字** → 本地 Ollama 模型（默认 `qwen3:8b`）流式回答
- **说话** → 腾讯云一句话识别转成文字，再交给同一个模型
- **回答自动朗读**（edge-tts），左侧 Live2D 形象（Amiya）同步口型
- 设置面板里可以关掉朗读、切换识别语言（中文 / English）

---

## 一、先准备这些

| 需要 | 说明 |
|---|---|
| Python 3.11–3.13 | 3.14 不支持 Chainlit 2.x；安装时勾选 "Add Python to PATH" |
| [Ollama](https://ollama.com/download) | 装完保持运行（托盘图标），默认监听 `11434` 端口 |
| 腾讯云密钥 | 只有**语音输入**要用；控制台里需开通「一句话识别」 |
| 网络 | 朗读走微软在线语音、识别走腾讯云，两者都要联网 |

---

## 二、跑起来（4 步）

在项目根目录（有 `app.py` 的那一层）打开 PowerShell，按顺序执行。

### 第 1 步：建虚拟环境并装依赖

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

装完需要几分钟（首次会下载不少依赖）。之后所有命令都直接用 `.venv\Scripts\python.exe`，**不需要激活环境**。

### 第 2 步：下载模型

```powershell
ollama pull qwen3:8b
```

约 5 GB，只需要下一次。

### 第 3 步：配置腾讯云密钥（只想打字聊天可以跳过）

```powershell
Copy-Item .env.example .env
```

用记事本打开 `.env`，填成自己的密钥：

```dotenv
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=你的SecretKey
```

### 第 4 步：启动

```powershell
.\.venv\Scripts\python.exe -m chainlit run app.py -w
```

终端会打印地址，浏览器打开 **<http://localhost:8000>** 即可。

端口被占用就换一个：

```powershell
.\.venv\Scripts\python.exe -m chainlit run app.py -w --port 8080
```

---

## 三、怎么用

| 操作 | 做法 |
|---|---|
| 打字聊天 | 直接在输入框输入，回车发送 |
| 语音输入 | 点输入框左侧的麦克风按钮开始录音，再点一次结束（首次会请求麦克风权限） |
| 改设置 | 点输入框右侧的齿轮：`语音朗读 / Voice playback` 开关、`语音识别语言 / Voice language` |
| 停止朗读 | 朗读期间点对话里的 `停止 / Stop` |
| 回放 | 朗读结束后，对话里会自动出现 `reply.mp3` 播放器 |

识别语言要和实际说的语言一致，不做自动检测：

| 选择 | 腾讯云引擎 |
|---|---|
| 中文 | `16k_zh` |
| English | `16k_en` |

---

## 四、常见问题

### 麦克风按钮没出现

确认 `.chainlit/config.toml` 里有 `[features.audio] enabled = true`，改完要重启 Chainlit。

### 说话没反应 / 识别不出来

1. 浏览器地址栏的麦克风图标是否被禁止
2. `.env` 是否存在、密钥是否正确
3. 腾讯云控制台是否开通「一句话识别」、账号是否欠费
4. 设置里的识别语言是否和你说的话一致

### 有回复但不出声

1. 设置里的 `语音朗读 / Voice playback` 是否打开
2. 网络能否访问微软的语音服务（edge-tts 需要联网）
3. 浏览器拦截了自动播放：先点一下页面，再发下一条消息
4. 看后台日志有没有 `TTS 合成失败，本轮跳过语音`

### 左边没有 Live2D 形象

1. 形象只出现在**发过消息之后**（欢迎页不显示）
2. `public/live2d/vendor/` 和 `public/live2d/models/Amiya/` 是否齐全
3. 直接访问 <http://localhost:8000/public/live2d/models/Amiya/Amiya.model3.json> 能不能打开
4. 改过前端文件就按 `Ctrl+Shift+R` 硬刷新，浏览器控制台里看 `[live2d]` 开头的报错

### Ollama 连接失败

```powershell
ollama list
ollama pull qwen3:8b
```

确认 Ollama 正在运行（托盘图标）。

### 报 `No Python at '...'`

`.venv` 是在别的电脑上建的，路径失效。删掉重建：

```powershell
Remove-Item -Recurse -Force .venv
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

---

## 五、项目结构

```text
.
├── app.py                        # 入口：聊天、设置面板、朗读下发、录音回调
├── core/
│   ├── llm.py                    # Ollama 模型 + Prompt
│   ├── stt.py                    # 腾讯云一句话识别（24k → 16k 重采样）
│   └── tts.py                    # edge-tts 合成 + 朗读文本清洗
├── public/
│   ├── elements/Live2DAvatar.jsx # Live2D 自定义元素（Chainlit 按名字加载）
│   └── live2d/
│       ├── viewer/               # iframe 里的 Live2D 页面
│       ├── vendor/               # Cubism Core / PIXI 6 / pixi-live2d-display
│       ├── models/Amiya/         # 模型（另有 congyu/Murasame 可切换）
│       └── README.md             # Live2D 实现细节
├── .chainlit/config.toml         # Chainlit 配置（audio 已开启，sample_rate = 24000）
├── .env.example                  # 密钥模板
├── chainlit.md                   # 右上角「说明」页的内容
└── requirements.txt
```

---

## 六、想改点什么

| 想改 | 改哪里 |
|---|---|
| 换 LLM 模型 | `core/llm.py` 的 `OLLAMA_MODEL`（记得先 `ollama pull`） |
| 换音色 / 语速 | `core/tts.py` 顶部的 `VOICE_ZH`、`VOICE_EN`、`TTS_RATE`、`TTS_VOLUME` |
| 换 Live2D 模型 | 模型目录放进 `public/live2d/models/`，改 `app.py` 的 `LIVE2D_MODEL_URL` |
| 形象大小 / 左侧留白 | `app.py` 里 `_make_avatar()` 的 `rail`、`height` |
| 采样率 | `.chainlit/config.toml` 的 `sample_rate`、`app.py` 的 `AUDIO_SAMPLE_RATE` 要一致 |

Live2D 的口型驱动、鼠标追踪、iframe 通信等细节见 [public/live2d/README.md](public/live2d/README.md)。

`public/live2d/models/` 下的模型素材来自第三方作品，仅供课程演示，请勿公开分发。
