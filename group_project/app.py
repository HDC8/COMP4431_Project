import asyncio
import logging
import time

import chainlit as cl
from chainlit.input_widget import Select, Switch

from core.llm import stream_response
from core.stt import transcribe
from core.tts import synthesize

logger = logging.getLogger(__name__)

# ------------------------- Live2D 形象 starts -------------------------
# 模型地址（Chainlit 只服务 public/ 目录，所以模型必须放在 public/live2d/models/ 下）
# 当前用的是 Amiya（阿米娅）；想切回丛雨就把下面这行换成：
#   "/public/live2d/models/congyu/Murasame.model3.json"
# 注：模型文件已全部改成 ASCII 名（阿米娅.* → Amiya.*），文件夹内已无中文文件名
LIVE2D_MODEL_URL = "/public/live2d/models/Amiya/Amiya.model3.json"

# 形象渲染方式：元素版（唯一启用的方式）
#   - 实现：public/elements/Live2DAvatar.jsx（位置固定，Chainlit 会按名字去拉这个文件）
#   - 形象固定在窗口左侧，并自动给对话区留出一列（互不侵占），细节见该 jsx 里的注释
#   - .chainlit/config.toml 里的 custom_css / custom_js 已停用，不需要再开
SEND_LIVE2D_AS_ELEMENT = True

# 语音朗读（TTS）的默认开关状态。运行期用户可以在 Chainlit 的设置面板里改，
# 改动只影响当前会话。
VOICE_DEFAULT_ENABLED = True

AUDIO_SAMPLE_RATE = 24000
LANGUAGE_SESSION_KEY = "language"


def _make_avatar(speech: dict | None = None) -> cl.CustomElement:
    """
    构造 Live2D 元素。

    speech 为空 = 会话开始时的初始挂载；
    speech 非空 = 「立刻朗读这段音频」，协议见 public/live2d/README.md。
    """
    props = {
        "model": LIVE2D_MODEL_URL,
        "rail": 220,    # 左侧留给形象的列宽(px)，对话内容会让出这么多
        "height": 340,  # 形象高度上限(px)
        # 形象在那一列里怎么摆由 viewer/index.html 的 data-* 控制（默认靠左、贴底）：
        # "align": "left" | "center" | "right"、"offsetX": 0.04、"anchorY": "bottom"、"scale": 1.0、"fps": 60
        # 待机动作组名也可以指定（默认自动找 Idle/待机）：“idle”: "none" 表示不起播动作。
        # Amiya 只有一个名字为空的动作组、且 5 个动作都是特效类（鼓掌/键盘/音乐/武器…），
        # 不适合当作待机循环，所以交给 viewer 的自动退让逻辑处理（它会跳过并只保留呼吸/眨眼/追踪）。
    }
    if speech:
        props["speech"] = speech
    return cl.CustomElement(name="Live2DAvatar", props=props)


async def _send_avatar(speech: dict | None = None) -> None:
    """发一条承载 Live2D 元素的消息（内容为空，UI 上不占位）。"""
    avatar = _make_avatar(speech)

    # Chainlit 发元素时会把内容持久化到 .files/<session_id>，而它的 mkdir 不带 parents=True，
    # 且服务退出时会把整个 .files 删掉 —— 只要 .files 在运行期不见了，这里就会抛
    # FileNotFoundError，形象直接渲染不出来（而且很难看出原因）。所以补一层兜底。
    try:
        await cl.Message(content="", elements=[avatar]).send()
    except FileNotFoundError:
        from pathlib import Path

        Path(".files").mkdir(parents=True, exist_ok=True)
        await cl.Message(content="", elements=[avatar]).send()


@cl.on_chat_start
async def on_chat_start():
    """会话开始：发送设置面板 + 渲染 Live2D 形象。"""
    cl.user_session.set("voice_enabled", VOICE_DEFAULT_ENABLED)
    cl.user_session.set(LANGUAGE_SESSION_KEY, "zh")

    # 语音开关走 Chainlit 原生设置面板（输入框旁），不需要自己写 UI。
    # 注意：这是「朗读（TTS）」的开关；「录音（STT）」的开关在
    # .chainlit/config.toml 的 [features.audio]，两者互不相干。
    await cl.ChatSettings(
        [
            Switch(
                id="voice_enabled",
                label="语音朗读 / Voice playback",
                initial=VOICE_DEFAULT_ENABLED,
                description="助手回复会自动朗读，Live2D 形象同步做口型 / Read replies aloud with Live2D lip sync",
            ),
            Select(
                id=LANGUAGE_SESSION_KEY,
                label="语音识别语言 / Voice language",
                items={"中文": "zh", "English": "en"},
                initial_value="zh",
            )
        ]
    ).send()

    if SEND_LIVE2D_AS_ELEMENT:
        await _send_avatar()


@cl.on_settings_update
async def on_settings_update(settings: dict):
    """用户在设置面板里改动开关时触发。"""
    enabled = bool(settings.get("voice_enabled", VOICE_DEFAULT_ENABLED))
    cl.user_session.set("voice_enabled", enabled)
    language = settings.get(LANGUAGE_SESSION_KEY, "zh")
    if language in {"zh", "en"}:
        cl.user_session.set(LANGUAGE_SESSION_KEY, language)
    logger.info("语音朗读已%s", "开启" if enabled else "关闭")


# -------------------------- Live2D 形象 ends --------------------------


# ------------------------- 助手回复 + 语音朗读 starts -------------------------


# 语音播完后再多等一会儿才放出回放按钮(秒)，留出播放器启动误差
REPLAY_EXTRA_DELAY = 0.4

# 后台任务的强引用集合。
# asyncio 只对 Task 持**弱引用**，不自己保存一份的话任务可能在中途被 GC 回收
# （Python 官方文档明确要求保存返回值），表现就是“代码看着对，但啥也没发生”。
_pending_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    """把协程丢到后台跑，并保留强引用直到它结束。"""
    task = asyncio.create_task(coro)
    _pending_tasks.add(task)
    task.add_done_callback(_pending_tasks.discard)
    return task


def _next_speech_seq() -> int:
    """会话内自增序号，浏览器侧用它去重（同一段语音不会被播两次）。"""
    seq = (cl.user_session.get("speech_seq") or 0) + 1
    cl.user_session.set("speech_seq", seq)
    return seq


async def _persist_speech(audio: bytes) -> str:
    """
    把音频存进 Chainlit 的会话文件目录，返回浏览器可访问的 URL。

    这里直接调 `session.persist_file()`，而不是先发一个 `cl.Audio` 元素：
    因为回放按钮是**等语音播完才出现**的（见下面），但形象必须立刻拿到 URL
    才能开口。URL 的拼法与 Chainlit 前端一致（同源，iframe 里可直接 fetch）：
        /project/file/<file_id>?session_id=<sid>
    """
    session = cl.context.session
    session_id = session.id

    async def _store() -> str:
        # persist_file 内部会 mkdir（不带 parents=True），所以 .files 不在时会
        # 抛 FileNotFoundError —— 见 _send_avatar 里对这个坑的说明。
        ref = await session.persist_file(
            name="reply.mp3", content=audio, mime="audio/mpeg"
        )
        return f"/project/file/{ref['id']}?session_id={session_id}"

    try:
        return await _store()
    except FileNotFoundError:
        from pathlib import Path

        Path(".files").mkdir(parents=True, exist_ok=True)
        return await _store()


async def _send_replay(url: str) -> None:
    """把可回放的播放器发进对话（指向已持久化的同一个音频文件，不会重复存储）。"""
    element = cl.Audio(
        name="reply.mp3",
        url=url,
        mime="audio/mpeg",
        display="inline",
        auto_play=False,
    )
    await cl.Message(content="", elements=[element]).send()


async def _send_stop_action(url: str) -> cl.Message:
    """在朗读期间显示按钮，允许用户停止播放并立即显示 MP3。

    返回这条消息本身：朗读结束后要把它整条撤掉（连同「停止」按钮），
    否则「语音朗读中」会一直挂在对话里，看着像还没播完。
    """
    action = cl.Action(
        name="stop_speech",
        label="停止 / Stop",
        tooltip="停止朗读并显示 MP3 / Stop playback and show the MP3",
        icon="stop-circle",
        payload={"url": url},
    )
    message = cl.Message(
        content="语音朗读中 / Voice playback in progress", actions=[action]
    )
    await message.send()
    return message


async def _drop_stop_message(message: cl.Message | None = None) -> None:
    """撤掉「语音朗读中」那条消息（已经播完 / 用户点了停止）。"""
    if message is None:
        message = cl.user_session.get("stop_message")
    cl.user_session.set("stop_message", None)
    if message is None:
        return
    try:
        await message.remove()
    except Exception as exc:
        # 消息可能已经被前端清掉（刷新页面、会话结束），不值得打断流程
        logger.debug("撤掉朗读提示失败：%s", exc)


async def _send_replay_later(
    url: str, duration: float, stop_message: cl.Message | None = None
) -> None:
    """
    等语音播完再放出回放按钮。

    之前是立刻发的，结果朗读期间用户点回放会听到两路声音叠在一起。
    `duration` 由 core/tts.py 从 edge-tts 的 SentenceBoundary 时间戳算得，是精确值。

    用 create_task 而不是直接 await：否则当前消息处理协程会被睡眠堵住，
    用户在语音播放期间发的下一条消息要等很久才被处理。
    """
    try:
        await asyncio.sleep(max(0.0, duration) + REPLAY_EXTRA_DELAY)
        await _send_replay(url)
        await _drop_stop_message(stop_message)
        cl.user_session.set("replay_ready_url", url)
    except Exception as exc:
        logger.warning("发送回放元素失败：%s", exc)


@cl.action_callback("stop_speech")
async def stop_speech(action: cl.Action):
    """停止当前 Live2D 语音，并立即显示已经生成的 MP3。"""
    payload = action.payload or {}
    url = payload.get("url")
    if not url:
        return

    if cl.user_session.get("replay_ready_url") == url:
        await _drop_stop_message()
        return

    replay_task = cl.user_session.get("replay_task")
    if replay_task:
        replay_task.cancel()
        cl.user_session.set("replay_task", None)

    await _send_avatar(
        {
            "stop": True,
            "seq": _next_speech_seq(),
            "ts": int(time.time() * 1000),
        }
    )
    await _send_replay(url)
    await _drop_stop_message()


async def reply_with_voice(user_text: str) -> None:
    """
    流式输出 LLM 回复；如果语音开关是打开的，再合成语音并让形象开口。

    阶段 1 的做法是「等整段回复结束再合成一句」：实现简单、口径清晰；
    代价是长回复要等到最后才出声。后续可以按句切分做到「边写边说」。
    """
    reply = cl.Message(content="")
    parts: list[str] = []

    async for token in stream_response(user_text):
        parts.append(token)
        await reply.stream_token(token)

    await reply.send()

    if not cl.user_session.get("voice_enabled", VOICE_DEFAULT_ENABLED):
        return

    text = "".join(parts).strip()
    if not text:
        return

    try:
        # 内部会先做朗读文本清洗（去掉 emoji / Markdown / 代码块 / 链接），
        # 否则 TTS 会把它们念出来。
        speech = await synthesize(text)
    except Exception as exc:
        # TTS 失败绝不能影响文字回复，记一条日志就够了。
        logger.warning("TTS 合成失败，本轮跳过语音：%s", exc)
        return

    if not speech.data:
        return

    try:
        url = await _persist_speech(speech.data)
    except Exception as exc:
        logger.warning("音频保存失败，本轮跳过语音：%s", exc)
        return

    if not SEND_LIVE2D_AS_ELEMENT:
        # 没有形象在播，直接给回放按钮
        await _send_replay(url)
        return

    # 1) 先让形象开口：把「朗读这段音频」的指令下发给它（走 Live2D 元素的 props）。
    await _send_avatar(
        {
            "url": url,
            "seq": _next_speech_seq(),
            "ts": int(time.time() * 1000),
            # 这里放**清洗后**的文本，便于排查“念了奇怪东西”
            "text": speech.spoken[:200],
        }
    )

    # 2) 等说完再把回放按钮发出来，避免朗读期间点回放造成两路声音重叠。
    stop_message = await _send_stop_action(url)
    cl.user_session.set("stop_message", stop_message)
    cl.user_session.set("replay_ready_url", None)
    replay_task = _spawn(_send_replay_later(url, speech.duration, stop_message))
    cl.user_session.set("replay_task", replay_task)


# -------------------------- 助手回复 + 语音朗读 ends --------------------------


@cl.on_message
async def on_message(message: cl.Message):
    # Create an empty message and stream tokens into it.
    await reply_with_voice(message.content)

#--------------------------- speech to text part starts---------------------------

# Temporary buffer to collect audio chunks per session.
# Key: session_id, Value: list of raw audio bytes.
audio_buffer: dict[str, list[bytes]] = {}


# ---------- Audio lifecycle hooks ----------
@cl.on_audio_start
async def on_audio_start():
    """Called when the user starts recording. Initialize an empty buffer."""
    session_id = cl.context.session.id
    audio_buffer[session_id] = []
    return True


@cl.on_audio_chunk
async def on_audio_chunk(chunk: cl.InputAudioChunk):
    """Called for each audio chunk while the user is recording."""
    session_id = cl.context.session.id
    if session_id not in audio_buffer:
        audio_buffer[session_id] = []
    audio_buffer[session_id].append(chunk.data)


@cl.on_audio_end
async def on_audio_end():
    """录音结束后调用腾讯云 ASR，再把识别结果交给 LLM。"""
    session_id = cl.context.session.id
    chunks = audio_buffer.pop(session_id, [])

    if not chunks:
        return

    # 1. Concatenate all chunks into one audio buffer.
    full_audio = b"".join(chunks)

    # 2. 在线程中调用腾讯云 ASR，避免阻塞 Chainlit 事件循环。
    language = cl.user_session.get(LANGUAGE_SESSION_KEY, "zh")
    if language not in {"zh", "en"}:
        language = "zh"

    try:
        user_text = await asyncio.to_thread(
            transcribe,
            full_audio,
            language=language,
            original_sample_rate=AUDIO_SAMPLE_RATE,
        )
    except Exception:
        await cl.Message(
            content="语音识别失败，请检查腾讯云密钥、网络连接和账户权限。 / "
            "Speech recognition failed. Check your Tencent Cloud credentials, "
            "network connection, and account permissions."
        ).send()
        return

    if not user_text:
        await cl.Message(
            content="无法识别语音，请重试。 / Could not recognize speech. Please try again."
        ).send()
        return

    # 3. Echo the recognized text back to the user.
    await cl.Message(content=user_text, type="user_message").send()

    # 4. Pass the transcribed text to your LLM and stream the reply
    #    (and speak it aloud when the voice switch is on).
    await reply_with_voice(user_text)

#--------------------------- speech to text part ends---------------------------