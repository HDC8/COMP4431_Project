/**
 * Live2D 查看器（最小实现）
 *
 * 只负责：
 *   1. 渲染模型（透明背景、尺寸跟随 iframe、高 DPI）
 *   2. 基础动态：Idle 动作循环 + 自动眨眼 + 呼吸 + 物理
 *   3. 鼠标追踪：鼠标在画布内移动时视线/头部跟随
 *   4. 语音朗读：播放父窗口下发的音频，并按音频振幅驱动口型
 *
 * 模型通过 URL 参数指定，换模型不用改这个文件：
 *   index.html?model=<model3.json 的 URL>&scale=1&idle=Idle&eyeblink=ParamEyeLOpen,ParamEyeROpen
 *   - idle=none 可以关掉待机动作
 *   - eyeblink 只需在模型缺少标准 Groups 声明时才用到
 *   - 模型摆放位置见 index.html 里的 data-align / data-offset-x / data-anchor-y
 *
 * 加载完成后会向父窗口发消息：
 *   { source: 'live2d-viewer', type: 'ready', model }
 *   { source: 'live2d-viewer', type: 'error', message }
 *
 * 父窗口可以回发：
 *   { source: 'chainlit', type: 'config', model?, scale?, align?, offsetX?, anchorY?, speech? }
 *   { source: 'chainlit', type: 'pointer', x, y }   // 鼠标坐标（画布左上角为原点），
 *                                                   // 供页面层做全局鼠标追踪用
 *
 * speech（语音朗读）的字段：
 *   { url, seq, ts?, text? }
 *   - url      音频地址（同源，如 /project/file/<key>?session_id=<sid>）
 *   - seq      会话内自增序号，用于去重（同一段语音不会播两次）
 *   - ts/text  仅用于调试
 */
(function () {
  "use strict";

  var DEFAULT_MODEL = "/public/live2d/models/congyu/Murasame.model3.json";

  var query = new URLSearchParams(window.location.search);
  var canvas = document.getElementById("live2d-canvas");
  var statusEl = document.getElementById("status");

  var app = null;
  var model = null;
  var currentModelUrl = "";

  function toNumber(value, fallback) {
    var n = parseFloat(value);
    return isNaN(n) ? fallback : n;
  }

  /**
   * 模型在画布里的摆放方式。
   * 默认值写在 index.html 的 data-* 上（方便不熟 JS 时直接改 HTML），
   * URL 参数优先级更高，便于 Python/JSX 侧动态覆盖。
   */
  var view = {
    align: query.get("align") || canvas.dataset.align || "center",
    offsetX: toNumber(query.get("offsetX"), toNumber(canvas.dataset.offsetX, 0)),
    anchorY: query.get("anchorY") || canvas.dataset.anchorY || "center",
  };

  var userScale = toNumber(query.get("scale"), toNumber(canvas.dataset.scale, 1)) || 1;

  // 待机动作组名（model3.json 里 Motions 的某个 key），none 表示不起播
  var idleGroup = query.has("idle") ? query.get("idle") : "Idle";

  // 自动眨眼用的参数（标准 Cubism 模型会在 Groups 里声明，这里作为兜底）
  var eyeBlinkIds = (query.get("eyeblink") || "ParamEyeLOpen,ParamEyeROpen")
    .split(",")
    .map(function (id) { return id.trim(); })
    .filter(Boolean);

  /** 向父窗口（Chainlit 里的 JSX 元素）发消息，独立打开时不发 */
  function post(type, payload) {
    if (window.parent === window) return;
    var message = Object.assign({ source: "live2d-viewer", type: type }, payload || {});
    window.parent.postMessage(message, "*");
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    if (!text) {
      statusEl.classList.add("hidden");
      return;
    }
    statusEl.classList.remove("hidden");
    statusEl.classList.toggle("error", !!isError);
    statusEl.textContent = text;
  }

  /**
   * 让模型自适应容器：等比缩放到刚好装下，再按 view 配置摆放。
   * 用 internalModel.width/height（模型原始画布尺寸）计算，因此换任何尺寸的模型都能装下，
   * 不需要为每个模型手调 scale。
   *
   * 关键：先把缩放比例算出来（s），再用 s 反推模型在容器里的实际宽高（w/h），
   * 这样才能准确地做左/右对齐和贴底，而不是靠猜固定像素。
   */
  function layout() {
    if (!app || !model) return;
    var cw = app.screen.width;
    var ch = app.screen.height;
    var mw = model.internalModel.width;
    var mh = model.internalModel.height;
    if (!mw || !mh || !cw || !ch) return;

    var s = Math.min(cw / mw, ch / mh) * userScale;
    model.scale.set(s);

    var w = mw * s;
    var h = mh * s;
    var dx = view.offsetX * cw;

    // anchor 是 (0.5, 0.5)，所以 x/y 传的是模型中心点
    if (view.align === "left") {
      model.x = w / 2 + dx;
    } else if (view.align === "right") {
      model.x = cw - w / 2 - dx;
    } else {
      model.x = cw / 2 + dx;
    }

    model.y = view.anchorY === "bottom" ? ch - h / 2 : ch / 2;
  }

  async function loadModel(url) {
    // 换模型前先把正在播的语音和口型停掉，否则旧的钩子会留在已销毁的模型上
    stopSpeaking();

    if (model) {
      app.stage.removeChild(model);
      model.destroy();
      model = null;
    }

    currentModelUrl = url;
    setStatus("Live2D 加载中…");

    // autoUpdate：自动跑 Idle 动作、眨眼、呼吸、物理
    // autoInteract：鼠标进入画布即可追踪视线；点击命中热区（本阶段不用点击效果）
    model = await PIXI.live2d.Live2DModel.from(url, {
      autoUpdate: true,
      autoInteract: true,
      idleMotionGroup: "Idle",
    });

    model.anchor.set(0.5, 0.5);
    app.stage.addChild(model);

    normalizeModel(model);
    installMouthHook();
    layout();
    await playIdle();

    // 方便在浏览器控制台里手动试验：avatar.model.expression(...) / avatar.model.motion(...)
    window.avatar = {
      app: app,
      model: model,
      playMotion: function (group, index) {
        return model.motion(group, index);
      },
      setExpression: function (name) {
        return model.expression(name);
      },
    };

    setStatus("");
    post("ready", { model: url });
  }

  /**
   * 补齐模型可能缺失的标准配置。
   *
   * 标准 Cubism 模型会在 model3.json 的 Groups 里声明 EyeBlink / LipSync，
   * 但很多第三方导出的模型（比如本模型）用的是自己的扩展字段，
   * 运行时读不到就会静默地不眨眼 —— 这里手动补一个。
   * 已经声明过的模型不做任何改动。
   */
  function normalizeModel(target) {
    var internal = target.internalModel;
    if (!internal.eyeBlink && eyeBlinkIds.length && PIXI.live2d.CubismEyeBlink) {
      internal.eyeBlink = new PIXI.live2d.CubismEyeBlink({
        getEyeBlinkParameters: function () {
          return eyeBlinkIds;
        },
      });
    }
  }

  /**
   * 起播待机动作。
   *
   * 注意：不是所有模型都有叫 "Idle" 的组。第三方面向 VTube Studio / ViewerEX 的模型
   * 常见情况是组名空字符串，或只有几个一次性动作。所以这里做多级退让：
   *   指定的组名 → 忽略大小写匹配 idle/待机/standby 的组 → 只有唯一一个非空组时用它
   * 都找不到就安静地不起播：呼吸 / 眨眼 / 物理 / 鼠标追踪都是运行时自动给的，
   * 没有 idle 动作也不会「死住」。
   */
  async function playIdle() {
    if (!idleGroup || idleGroup === "none") return;

    var settings = model.internalModel.settings;
    var names = Object.keys((settings && settings.motions) || {});
    var candidates = [];

    if (names.indexOf(idleGroup) >= 0) candidates.push(idleGroup);
    var idleLike = /idle|待机|standby/i;
    names.forEach(function (name) {
      if (idleLike.test(name) && candidates.indexOf(name) < 0) candidates.push(name);
    });
    var nonEmpty = names.filter(function (name) { return name.trim() !== ""; });
    if (nonEmpty.length === 1 && candidates.indexOf(nonEmpty[0]) < 0) candidates.push(nonEmpty[0]);

    var priority = PIXI.live2d.MotionPriority ? PIXI.live2d.MotionPriority.IDLE : 1;
    for (var i = 0; i < candidates.length; i++) {
      if (await model.motion(candidates[i], 0, priority)) return;
    }

    console.info(
      "[live2d] 这个模型没有可用的待机动作组（现有分组：" +
        JSON.stringify(names) +
        "），仅使用呼吸 / 眨眼 / 物理 / 鼠标追踪"
    );
  }

  // ───────────────────────── 语音朗读 / 口型同步 ───────────────
  //
  // 音频由 Python 侧的 edge-tts 合成，通过 Chainlit 的
  // /project/file/<chainlit_key>?session_id=<sid> 暴露（同源，可直接 fetch）。
  // 这里负责：拉取 → 解码 → **预先算好振幅包络** → 播放 → 按 AudioContext 时钟
  // 查表驱动 ParamMouthOpenY。
  //
  // 为什么不用实时 AnalyserNode：包络只在解码后算一次，之后纯按时间查表，
  // 即使 rAF 抖动或掉帧也不会和音频跑偏（Amiya 的 8192 贴图只有 ~48fps）。
  //
  // 注意：两个模型都**没有可用的标准 LipSync 组**（Amiya 的 Groups 里 LipSync
  // 的 Ids 是空的，congyu 干脆没有 Groups），所以不能指望 pixi 自动对口型，
  // 必须自己写参数。
  var MOUTH_PARAM = "ParamMouthOpenY"; // 两个模型都有这个参数
  var ENVELOPE_FPS = 60;               // 包络的采样率（每秒多少个振幅值）
  var MOUTH_GAIN = 3.6;                // RMS → 张嘴幅度 的放大系数
  var MOUTH_GATE = 0.02;               // 静音门限，避免底噪让嘴一直抖
  var MOUTH_ATTACK = 0.6;              // 张嘴系数：快
  var MOUTH_RELEASE = 0.15;            // 闭嘴系数：慢

  var audioCtx = null;
  var speech = null;          // { source, envelope, startedAt }
  var lastSpeechSeq = null;   // 去重：同一个 seq 只播一次
  var mouthLevel = 0;         // 当前口型幅度（平滑后）

  function ensureAudioContext() {
    if (!audioCtx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor();
    }
    return audioCtx;
  }

  /** 把解码后的音频压成「每帧一个 RMS 值」的包络表 */
  function buildEnvelope(buffer) {
    var data = buffer.getChannelData(0);
    var frameSize = Math.max(1, Math.round(buffer.sampleRate / ENVELOPE_FPS));
    var count = Math.ceil(data.length / frameSize);
    var envelope = new Float32Array(count);

    for (var i = 0; i < count; i++) {
      var start = i * frameSize;
      var end = Math.min(start + frameSize, data.length);
      var sum = 0;
      for (var j = start; j < end; j++) sum += data[j] * data[j];
      envelope[i] = Math.sqrt(sum / Math.max(1, end - start));
    }
    return envelope;
  }

  /** 当前应该张多大的嘴（0~1）——按 AudioContext 时钟查表，不会和音频跑偏 */
  function targetMouthLevel() {
    if (!speech || !audioCtx) return 0;

    var index = Math.floor((audioCtx.currentTime - speech.startedAt) * ENVELOPE_FPS);
    if (index < 0 || index >= speech.envelope.length) return 0;

    var level = speech.envelope[index] * MOUTH_GAIN;
    if (level < MOUTH_GATE) return 0;
    return level > 1 ? 1 : level;
  }

  function stopSpeaking() {
    if (speech) {
      try {
        speech.source.onended = null;
        speech.source.stop();
      } catch (err) {
        /* 已经停了，忽略 */
      }
      speech = null;
    }
  }

  /** 拉取并播放一段语音；失败只警告，不影响其他功能 */
  async function speak(info) {
    stopSpeaking();

    var ctx = ensureAudioContext();
    // 浏览器自动播放策略：没有用户手势时 AudioContext 处于 suspended。
    // 发消息本身是一次手势，正常能 resume；万一失败就放弃（不弹错误）。
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        /* 忽略 */
      }
    }

    var response = await fetch(info.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error("音频获取失败 HTTP " + response.status);
    var buffer = await ctx.decodeAudioData(await response.arrayBuffer());

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = function () {
      if (speech && speech.source === source) speech = null;
    };

    speech = {
      source: source,
      envelope: buildEnvelope(buffer),
      startedAt: ctx.currentTime,
    };
    source.start();
  }

  /**
   * 把口型写进模型。
   *
   * 关键：必须挂在 **coreModel.update() 之前**，而不是在 internalModel.update()
   * 之后补一次 coreModel.update()。
   *
   * Cubism4InternalModel.update() 的真实顺序（实测源码）：
   *   动作 → saveParameters()（记住“动作后”的基线）
   *   → 表情 → 眨眼 → 焦点 → 呼吸/物理/自然动作 → pose
   *   → coreModel.update()（用当前参数算变形）
   *   → coreModel.loadParameters()（把参数还原成那条基线）
   *
   * 所以 update() 返回时，表情/眨眼/焦点/呼吸/物理/pose 已经**全部被抹掉**了。
   * 那时候再写嘴型 + 补一次 core.update()，等于拿裸基线重画一帧 ——
   * 表现就是「一开口说话，身体就僵成默认姿势」。
   * 而挂在 coreModel.update() 上刚好落在变形计算的前一刻：既不用多加一次 pass，
   * 也不影响其他任何动态。
   */
  function installMouthHook() {
    if (!model) return;

    var core = model.internalModel.coreModel;
    if (!core || core.__mouthHooked) return;

    // 不同版本的核心模型提供的 setter 名字不完全一样，这里做个兼容
    var setMouth;
    if (typeof core.setParameterValueById === "function") {
      setMouth = function (value) {
        core.setParameterValueById(MOUTH_PARAM, value);
      };
    } else {
      var paramIndex = core.getParameterIndex(MOUTH_PARAM);
      setMouth = function (value) {
        if (paramIndex >= 0) core.setParameterValueByIndex(paramIndex, value);
      };
    }

    var originalCoreUpdate = core.update.bind(core);
    core.update = function () {
      var target = targetMouthLevel();

      if (target > 0 || mouthLevel > 0.002) {
        // 张嘴快、闭嘴慢，看起来才像在说话
        var k = target > mouthLevel ? MOUTH_ATTACK : MOUTH_RELEASE;
        mouthLevel += (target - mouthLevel) * k;
        setMouth(mouthLevel);
      } else {
        // 不说话时不写参数，把嘴型还给动作/物理自己管，也不多花性能
        mouthLevel = 0;
      }

      return originalCoreUpdate();
    };
    core.__mouthHooked = true;
  }

  async function boot() {
    try {
      if (!window.Live2DCubismCore) {
        throw new Error("缺少 Live2D Cubism Core（vendor/live2dcubismcore.min.js）");
      }
      if (!window.PIXI) {
        throw new Error("缺少 PIXI（vendor/pixi.min.js）");
      }
      if (!window.PIXI.live2d) {
        throw new Error("缺少 pixi-live2d-display cubism4 构建");
      }

      // 本阶段不处理语音：避免运行时因为动作里的 Sound 字段去拉取不存在的音频
      if (PIXI.live2d.config) {
        PIXI.live2d.config.sound = false;
      }

      app = new PIXI.Application({
        view: canvas,
        backgroundAlpha: 0, // 透明
        antialias: true,
        autoDensity: true, // 配合 resolution 做高 DPI
        resolution: window.devicePixelRatio || 1,
        resizeTo: window, // 跟随 iframe 尺寸变化
      });

      // 帧率上限，默认 60。很多显示器是 120/144Hz，PIXI 会跟着跑满，
      // 而 Live2D 每帧都要重算变形/物理并重绘 4096×2048 的贴图，开销不小；
      // 如果能跑满屏刷率，会白白占掉 GPU/CPU，遇到「发消息时顿一下」这类抢资源的情况，
      // 先把这里降下来（?fps=30 还能更省）。
      var maxFps = toNumber(query.get("fps"), 60);
      if (maxFps > 0) {
        if (PIXI.Ticker.shared) PIXI.Ticker.shared.maxFPS = maxFps;
        app.ticker.maxFPS = maxFps;
      }

      window.addEventListener("resize", layout);
      await loadModel(query.get("model") || DEFAULT_MODEL);
    } catch (err) {
      console.error("[live2d]", err);
      var text = (err && err.message) || String(err);
      setStatus("Live2D 加载失败：\n" + text, true);
      post("error", { message: text });
    }
  }

  // 接收父窗口（Live2DAvatar 元素）下发的消息
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "chainlit") return;

    // 全局鼠标追踪：光标在形象区域之外时，浏览器的事件只到父页面，
    // 由父页面把坐标换算好传进来（坐标系 = 画布左上角为原点）
    if (data.type === "pointer") {
      if (model && typeof data.x === "number" && typeof data.y === "number") {
        model.focus(data.x, data.y);
      }
      return;
    }

    if (data.type !== "config") return;

    if (typeof data.scale === "number" && data.scale > 0) {
      userScale = data.scale;
      layout();
    }

    if (data.align) {
      view.align = data.align;
      layout();
    }

    if (typeof data.offsetX === "number") {
      view.offsetX = data.offsetX;
      layout();
    }

    if (data.anchorY) {
      view.anchorY = data.anchorY;
      layout();
    }

    // 待机组名只在重新加载模型时才有意义，所以先记下，等 loadModel 时用
    if (data.idle) idleGroup = data.idle;

    // 语音朗读：父窗口下发「播放这段音频」，由本页负责播放 + 口型同步。
    // 按 seq 去重 —— 父窗口为了兼容 iframe 加载时机，可能会重发同一条 config。
    if (data.speech && data.speech.stop) {
      stopSpeaking();
      lastSpeechSeq = data.speech.seq;
    } else if (data.speech && data.speech.url && data.speech.seq !== lastSpeechSeq) {
      lastSpeechSeq = data.speech.seq;
      speak(data.speech).catch(function (err) {
        console.warn("[live2d] 语音播放失败：", err);
      });
    }

    if (data.model && data.model !== currentModelUrl) {
      loadModel(data.model).catch(function (err) {
        console.error("[live2d]", err);
        post("error", { message: (err && err.message) || String(err) });
      });
    }
  });

  boot();
})();
