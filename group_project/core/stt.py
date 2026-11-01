import base64
import os

import numpy as np
from dotenv import load_dotenv
from scipy.signal import resample_poly
from tencentcloud.asr.v20190614 import asr_client, models
from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import (
    TencentCloudSDKException,
)

load_dotenv()

SECRET_ID = os.getenv("TENCENT_SECRET_ID") or os.getenv("TENCENTCLOUD_SECRET_ID")
SECRET_KEY = os.getenv("TENCENT_SECRET_KEY") or os.getenv("TENCENTCLOUD_SECRET_KEY")
REGION = "ap-hongkong"
_client = None


def _get_client():
    global _client

    if _client is None:
        if not SECRET_ID or not SECRET_KEY:
            raise RuntimeError(
                "Tencent Cloud credentials are missing. Set "
                "TENCENT_SECRET_ID and TENCENT_SECRET_KEY in .env."
            )
        _client = asr_client.AsrClient(
            credential.Credential(SECRET_ID, SECRET_KEY), REGION
        )

    return _client


def _resample_pcm16(pcm_bytes: bytes, orig_sr: int, target_sr: int = 16000) -> bytes:
    if orig_sr == target_sr:
        return pcm_bytes

    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    resampled = resample_poly(audio, target_sr, orig_sr)
    return np.clip(resampled, -32768, 32767).astype(np.int16).tobytes()


def transcribe(
    audio_bytes: bytes,
    language: str = "zh",
    vocab_id: str | None = None,
    original_sample_rate: int = 24000,
) -> str:
    """调用腾讯云一句话识别 API，将 Chainlit 的 PCM16 音频转成文本。"""
    pcm_16k = _resample_pcm16(audio_bytes, original_sample_rate)

    req = models.SentenceRecognitionRequest()
    req.ProjectId = 0
    req.SubServiceType = 2
    req.SourceType = 1
    req.VoiceFormat = "pcm"
    req.UsrAudioKey = "chainlit_audio"
    req.Data = base64.b64encode(pcm_16k).decode("utf-8")
    req.DataLen = len(pcm_16k)
    req.EngSerViceType = "16k_en" if language == "en" else "16k_zh"

    if vocab_id:
        req.VocabId = vocab_id

    try:
        response = _get_client().SentenceRecognition(req)
        return response.Result or ""
    except TencentCloudSDKException:
        raise