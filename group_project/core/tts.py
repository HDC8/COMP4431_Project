"""
文本转语音（TTS）。

用 edge-tts（微软 Edge 的在线神经语音）而不是本地引擎，原因是：
  - 中英文音色质量都够好，且不需要 API key、不需要 GPU、不需要下载模型权重；
  - 直接以「MP3 字节流」的形式返回，不用落地临时文件；
  - 顺带带回每句的时间戳，能算出精确的音频时长（用来决定什么时候放出回放按钮）。
代价：运行期需要联网。

语音的选择依据是 **被朗读的文本本身**，而不是用户输入。因为 core/llm.py 的
system prompt 已经强制「回复语言 = 提问语言」，所以回复文本才是最可靠的信号。
"""

from __future__ import annotations

import re
from typing import NamedTuple

import edge_tts

# 每种语言使用的音色。完整列表：`edge-tts --list-voices`
VOICE_ZH = "zh-CN-XiaoxiaoNeural"
VOICE_EN = "en-US-AriaNeural"

# 语速 / 音量，edge-tts 的写法是相对值（"+0%"、"-10%"、"+20%"…）
TTS_RATE = "+0%"
TTS_VOLUME = "+0%"


class Speech(NamedTuple):
    """合成结果。

    data     音频字节（MP3）
    duration 音频的精确时长（秒）
    spoken   实际送去合成的文本（已清洗），排查“念了奇怪东西”时看它
    """

    data: bytes
    duration: float
    spoken: str

# ---------------------------------------------------------------------------
# 语言判定
#
# 这个项目只需要区分「中文」和「英文」，用「CJK 字符占比」这种廉价启发式就够了：
# 既能保证零依赖（不引 langdetect / pycld2），也不需要额外的网络往返。
# 中英混排时按多数决，符合直觉。
# ---------------------------------------------------------------------------
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_CJK_RATIO_THRESHOLD = 0.2


def detect_voice(text: str) -> str:
    """按文本里占主导的书写系统挑一个音色。"""
    letters = [ch for ch in text if not ch.isspace()]
    if not letters:
        return VOICE_ZH
    cjk = sum(1 for ch in letters if _CJK_RE.match(ch))
    return VOICE_ZH if cjk / len(letters) > _CJK_RATIO_THRESHOLD else VOICE_EN


# ---------------------------------------------------------------------------
# 朗读前的文本清洗
#
# LLM 的回复是 Markdown，里面常混着 emoji、颜文字、代码块、链接……
# 不清洗的话 TTS 会**把这些符号念出来**（emoji 被念成“笑脸”、代码块被逐字符念、
# `**` 被念成“星号星号”），非常出戏。
#
# 做法分两步：
#   1. 结构化内容先摘掉（代码块 / 图片 / 链接 / 裸 URL）；
#   2. 再做一次**白名单过滤**：只保留“能被读出来”的字符（CJK、假名、谚文、
#      拉丁字母、数字、少量标点、空白），其余全删。
# 白名单比黑名单可靠得多 —— 不用逐个列举 emoji 和颜文字符号。
# ---------------------------------------------------------------------------
_FENCED_CODE_RE = re.compile(r"```.*?```", re.S)
_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_BARE_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)

# 注意：字符类里的 ] 要转义，- 放最后当字面量
_SPEAKABLE_RE = re.compile(
    r"["
    r"\u3400-\u4dbf\u4e00-\u9fff"      # CJK 扩展 A + 基本区
    r"\u3040-\u30ff"                   # 平假名 / 片假名
    r"\uac00-\ud7af"                   # 谚文
    r"A-Za-z0-9\u00c0-\u024f"          # 拉丁字母（含带音标的）与数字
    r"，。、；：！？…—～·「」『』（）《》〈〉【】“”‘’"
    r",.;:!?()\[\]'\"\/%\-"
    r"]"
)


def sanitize_for_speech(text: str) -> str:
    """把 Markdown 回复清洗成“适合朗读”的纯文本。"""
    text = _FENCED_CODE_RE.sub(" ", text)      # 代码块整块丢掉
    text = _IMAGE_RE.sub(" ", text)            # 图片：alt 通常也没必要念
    text = _LINK_RE.sub(r"\1", text)           # 链接只保留可见文字
    text = _BARE_URL_RE.sub(" ", text)         # 裸 URL 不念
    text = _INLINE_CODE_RE.sub(r"\1", text)    # 行内代码去掉反引号，内容保留

    kept = "".join(ch for ch in text if ch.isspace() or _SPEAKABLE_RE.match(ch))
    return re.sub(r"\s+", " ", kept).strip()


async def synthesize(text: str, voice: str | None = None) -> Speech:
    """
    把 `text` 合成语音。

    返回 `Speech(data, duration, spoken)`；没有内容可念时返回 `Speech(b"", 0.0, "")`。
    网络/服务错误会直接抛出，由调用方决定怎么降级 —— 但调用方**必须保证
    文字回复不受 TTS 失败影响**。
    """
    spoken = sanitize_for_speech(text)
    if not spoken:
        return Speech(b"", 0.0, "")

    communicate = edge_tts.Communicate(
        spoken,
        voice or detect_voice(spoken),
        rate=TTS_RATE,
        volume=TTS_VOLUME,
    )

    chunks: list[bytes] = []
    duration_ticks = 0
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
        elif "offset" in chunk and "duration" in chunk:
            # SentenceBoundary 的时间戳单位是 100ns tick，取最后一句的结束时刻
            duration_ticks = max(duration_ticks, chunk["offset"] + chunk["duration"])

    return Speech(b"".join(chunks), duration_ticks / 1e7, spoken)
