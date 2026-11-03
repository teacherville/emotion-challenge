/* =========================================================
   표정 챌린지 — 앱 로직
   - 서버 없이 브라우저 안에서만 동작해요.
   - 카메라 영상은 기기 밖으로 나가지 않아요(저장·전송 없음).
   - 얼굴 인식: Google MediaPipe Face Landmarker (Apache-2.0)
   ========================================================= */
(function () {
  "use strict";

  /* ---------- 설정 ---------- */
  var APP_VERSION = "v1.1";
  var MP_VERSION = "0.10.14";
  var MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + MP_VERSION;
  var MP_MODULE = MP_BASE + "/vision_bundle.mjs";
  var MP_WASM = MP_BASE + "/wasm";
  var MP_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  var QR_LIB = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";

  /*
    표정 점수 조절값 — 실제 교실에서 써 보고 너무 어렵거나 쉬우면 여기 숫자를 바꿔요.
    scale: 이 값만큼 표정을 지으면 100점 (작을수록 쉬워요)
  */
  var TUNING = {
    joy:      { scale: 0.75, passOffset: 0 },
    surprise: { scale: 0.85, passOffset: 0 },
    sad:      { scale: 0.55, passOffset: -10 },  // 슬픔은 얼굴 움직임이 작아서 통과선을 10 낮춰요
    angry:    { scale: 0.60, passOffset: -5 },
    headDownRange: 0.12,  // 고개를 이만큼 숙이면 "고개 숙이기" 신호가 최대 (작을수록 민감)
    smoothing: 0.35,      // 0~1, 클수록 게이지가 빠르게 움직여요
    holdMs: 500           // 통과선을 이 시간 동안 넘기면 통과
  };

  /* 표정 연기 팁 (점수가 낮을 때 화면에 보여줘요) */
  var COACH = {
    joy: "입꼬리를 쭉 올리고 눈웃음 지어요",
    surprise: "눈을 크게, 입을 동그랗게, 눈썹을 위로!",
    sad: "입꼬리 내리고 입술 삐죽, 고개를 살짝 숙여요",
    angry: "미간을 찌푸리고 입을 꾹 다물어요"
  };

  var EMO_KEYS = ["joy", "surprise", "sad", "angry"];
  var EMO_COLOR = { joy: "#F2B024", surprise: "#FF8A3D", sad: "#3D8BFF", angry: "#F0445A" };
  var DOMAIN_TINT = ["#E1D8FF", "#FFD6EC", "#CFF1FF", "#CDF7E8"];
  var DOMAIN_INK = ["#6A4BE8", "#D9408F", "#1E8FB8", "#13866B"];

  var EMOTIONS = window.EMOTIONS;
  var DEFAULT_QUESTIONS = window.DEFAULT_QUESTIONS;
  var TALK_DOMAINS = window.TALK_DOMAINS;
  var DEFAULT_CARDS = window.DEFAULT_CARDS;

  var params = new URLSearchParams(location.search);
  var DEMO = params.get("demo") === "1";
  var DEBUG = params.get("debug") === "1";

  /* ---------- 작은 도구 ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "html") n.innerHTML = v;
        else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
        else if (k === "style") n.setAttribute("style", v);
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function announce(t) { var l = $("live"); l.textContent = ""; setTimeout(function () { l.textContent = t; }, 30); }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(path, cls) { return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true">' + path + "</svg>"; }
  var ICON_CHECK = '<polyline points="5 12 10 17 19 7"/>';
  var ICON_PLUS = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
  var ICON_X = '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>';
  var ICON_TRASH = '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>';
  var STAR_PATH = '<path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z"/>';

  /* ---------- 저장 (이 기기 브라우저에만) ---------- */
  var KEY = { cards: "ec.cards.v1", deleted: "ec.deleted.v1", settings: "ec.settings.v1", dict: "ec.dict.v1" };
  function load(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } }

  function resolveDefault(c) {
    var d = clone(c);
    var dq = DEFAULT_QUESTIONS[d.emo];
    d.questions = [
      d.questions[0] || dq[0],
      d.questions[1] || "",
      d.questions[2] || "",
      d.questions[3] || dq[1]
    ];
    d.used = true;
    d.isDefault = true;
    return d;
  }
  function defaultById(id) {
    for (var i = 0; i < DEFAULT_CARDS.length; i++) if (DEFAULT_CARDS[i].id === id) return resolveDefault(DEFAULT_CARDS[i]);
    return null;
  }

  var state = {
    cards: [],
    deleted: load(KEY.deleted, []),
    settings: Object.assign({ count: 10, time: 15, level: 70, sound: true }, load(KEY.settings, {})),
    dict: load(KEY.dict, [])
  };
  (function initCards() {
    var saved = load(KEY.cards, null);
    if (Array.isArray(saved) && saved.length) {
      state.cards = saved;
      // 새 버전에서 추가된 기본 카드 넣기
      DEFAULT_CARDS.forEach(function (c) {
        var has = state.cards.some(function (x) { return x.id === c.id; });
        if (!has && state.deleted.indexOf(c.id) === -1) state.cards.push(resolveDefault(c));
      });
    } else {
      state.cards = DEFAULT_CARDS.map(resolveDefault);
    }
  })();
  var saveTimer = null;
  function saveCards() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(KEY.cards, state.cards); save(KEY.deleted, state.deleted); }, 250);
  }
  function saveSettings() { save(KEY.settings, state.settings); }
  function saveDict() { save(KEY.dict, state.dict); }

  /* ---------- 화면 전환 ---------- */
  var current = "start";
  function go(name) {
    var prev = current;
    document.querySelectorAll(".screen").forEach(function (s) { s.classList.remove("active"); });
    $("screen-" + name).classList.add("active");
    current = name;
    $("screen-" + name).scrollTop = 0;

    if (name === "calib") mountCam("calib-cam-slot");
    if (name === "play") mountCam("play-cam-slot");
    if (name !== "play") stopTimer();
    if (name === "start" || name === "cards") stopCamera();
    if (name === "start") startCover(); else stopCover();
    if (name === "cards") renderCards();
    return prev;
  }
  document.querySelectorAll("[data-go]").forEach(function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
  });

  /* ---------- 효과음 ---------- */
  var audioCtx = null;
  function tone(freq, start, dur, type, vol) {
    if (!state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var t = audioCtx.currentTime + start;
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* 소리 불가 */ }
  }
  function sfxPass() { tone(784, 0, 0.18, "triangle"); tone(1046, 0.12, 0.28, "triangle"); tone(1318, 0.24, 0.4, "triangle", 0.14); }
  function sfxPop() { tone(660, 0, 0.09, "sine", 0.1); }
  function sfxEnd() { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, i * 0.13, 0.35, "triangle", 0.15); }); }
  function sfxTick() { tone(880, 0, 0.06, "square", 0.05); }

  /* ---------- 축하 효과 ---------- */
  function confetti(n) {
    var box = $("confetti");
    var colors = ["#C9B8FF", "#FFC2E8", "#B5F3FF", "#FFE27A", "#9AF0D2", "#FF9FD8"];
    for (var i = 0; i < (n || 40); i++) {
      var p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--x", (Math.random() * 30 - 15) + "vw");
      p.style.setProperty("--r", (Math.random() * 720 - 360) + "deg");
      p.style.setProperty("--d", (1.2 + Math.random() * 1.2) + "s");
      p.style.animationDelay = Math.random() * 0.3 + "s";
      box.appendChild(p);
      (function (q) { setTimeout(function () { q.remove(); }, 2900); })(p);
    }
  }

  /* =========================================================
     표지
     ========================================================= */
  var FACES = [
    { name: "뿌듯함", emo: "joy", g: ["#FFFFFF", "#FFD0F0", "#B9A4FF", "#8FD8F5"],
      parts: '<path d="M32 46 Q37 40 42 46" class="s"/><path d="M58 46 Q63 40 68 46" class="s"/><path d="M34 60 Q50 76 66 60" class="s w"/><circle cx="28" cy="58" r="5" fill="#FF8FCB" opacity=".7"/><circle cx="72" cy="58" r="5" fill="#FF8FCB" opacity=".7"/>' },
    { name: "깜짝 놀람", emo: "surprise", g: ["#FFFFFF", "#FFEBA8", "#FFB98A", "#FF9FD8"],
      parts: '<path d="M28 34 Q36 27 43 33" class="s t"/><path d="M57 33 Q64 27 72 34" class="s t"/><circle cx="37" cy="45" r="5.5" fill="#2A1F5C"/><circle cx="63" cy="45" r="5.5" fill="#2A1F5C"/><ellipse cx="50" cy="66" rx="8" ry="10" fill="#2A1F5C"/>' },
    { name: "속상함", emo: "sad", g: ["#FFFFFF", "#CFE6FF", "#9FC4FF", "#B9A4FF"],
      parts: '<path d="M30 38 L42 34" class="s t"/><path d="M70 38 L58 34" class="s t"/><path d="M32 46 Q37 51 42 46" class="s"/><path d="M58 46 Q63 51 68 46" class="s"/><path d="M37 70 Q50 60 63 70" class="s w"/><path d="M66 52 Q69 58 66 61 Q63 58 66 52 z" fill="#6FB6FF" stroke="#fff" stroke-width="1"/>' },
    { name: "억울함", emo: "angry", g: ["#FFFFFF", "#FFD3D3", "#FF9FB0", "#C9A4FF"],
      parts: '<path d="M29 34 L43 40" class="s"/><path d="M71 34 L57 40" class="s"/><circle cx="37" cy="47" r="4.5" fill="#2A1F5C"/><circle cx="63" cy="47" r="4.5" fill="#2A1F5C"/><path d="M38 68 Q44 63 50 68 Q56 73 62 68" class="s w"/><circle cx="26" cy="60" r="6" fill="#FF7A9C" opacity=".6"/><circle cx="74" cy="60" r="6" fill="#FF7A9C" opacity=".6"/>' }
  ];
  function faceSvg(f, idx) {
    var id = "jg" + idx + "_" + Math.floor(Math.random() * 1e6);
    return '<svg class="pop" viewBox="0 0 100 100" role="img" aria-label="' + f.name + ' 얼굴">' +
      '<style>.s{fill:none;stroke:#2A1F5C;stroke-width:4.5;stroke-linecap:round}.s.t{stroke-width:4}.s.w{stroke-width:5}</style>' +
      '<defs><radialGradient id="' + id + '" cx="35%" cy="30%" r="75%"><stop offset="0%" stop-color="' + f.g[0] + '"/><stop offset="35%" stop-color="' + f.g[1] + '"/><stop offset="75%" stop-color="' + f.g[2] + '"/><stop offset="100%" stop-color="' + f.g[3] + '"/></radialGradient></defs>' +
      '<circle cx="50" cy="50" r="46" fill="url(#' + id + ')"/>' +
      '<ellipse cx="34" cy="24" rx="12" ry="7" fill="#fff" opacity=".9" transform="rotate(-25 34 24)"/>' +
      f.parts + "</svg>";
  }
  var coverIdx = 0, coverTimer = null;
  function showCover() {
    var f = FACES[coverIdx];
    $("cover-face").innerHTML = faceSvg(f, coverIdx);
    $("cover-name").textContent = f.name;
    var chips = $("cover-chips"); chips.innerHTML = "";
    EMO_KEYS.forEach(function (k) { chips.appendChild(el("span", { class: k === f.emo ? "on" : "", text: EMOTIONS[k].label })); });
  }
  function startCover() {
    stopCover(); showCover();
    coverTimer = setInterval(function () { coverIdx = (coverIdx + 1) % FACES.length; showCover(); }, 1900);
  }
  function stopCover() { if (coverTimer) clearInterval(coverTimer); coverTimer = null; }

  $("app-version").textContent = APP_VERSION;
  $("btn-start").addEventListener("click", startGame);
  $("btn-open-cards").addEventListener("click", function () { go("cards"); });
  $("btn-qr").addEventListener("click", openQR);
  $("btn-licenses").addEventListener("click", openLicenses);

  /* =========================================================
     카메라 + 얼굴 인식
     ========================================================= */
  var cam = {
    stream: null, video: $("cam-video"), canvas: $("cam-canvas"),
    landmarker: null, vision: null, drawer: null, loading: null,
    running: false, raf: 0, lastVideoTime: -1, lastRun: 0, interval: 66,
    faceSeen: false, lastFaceAt: 0,
    baseline: null, calibSamples: null,
    raw: { joy: 0, surprise: 0, sad: 0, angry: 0 },
    score: { joy: 0, surprise: 0, sad: 0, angry: 0 },
    mode: DEMO ? "demo" : "ai" // ai | teacher | demo
  };

  function mountCam(slotId) { $(slotId).appendChild($("cam-stage")); }
  function setCamStatus(kind, text) {
    var s = $("cam-status"); s.className = "cam-status " + (kind || ""); s.querySelector("b").textContent = text;
  }
  function setPlaceholder(show, text) {
    $("cam-placeholder").hidden = !show;
    if (text) $("cam-placeholder-text").textContent = text;
  }

  function startCamera() {
    if (cam.stream) return Promise.resolve(cam.stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("unsupported"));
    }
    setPlaceholder(true, "카메라 권한을 허용해 주세요");
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(function (stream) {
      cam.stream = stream;
      cam.video.srcObject = stream;
      cam.video.setAttribute("playsinline", "");
      cam.video.muted = true;
      return cam.video.play().catch(function () {}).then(function () {
        setPlaceholder(false);
        return stream;
      });
    });
  }
  function stopCamera() {
    cam.running = false;
    cancelAnimationFrame(cam.raf);
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    cam.video.srcObject = null;
    var ctx = cam.canvas.getContext("2d"); ctx && ctx.clearRect(0, 0, cam.canvas.width, cam.canvas.height);
    setPlaceholder(true, cam.mode === "teacher" ? "카메라 없이 하는 중" : "카메라 준비 중");
  }

  function loadModel() {
    if (cam.landmarker) return Promise.resolve(cam.landmarker);
    if (cam.loading) return cam.loading;
    cam.loading = import(MP_MODULE).then(function (vision) {
      cam.vision = vision;
      return vision.FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) {
        function make(delegate) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
            runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true
          });
        }
        return make("GPU").catch(function () { return make("CPU"); });
      });
    }).then(function (lm) {
      cam.landmarker = lm;
      return lm;
    }).catch(function (e) { cam.loading = null; throw e; });
    return cam.loading;
  }

  function startLoop() {
    if (cam.running) return;
    cam.running = true;
    var ctx = cam.canvas.getContext("2d");
    function frame(now) {
      if (!cam.running) return;
      cam.raf = requestAnimationFrame(frame);
      if (cam.mode === "demo") { demoTick(now); return; }
      if (!cam.landmarker || cam.video.readyState < 2) return;
      if (cam.video.currentTime === cam.lastVideoTime) return;
      if (now - cam.lastRun < cam.interval) return;
      cam.lastRun = now; cam.lastVideoTime = cam.video.currentTime;
      var t0 = performance.now(), res;
      try { res = cam.landmarker.detectForVideo(cam.video, now); } catch (e) { return; }
      var cost = performance.now() - t0;
      // 느린 기기면 인식 횟수를 줄여요
      cam.interval = cost > 55 ? 140 : cost > 30 ? 90 : 66;
      handleResult(res, ctx);
    }
    cam.raf = requestAnimationFrame(frame);
  }

  function blendMap(res) {
    var m = {};
    if (res && res.faceBlendshapes && res.faceBlendshapes[0]) {
      res.faceBlendshapes[0].categories.forEach(function (c) { m[c.categoryName] = c.score; });
    }
    return m;
  }
  /* 고개 숙임 정도: 눈~턱 사이에서 코끝이 얼마나 아래에 있는지 (고개를 숙이면 커져요) */
  function headRatioFrom(lm) {
    if (!lm || !lm[1] || !lm[33] || !lm[263] || !lm[152]) return 0;
    var eyeY = (lm[33].y + lm[263].y) / 2, chinY = lm[152].y;
    var span = chinY - eyeY;
    if (span <= 0.0001) return 0;
    return (lm[1].y - eyeY) / span;
  }
  function featureFrom(m, lm) {
    function g(k) { return m[k] || 0; }
    function avg(a, b) { return (g(a) + g(b)) / 2; }
    return {
      pucker: g("mouthPucker"),
      headRatio: headRatioFrom(lm),
      smile: avg("mouthSmileLeft", "mouthSmileRight"),
      frown: avg("mouthFrownLeft", "mouthFrownRight"),
      browDown: avg("browDownLeft", "browDownRight"),
      browInnerUp: g("browInnerUp"),
      browOuterUp: avg("browOuterUpLeft", "browOuterUpRight"),
      eyeWide: avg("eyeWideLeft", "eyeWideRight"),
      squint: avg("eyeSquintLeft", "eyeSquintRight"),
      jawOpen: g("jawOpen"),
      sneer: avg("noseSneerLeft", "noseSneerRight"),
      press: avg("mouthPressLeft", "mouthPressRight"),
      shrugLower: g("mouthShrugLower"),
      stretch: avg("mouthStretchLeft", "mouthStretchRight")
    };
  }
  function emotionsFrom(f) {
    var base = cam.baseline;
    var a = {};
    Object.keys(f).forEach(function (k) {
      var b = base ? base[k] : 0;
      a[k] = Math.max(0, (f[k] - b) / Math.max(0.25, 1 - b));
    });
    // 고개 숙이기는 보정 때의 자세와 비교해요
    a.headDown = base ? clamp((f.headRatio - base.headRatio) / TUNING.headDownRange, 0, 1) : 0;
    cam.lastA = a;
    return {
      joy: a.smile * 1.25 + a.squint * 0.15,
      surprise: a.jawOpen * 0.55 + a.eyeWide * 0.9 + a.browInnerUp * 0.5 + a.browOuterUp * 0.6 - a.smile * 0.4,
      // 슬픔: 입꼬리 내리기 + 눈썹 안쪽 올리기 + 아랫입술 올리기/삐죽 + 고개 숙이기
      sad: a.frown * 1.2 + a.browInnerUp * 0.7 + a.shrugLower * 0.5 + a.pucker * 0.35 + a.press * 0.2 + a.stretch * 0.15 + a.headDown * 0.45
           - a.smile * 0.8 - a.jawOpen * 0.3 - a.eyeWide * 0.2,
      angry: a.browDown * 1.3 + a.sneer * 0.7 + a.press * 0.4 + a.squint * 0.25 - a.smile * 0.8 - a.browInnerUp * 0.2
    };
  }

  /* ---------- 측정 테스트 모드 (주소 끝에 ?debug=1) ---------- */
  var dbg = null;
  function initDebug() {
    if (!DEBUG) return;
    dbg = document.createElement("div");
    dbg.className = "debug-panel";
    dbg.setAttribute("aria-hidden", "true");
    $("cam-stage").appendChild(dbg);
  }
  function renderDebug(e) {
    if (!dbg) return;
    var a = cam.lastA || {};
    function bar(label, v, color) {
      var p = clamp(Math.round(v), 0, 100);
      return '<div class="dbg-row"><span>' + label + '</span><i><b style="width:' + p + '%;background:' + color + '"></b></i><em>' + p + "</em></div>";
    }
    function raw(label, v) { return "<span>" + label + " <b>" + (v || 0).toFixed(2) + "</b></span>"; }
    var target = game.card ? game.card.emo : null;
    var html = '<div class="dbg-title">측정 테스트 모드' + (cam.baseline ? "" : " · 보정 전") + "</div>";
    EMO_KEYS.forEach(function (k) {
      html += bar(EMOTIONS[k].label + (k === target ? " ◀" : ""), cam.score[k], EMO_COLOR[k]);
    });
    html += '<div class="dbg-raw">' +
      raw("입꼬리↑", a.smile) + raw("입꼬리↓", a.frown) + raw("눈썹안쪽↑", a.browInnerUp) + raw("미간", a.browDown) +
      raw("눈크게", a.eyeWide) + raw("입벌림", a.jawOpen) + raw("코찡긋", a.sneer) + raw("입다묾", a.press) +
      raw("아랫입술↑", a.shrugLower) + raw("삐죽", a.pucker) + raw("고개숙임", a.headDown) +
      "</div>";
    dbg.innerHTML = html;
  }

  function handleResult(res, ctx) {
    var has = res && res.faceLandmarks && res.faceLandmarks.length > 0;
    var now = performance.now();
    if (has) { cam.faceSeen = true; cam.lastFaceAt = now; }
    var visible = has || now - cam.lastFaceAt < 400;
    setCamStatus(visible ? "ok" : "bad", visible ? "얼굴 인식 중" : "얼굴이 안 보여요");

    // 얼굴 점 그리기
    if (cam.canvas.width !== cam.video.videoWidth) { cam.canvas.width = cam.video.videoWidth; cam.canvas.height = cam.video.videoHeight; }
    ctx.clearRect(0, 0, cam.canvas.width, cam.canvas.height);
    if (has) drawFace(res.faceLandmarks[0], ctx);

    if (current === "calib") updateCalibUI(has);
    if (!has) { decayScores(); return; }

    var f = featureFrom(blendMap(res), res.faceLandmarks[0]);
    if (cam.calibSamples) { cam.calibSamples.push(f); return; }

    var e = emotionsFrom(f);
    var s = TUNING.smoothing;
    EMO_KEYS.forEach(function (k) {
      var v = clamp(e[k] / TUNING[k].scale * 100, 0, 100);
      cam.score[k] = cam.score[k] * (1 - s) + v * s;
    });
    renderDebug(e);
    if (current === "play") onScores();
  }
  function decayScores() {
    EMO_KEYS.forEach(function (k) { cam.score[k] *= 0.85; });
    if (current === "play") onScores();
  }

  function drawFace(lm, ctx) {
    var V = cam.vision, w = cam.canvas.width, h = cam.canvas.height;
    if (V && V.FaceLandmarker && V.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) {
      var sets = [
        [V.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, "rgba(255,194,232,0.85)", 2.5],
        [V.FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, "#B5F3FF", 3],
        [V.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, "#B5F3FF", 3],
        [V.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, "#B5F3FF", 2],
        [V.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, "#B5F3FF", 2],
        [V.FaceLandmarker.FACE_LANDMARKS_LIPS, "#FFE27A", 2.5]
      ];
      ctx.lineCap = "round";
      sets.forEach(function (set) {
        ctx.strokeStyle = set[1]; ctx.lineWidth = set[2] * (w / 640);
        ctx.beginPath();
        set[0].forEach(function (c) {
          var a = lm[c.start], b = lm[c.end];
          if (!a || !b) return;
          ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h);
        });
        ctx.stroke();
      });
    }
  }

  /* 테스트용: 주소 끝에 ?demo=1 을 붙이면 카메라 없이 점수가 저절로 움직여요 */
  function demoTick(now) {
    if (current !== "play" || !game.card) return;
    var target = game.card.emo, t = (now - game.cardStart) / 1000;
    EMO_KEYS.forEach(function (k) {
      var v = k === target ? clamp(t * 14, 0, 92) : 10 + 8 * Math.sin(t + k.length);
      cam.score[k] = cam.score[k] * 0.8 + v * 0.2;
    });
    renderDebug();
    onScores();
  }

  /* =========================================================
     카메라 준비(보정)
     ========================================================= */
  function prepareCamera() {
    var msg = $("calib-msg"), btn = $("btn-calib");
    btn.disabled = true;
    if (cam.mode === "demo") {
      msg.textContent = "테스트 모드예요. 카메라 없이 점수가 저절로 움직여요.";
      btn.disabled = false; btn.textContent = "시작하기";
      setPlaceholder(true, "테스트 모드"); setCamStatus("ok", "테스트 모드");
      return;
    }
    btn.textContent = "편안한 얼굴 기억하기";
    msg.textContent = "카메라를 켜는 중이에요…";
    setCamStatus("", "준비 중");
    startCamera().then(function () {
      msg.textContent = "얼굴 인식 기능을 불러오는 중이에요… (처음엔 몇 초 걸려요)";
      return loadModel();
    }).then(function () {
      msg.textContent = "얼굴이 보이면 버튼을 눌러 주세요.";
      startLoop();
    }).catch(function (e) {
      var name = e && e.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        msg.textContent = "카메라 권한이 꺼져 있어요. 브라우저 주소창 옆 설정에서 카메라를 허용해 주세요.";
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        msg.textContent = "카메라를 찾지 못했어요. 전자칠판이라면 USB 웹캠을 연결해 주세요.";
      } else if (e && e.message === "unsupported") {
        msg.textContent = "이 브라우저는 카메라를 지원하지 않아요. 최신 크롬이나 사파리로 열어 주세요.";
      } else if (cam.stream) {
        msg.textContent = "얼굴 인식 기능을 불러오지 못했어요. 인터넷 연결을 확인하거나 '카메라 없이 하기'로 진행해 주세요.";
      } else {
        msg.textContent = "카메라를 켜지 못했어요. 다른 앱이 카메라를 쓰고 있지 않은지 확인해 주세요.";
      }
      setCamStatus("bad", "준비 안 됨");
    });
  }
  function updateCalibUI(has) {
    if (cam.calibSamples) return;
    var btn = $("btn-calib");
    btn.disabled = !has;
    $("calib-msg").textContent = has ? "좋아요! 편안한 얼굴로 버튼을 눌러 주세요." : "화면 가운데에 얼굴이 보이게 앉아 주세요.";
  }
  $("btn-calib").addEventListener("click", function () {
    if (cam.mode === "demo") { cam.baseline = null; beginCards(); return; }
    var slot = $("calib-cam-slot"), n = 3;
    var big = el("div", { class: "count-big", text: String(n) });
    slot.appendChild(big);
    $("btn-calib").disabled = true;
    $("calib-msg").textContent = "움직이지 말고 편안한 얼굴로 있어요…";
    cam.calibSamples = [];
    var iv = setInterval(function () {
      n--; sfxTick();
      if (n > 0) { big.textContent = String(n); return; }
      clearInterval(iv); big.remove();
      var samples = cam.calibSamples || []; cam.calibSamples = null;
      if (samples.length < 5) {
        $("calib-msg").textContent = "얼굴이 잘 안 보였어요. 한 번 더 해 볼까요?";
        $("btn-calib").disabled = false; return;
      }
      var base = {};
      Object.keys(samples[0]).forEach(function (k) {
        var vals = samples.map(function (s) { return s[k]; }).sort(function (a, b) { return a - b; });
        base[k] = vals[Math.floor(vals.length / 2)];
      });
      cam.baseline = base;
      EMO_KEYS.forEach(function (k) { cam.score[k] = 0; });
      beginCards();
    }, 1000);
  });
  $("btn-nocam").addEventListener("click", function () {
    cam.mode = "teacher";
    stopCamera();
    setPlaceholder(true, "카메라 없이 하는 중 · 대표 학생이 앞에 나와 표정을 지어 보세요");
    setCamStatus("", "카메라 끔");
    beginCards();
  });

  /* =========================================================
     게임 진행
     ========================================================= */
  var game = { deck: [], idx: 0, stars: 0, card: null, passed: false, best: 0, holdStart: 0, cardStart: 0, picks: {}, allPicks: [], timerLeft: 0, timerIv: null, talkIdx: 0 };

  function startGame() {
    var pool = state.cards.filter(function (c) { return c.used && c.text.trim(); });
    if (!pool.length) { openModal("카드가 없어요", "<p>오늘 사용할 카드가 없어요. <b>카드·질문 목록</b>에서 카드를 켜 주세요.</p>"); return; }
    var n = Number(state.settings.count) || pool.length;
    game.deck = shuffle(pool).slice(0, Math.min(n, pool.length));
    game.idx = 0; game.stars = 0; game.picks = {}; game.allPicks = [];
    if (cam.mode === "teacher") cam.mode = DEMO ? "demo" : "ai";
    go("calib");
    prepareCamera();
  }
  function beginCards() { showCard(); }

  function showCard() {
    var c = game.deck[game.idx];
    game.card = c; game.passed = false; game.best = 0; game.holdStart = 0; game.cardStart = performance.now();
    EMO_KEYS.forEach(function (k) { cam.score[k] = 0; });
    go("play");
    var total = game.deck.length;
    $("play-count").textContent = "카드 " + (game.idx + 1) + " / " + total;
    $("play-stars").textContent = "우리 반 별 " + game.stars + " / " + total;
    $("play-text").textContent = c.text;
    $("gauge-label").textContent = EMOTIONS[c.emo].label + " 표정";
    var lv = passLevel(c.emo);
    $("gauge-line").style.left = lv + "%";
    $("gauge-pass").textContent = "통과선 " + lv;
    $("gauge-hint").textContent = COACH[c.emo];
    game.timeUp = false;
    $("gauge").classList.remove("passed");
    var toPick = $("btn-to-pick"); toPick.textContent = "마음 고르기로"; toPick.classList.remove("glow");

    var teacher = cam.mode === "teacher";
    // 선생님 통과 버튼: 카메라 없이 할 때는 크게, 카메라 모드에서는 작게 항상 보여요
    var tp = $("btn-teacher-pass");
    tp.hidden = false;
    tp.classList.toggle("small", !teacher);
    tp.textContent = teacher ? "잘했어요! 통과" : "선생님 통과";
    $("gauge").hidden = teacher; $("gauge-num").hidden = teacher;
    document.querySelector(".gauge-foot").hidden = teacher;
    $("mini-meters").hidden = teacher;

    var mm = $("mini-meters"); mm.innerHTML = "";
    EMO_KEYS.filter(function (k) { return k !== c.emo; }).forEach(function (k) {
      mm.appendChild(el("div", { class: "mini" }, [
        el("span", { text: EMOTIONS[k].label }),
        el("div", { class: "bar" }, [el("i", { id: "mini-" + k, style: "background:" + EMO_COLOR[k] })])
      ]));
    });
    onScores();
    startTimer();
    if (cam.mode === "ai" && cam.landmarker) startLoop();
    if (cam.mode === "demo") startLoop();
  }

  function passLevel(emo) {
    return clamp(Number(state.settings.level) + (TUNING[emo].passOffset || 0), 30, 95);
  }

  function onScores() {
    if (!game.card) return;
    var k = game.card.emo, v = Math.round(cam.score[k]);
    $("gauge-num").textContent = v;
    $("gauge-fill").style.width = "calc(" + clamp(v, 0, 100) + "% - 8px)";
    $("gauge").setAttribute("aria-valuenow", v);
    EMO_KEYS.forEach(function (o) { var m = $("mini-" + o); if (m) m.style.width = clamp(cam.score[o], 0, 100) + "%"; });
    if (game.passed) return;
    game.best = Math.max(game.best, v);
    var lv = passLevel(k);
    if (!game.timeUp && cam.mode !== "teacher") {
      $("gauge-hint").textContent = v >= lv * 0.6 ? "조금만 더! " + COACH[k] : COACH[k];
    }
    if (v >= lv) {
      var now = performance.now();
      if (!game.holdStart) game.holdStart = now;
      if (now - game.holdStart >= TUNING.holdMs) pass();
    } else {
      game.holdStart = 0;
    }
  }

  function pass() {
    if (game.passed) return;
    game.passed = true;
    game.stars++;
    stopTimer();
    $("play-stars").textContent = "우리 반 별 " + game.stars + " / " + game.deck.length;
    $("gauge").classList.add("passed");
    $("gauge-hint").textContent = "멋진 표정이에요!";
    var b = $("pass-banner"); b.hidden = true; void b.offsetWidth; b.hidden = false;
    setTimeout(function () { b.hidden = true; }, 1700);
    confetti(46); sfxPass();
    var toPick = $("btn-to-pick"); toPick.textContent = "통과! 마음 고르기로"; toPick.classList.add("glow");
    announce("통과! 우리 반 별이 하나 늘었어요.");
  }
  $("btn-teacher-pass").addEventListener("click", function () { game.best = Math.max(game.best, 100); pass(); });

  function startTimer() {
    stopTimer();
    var total = DEBUG ? 0 : (Number(state.settings.time) || 0); // 측정 모드에서는 시간 제한 없음
    var t = $("play-timer");
    if (!total) { t.hidden = true; return; }
    t.hidden = false; t.classList.remove("warn");
    game.timerLeft = total;
    var fmt = function (s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
    t.textContent = fmt(total);
    game.timerIv = setInterval(function () {
      game.timerLeft--;
      t.textContent = fmt(Math.max(0, game.timerLeft));
      if (game.timerLeft <= 3 && game.timerLeft > 0) { t.classList.add("warn"); sfxTick(); }
      if (game.timerLeft <= 0) {
        stopTimer();
        if (!game.passed) {
          game.timeUp = true;
          $("gauge-hint").textContent = "시간이 끝났어요! 마음 고르기로 넘어가요";
          $("btn-to-pick").classList.add("glow");
        }
      }
    }, 1000);
  }
  function stopTimer() { if (game.timerIv) clearInterval(game.timerIv); game.timerIv = null; }

  $("btn-skip").addEventListener("click", nextCard);
  $("btn-to-pick").addEventListener("click", function () { stopTimer(); renderPick(); go("pick"); });

  function nextCard() {
    game.idx++;
    if (game.idx >= game.deck.length) { showEnd(); return; }
    showCard();
  }

  /* ---------- 마음 고르기 ---------- */
  var pickAdding = false;
  function pickedFor(c) { return game.picks[c.id] || (game.picks[c.id] = []); }
  function optionsFor(c) {
    var words = c.words.slice();
    state.dict.forEach(function (d) { if (d.emo === c.emo && words.indexOf(d.word) === -1) words.push(d.word); });
    return words;
  }
  function isCustom(c, w) { return c.words.indexOf(w) === -1; }

  function renderPick() {
    var c = game.card, total = game.deck.length;
    $("pick-count").textContent = "카드 " + (game.idx + 1) + " / " + total;
    $("score-top").textContent = game.passed ? "표정 연기 성공!" : "표정 연기 끝!";
    if (cam.mode === "teacher") {
      $("score-num").textContent = game.passed ? "통과" : "도전";
      $("score-emo").textContent = "· " + EMOTIONS[c.emo].label;
    } else {
      $("score-num").textContent = String(game.best);
      $("score-emo").textContent = "점 · " + EMOTIONS[c.emo].label;
    }
    $("score-star").textContent = (game.passed ? "우리 반 별 +1 · " : "우리 반 별 ") + game.stars + " / " + total;
    $("pick-situation").textContent = c.text;
    renderWords();
  }
  function renderWords() {
    var c = game.card, picked = pickedFor(c), grid = $("word-grid");
    grid.innerHTML = "";
    optionsFor(c).forEach(function (w) {
      var on = picked.indexOf(w) !== -1;
      var b = el("button", { type: "button", class: "word" + (on ? " on" : "") + (isCustom(c, w) ? " custom" : ""), "aria-pressed": on ? "true" : "false" });
      b.innerHTML = (on ? icon(ICON_CHECK) : "") + "<span></span>";
      b.querySelector("span").textContent = w;
      b.addEventListener("click", function () {
        var i = picked.indexOf(w);
        if (i === -1) picked.push(w); else picked.splice(i, 1);
        sfxPop(); renderWords();
      });
      grid.appendChild(b);
    });
    if (!pickAdding) {
      var add = el("button", { type: "button", class: "word add" });
      add.innerHTML = icon(ICON_PLUS) + "<span>다른 마음</span>";
      add.addEventListener("click", function () { pickAdding = true; renderWords(); var i = $("new-feeling"); i && i.focus(); });
      grid.appendChild(add);
    } else {
      var box = el("div", { class: "add-box" });
      var lab = el("label", { for: "new-feeling", class: "sr-only", text: "새 마음 단어" });
      var inp = el("input", { id: "new-feeling", type: "text", maxlength: "12", placeholder: "예) 조마조마함", autocomplete: "off" });
      var ok = el("button", { type: "button", text: "추가" });
      function commit() {
        var w = inp.value.trim().replace(/\s+/g, " ");
        pickAdding = false;
        if (w) {
          if (!state.dict.some(function (d) { return d.word === w && d.emo === c.emo; }) && c.words.indexOf(w) === -1) {
            state.dict.push({ word: w, emo: c.emo }); saveDict();
          }
          if (picked.indexOf(w) === -1) picked.push(w);
          sfxPop();
        }
        renderWords();
      }
      ok.addEventListener("click", commit);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) commit(); if (e.key === "Escape") { pickAdding = false; renderWords(); } });
      box.appendChild(lab); box.appendChild(inp); box.appendChild(ok);
      grid.appendChild(box);
    }
    // 왼쪽 목록
    var list = $("picked-list"); list.innerHTML = "";
    picked.forEach(function (w) { list.appendChild(el("span", { text: w })); });
    $("picked-empty").hidden = picked.length > 0;
    $("pick-hint").textContent = "여러 개 골라도 돼요 · " + picked.length + "개 선택";
    $("dict-count").textContent = "우리 반 마음 사전 · 새로 찾은 마음 " + state.dict.length + "개";
  }
  function collectPicks() {
    pickedFor(game.card).forEach(function (w) { if (game.allPicks.indexOf(w) === -1) game.allPicks.push(w); });
  }
  $("btn-to-talk").addEventListener("click", function () { pickAdding = false; game.talkIdx = 0; renderTalk(); go("talk"); });
  $("btn-next-from-pick").addEventListener("click", function () { pickAdding = false; collectPicks(); nextCard(); });

  /* ---------- 이야기 카드 ---------- */
  function renderTalk() {
    var c = game.card, i = game.talkIdx, d = TALK_DOMAINS[i];
    var picked = pickedFor(c);
    $("talk-context").textContent = c.text + (picked.length ? " · 고른 마음: " + picked.join(", ") : "");
    var tabs = $("talk-tabs"); tabs.innerHTML = "";
    TALK_DOMAINS.forEach(function (dd, j) {
      var b = el("button", { type: "button", class: "talk-tab" + (j === i ? " on" : ""), "aria-current": j === i ? "step" : null, style: "--tab-ink:" + DOMAIN_INK[j] });
      b.appendChild(el("small", { text: (j + 1) + " · " + dd.name }));
      b.appendChild(el("span", { text: dd.title }));
      b.addEventListener("click", function () { game.talkIdx = j; renderTalk(); });
      tabs.appendChild(b);
    });
    var dom = $("talk-domain"); dom.textContent = d.title; dom.style.background = DOMAIN_TINT[i];
    $("talk-step").textContent = (i + 1) + " / 4"; $("talk-step").style.color = DOMAIN_INK[i];
    var q = (c.questions && c.questions[i]) || "";
    if (!q) q = i === 0 ? DEFAULT_QUESTIONS[c.emo][0] : i === 3 ? DEFAULT_QUESTIONS[c.emo][1] : "이 상황에 대해 자유롭게 이야기해 볼까?";
    $("talk-q").textContent = q;
    $("talk-follow").textContent = d.follow;
    $("talk-follow-tag").style.background = DOMAIN_TINT[i];
    $("talk-follow-wrap").hidden = !d.follow;
    $("btn-talk-prev").hidden = i === 0;
    $("btn-talk-next").hidden = i === 3;
    $("btn-talk-done").hidden = i !== 3;
  }
  $("btn-talk-prev").addEventListener("click", function () { game.talkIdx = Math.max(0, game.talkIdx - 1); renderTalk(); });
  $("btn-talk-next").addEventListener("click", function () { game.talkIdx = Math.min(3, game.talkIdx + 1); renderTalk(); });
  $("btn-talk-done").addEventListener("click", function () { collectPicks(); nextCard(); });
  $("btn-talk-back").addEventListener("click", function () { renderPick(); go("pick"); });

  /* ---------- 끝 ---------- */
  function showEnd() {
    stopCamera();
    go("end");
    var total = game.deck.length, box = $("end-stars");
    box.innerHTML = "";
    for (var i = 0; i < total; i++) {
      var s = document.createElementNS(SVG_NS, "svg");
      s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
      s.setAttribute("class", i < game.stars ? "on" : "off");
      s.style.animationDelay = (i * 0.08) + "s";
      s.innerHTML = STAR_PATH;
      box.appendChild(s);
    }
    $("end-sub").textContent = "상황 카드 " + total + "장에서 별 " + game.stars + "개를 모으고, 마음 단어 " + game.allPicks.length + "개를 찾았어요.";
    var w = $("end-words"); w.innerHTML = "";
    game.allPicks.forEach(function (x) { w.appendChild(el("span", { text: x })); });
    confetti(70); sfxEnd();
    announce("우리 반 마음 챌린지 완성!");
  }
  $("btn-replay").addEventListener("click", startGame);

  /* =========================================================
     선생님용 카드·질문 목록
     ========================================================= */
  var ed = { tab: "joy", sel: null, confirm: false };

  function cardsOf(emo) { return state.cards.filter(function (c) { return c.emo === emo; }); }
  function findCard(id) { for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i]; return null; }
  function cardNum(c) { return state.cards.indexOf(c) + 1; }

  function renderCards() {
    // 설정
    $("set-count").value = String(state.settings.count);
    $("set-time").value = String(state.settings.time);
    $("set-level").value = String(state.settings.level);
    $("set-sound").checked = !!state.settings.sound;

    var used = state.cards.filter(function (c) { return c.used && c.text.trim(); }).length;
    $("used-count").textContent = "오늘 사용할 카드 " + used + "장";

    var tabs = $("emo-tabs"); tabs.innerHTML = "";
    EMO_KEYS.forEach(function (k) {
      var b = el("button", { type: "button", role: "tab", "aria-selected": ed.tab === k ? "true" : "false", text: EMOTIONS[k].label + " " + cardsOf(k).length });
      b.addEventListener("click", function () { ed.tab = k; ed.sel = null; ed.confirm = false; renderCards(); });
      tabs.appendChild(b);
    });

    var list = cardsOf(ed.tab);
    if (!ed.sel || !findCard(ed.sel) || findCard(ed.sel).emo !== ed.tab) ed.sel = list.length ? list[0].id : null;

    var box = $("cards-list"); box.innerHTML = "";
    list.forEach(function (c) {
      var row = el("div", { class: "card-row" });
      var tg = el("button", { type: "button", class: "use-toggle", "aria-pressed": c.used ? "true" : "false", "aria-label": c.used ? "오늘 사용함" : "오늘 사용 안 함" });
      tg.innerHTML = icon(ICON_CHECK);
      tg.addEventListener("click", function () { c.used = !c.used; saveCards(); renderCards(); });
      var it = el("button", { type: "button", class: "card-item" + (c.id === ed.sel ? " on" : "") + (c.used ? "" : " unused") });
      it.appendChild(el("small", { text: cardNum(c) + "번 · " + (c.place || "우리 반") + (c.isDefault ? "" : " · 직접 만든 카드") }));
      it.appendChild(el("span", { text: c.text || "새 카드 · 상황을 적어 주세요" }));
      it.addEventListener("click", function () { ed.sel = c.id; ed.confirm = false; renderCards(); });
      row.appendChild(tg); row.appendChild(it); box.appendChild(row);
    });

    renderEditor();
  }

  function renderEditor() {
    var c = ed.sel ? findCard(ed.sel) : null;
    $("empty-edit").hidden = !!c;
    if (!c) { $("edit-text").value = ""; $("edit-words").innerHTML = ""; $("edit-qs").innerHTML = ""; $("edit-foot").innerHTML = ""; return; }

    var ta = $("edit-text");
    ta.value = c.text;
    ta.oninput = function () { c.text = ta.value; saveCards(); var s = document.querySelector(".card-item.on span"); if (s) s.textContent = c.text || "새 카드 · 상황을 적어 주세요"; updateUsedCount(); };

    var wbox = $("edit-words"); wbox.innerHTML = "";
    c.words.forEach(function (w) {
      var chip = el("span", { class: "edit-word" }, [w]);
      var x = el("button", { type: "button", "aria-label": w + " 빼기" }); x.innerHTML = icon(ICON_X);
      x.addEventListener("click", function () { c.words = c.words.filter(function (y) { return y !== w; }); saveCards(); renderEditor(); });
      chip.appendChild(x); wbox.appendChild(chip);
    });
    var adder = el("span", { class: "word-adder" });
    var inp = el("input", { type: "text", id: "edit-new-word", placeholder: "단어 추가", maxlength: "12", "aria-label": "감정 단어 추가", autocomplete: "off" });
    var ab = el("button", { type: "button", "aria-label": "단어 추가" }); ab.innerHTML = icon(ICON_PLUS);
    function addW() { var w = inp.value.trim(); if (!w) return; if (c.words.indexOf(w) === -1) c.words.push(w); saveCards(); renderEditor(); var n = $("edit-new-word"); n && n.focus(); }
    ab.addEventListener("click", addW);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) addW(); });
    adder.appendChild(inp); adder.appendChild(ab); wbox.appendChild(adder);

    var qbox = $("edit-qs"); qbox.innerHTML = "";
    TALK_DOMAINS.forEach(function (d, i) {
      var id = "edit-q-" + i;
      var row = el("div", { class: "q-row" });
      var line = el("div", { class: "q-line" });
      line.appendChild(el("label", { for: id, text: d.name, style: "background:" + DOMAIN_TINT[i] }));
      var qi = el("input", { type: "text", id: id, autocomplete: "off" });
      qi.value = c.questions[i] || "";
      qi.addEventListener("input", function () { c.questions[i] = qi.value; saveCards(); });
      line.appendChild(qi);
      row.appendChild(line);
      row.appendChild(el("span", { class: "q-tip", text: "팁 · " + d.tip }));
      qbox.appendChild(row);
    });

    var foot = $("edit-foot"); foot.innerHTML = "";
    if (!ed.confirm) {
      var del = el("button", { type: "button", class: "btn-del" }); del.innerHTML = icon(ICON_TRASH) + "카드 삭제";
      del.addEventListener("click", function () { ed.confirm = true; renderEditor(); });
      foot.appendChild(del);
      if (c.isDefault) {
        var rs = el("button", { type: "button", class: "link-btn", text: "기본값으로 되돌리기" });
        rs.addEventListener("click", function () {
          var d = defaultById(c.id); if (!d) return;
          c.text = d.text; c.words = d.words; c.questions = d.questions; c.place = d.place;
          saveCards(); renderCards();
        });
        foot.appendChild(rs);
      }
    } else {
      var cf = el("div", { class: "confirm-del" });
      cf.appendChild(el("span", { text: cardNum(c) + "번 카드를 지울까요?" }));
      var yes = el("button", { type: "button", class: "yes", text: "지우기" });
      var no = el("button", { type: "button", class: "no", text: "취소" });
      yes.addEventListener("click", function () {
        state.cards = state.cards.filter(function (x) { return x !== c; });
        if (c.isDefault && state.deleted.indexOf(c.id) === -1) state.deleted.push(c.id);
        ed.sel = null; ed.confirm = false; saveCards(); renderCards();
      });
      no.addEventListener("click", function () { ed.confirm = false; renderEditor(); });
      cf.appendChild(yes); cf.appendChild(no); foot.appendChild(cf);
    }
    foot.appendChild(el("span", { class: "spacer" }));
    var sv = el("span", { class: "saved" }); sv.innerHTML = icon(ICON_CHECK) + "자동 저장 · 이 기기에만 저장돼요";
    foot.appendChild(sv);
  }
  function updateUsedCount() {
    var used = state.cards.filter(function (c) { return c.used && c.text.trim(); }).length;
    $("used-count").textContent = "오늘 사용할 카드 " + used + "장";
  }

  $("btn-new-card").addEventListener("click", function () {
    var n = 1; while (findCard("u" + n)) n++;
    var dq = DEFAULT_QUESTIONS[ed.tab];
    var base = {
      joy: ["기쁨", "뿌듯함", "신남", "설렘", "고마움", "행복함"],
      surprise: ["깜짝 놀람", "당황함", "신기함", "어리둥절함", "설렘", "걱정됨"],
      sad: ["속상함", "서운함", "아쉬움", "실망스러움", "슬픔", "외로움"],
      angry: ["화남", "억울함", "답답함", "짜증남", "서운함", "불공평함"]
    }[ed.tab];
    var card = { id: "u" + n, emo: ed.tab, place: "우리 반", text: "", words: base.slice(), used: true, isDefault: false,
      questions: [dq[0], "친구가 이런 마음일 때 어떤 말을 해 줄 수 있을까?", "우리 반은 이럴 때 어떻게 서로 도울 수 있을까?", dq[1]] };
    state.cards.push(card);
    ed.sel = card.id; ed.confirm = false; saveCards(); renderCards();
    var t = $("edit-text"); t && t.focus();
  });
  $("btn-restore-all").addEventListener("click", function () {
    var added = 0;
    DEFAULT_CARDS.forEach(function (c) {
      if (!findCard(c.id)) { state.cards.push(resolveDefault(c)); added++; }
    });
    // 기본 카드 순서대로 정렬 (직접 만든 카드는 뒤에)
    var order = DEFAULT_CARDS.map(function (c) { return c.id; });
    state.cards.sort(function (a, b) {
      var ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      if (ia === -1) ia = 999; if (ib === -1) ib = 999; return ia - ib;
    });
    state.deleted = []; saveCards(); renderCards();
    openModal("기본 카드 되살리기", "<p>" + (added ? "지웠던 기본 카드 " + added + "장을 다시 넣었어요." : "지운 기본 카드가 없어요. 모든 기본 카드가 그대로 있어요.") + "</p><p>고친 내용은 그대로 두었어요. 카드 하나를 원래대로 돌리려면 그 카드의 <b>기본값으로 되돌리기</b>를 눌러 주세요.</p>");
  });

  ["count", "time", "level"].forEach(function (k) {
    $("set-" + k).addEventListener("change", function (e) { state.settings[k] = Number(e.target.value); saveSettings(); });
  });
  $("set-sound").addEventListener("change", function (e) { state.settings.sound = e.target.checked; saveSettings(); if (e.target.checked) sfxPop(); });

  /* =========================================================
     모달 · QR · 라이선스
     ========================================================= */
  var lastFocus = null;
  function openModal(title, html) {
    lastFocus = document.activeElement;
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = html;
    $("modal").hidden = false;
    $("modal-close").focus();
  }
  function closeModal() { $("modal").hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $("modal-close").addEventListener("click", closeModal);
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });

  function openQR() {
    var url = location.href.split("#")[0].replace(/[?&]demo=1/, "");
    if (location.protocol === "file:") {
      openModal("폰·태블릿으로 열기", "<p>지금은 컴퓨터에 저장된 파일로 열려 있어서 QR 코드를 만들 수 없어요.</p><p>GitHub Pages에 올린 뒤 그 주소에서 다시 눌러 주세요.</p>");
      return;
    }
    openModal("폰·태블릿으로 열기", '<div class="qr-box"><div id="qr-holder">QR 코드를 만드는 중…</div><p class="qr-url"></p><p class="muted-small">카메라 앱으로 찍으면 바로 열려요. 사파리·크롬에서 카메라 권한을 허용해 주세요.</p></div>');
    document.querySelector(".qr-url").textContent = url;
    function draw() {
      try {
        var qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
        $("qr-holder").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      } catch (e) { $("qr-holder").textContent = "QR 코드를 만들지 못했어요. 위 주소를 직접 입력해 주세요."; }
    }
    if (window.qrcode) { draw(); return; }
    var s = document.createElement("script");
    s.src = QR_LIB; s.onload = draw;
    s.onerror = function () { $("qr-holder").textContent = "QR 코드를 불러오지 못했어요. 아래 주소를 직접 입력해 주세요."; };
    document.head.appendChild(s);
  }

  function openLicenses() {
    openModal("오픈소스 라이선스",
      "<p>표정 챌린지는 아래 오픈소스를 사용해요. 카메라 영상과 얼굴 정보는 이 기기 안에서만 처리되고 어디에도 저장·전송되지 않아요.</p>" +
      "<h3>MediaPipe Tasks Vision · Face Landmarker 모델</h3><p>© Google LLC · Apache License 2.0 · <a href=\"https://github.com/google-ai-edge/mediapipe\" target=\"_blank\" rel=\"noopener\">github.com/google-ai-edge/mediapipe</a></p>" +
      "<h3>Jua 글꼴</h3><p>© Woowahan Brothers · SIL Open Font License 1.1 · Google Fonts</p>" +
      "<h3>Noto Sans KR 글꼴</h3><p>© Google · SIL Open Font License 1.1 · Google Fonts</p>" +
      "<h3>qrcode-generator</h3><p>© Kazuhiko Arase · MIT License</p>" +
      "<p class=\"muted-small\">전체 고지문은 프로젝트의 THIRD_PARTY_NOTICES.md 파일에 있어요.</p>");
  }

  /* ---------- 탭이 숨겨지면 카메라 아끼기 ---------- */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopTimer();
  });

  /* ---------- 시작 ---------- */
  startCover();
  initDebug();
  if (DEMO) document.title = "[테스트] " + document.title;
  if (DEBUG) document.title = "[측정] " + document.title;
})();
