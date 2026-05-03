// 英タンゴ復習するンゴ - Web Speech API で読み上げる単語帳 PWA

const SETTINGS_KEY = "vocab-pwa.settings.v1";
const DEFAULT_SETTINGS = {
  enVoiceURI: "",
  jaVoiceURI: "",
  rate: 1.0,
  pauseMs: 600,
  speakMeaning: true,
  speakExample: true,
  speakExampleJa: true,
  repeatWord: 2,
  wakeLock: true,
  repeatPlaylist: false,
  shuffle: false,
  autoAdvance: true,
  // "auto" : pre-generated audio if available, else Web Speech.
  // "file" : force pre-generated audio (no fallback).
  // "tts"  : force Web Speech API.
  audioSource: "auto",
};

let settings = { ...DEFAULT_SETTINGS };
let voices = [];
let currentEntries = [];
let currentFileLabel = "";
let currentFileStem = "";
let currentAudioManifest = null;
let wakeLockSentinel = null;
let silentAudio = null;
let silentAudioStarted = false;

// ---------- Markdown parser ----------

/**
 * Parse vocabulary markdown into entries.
 * Supported entry format:
 *   **word**：meaning
 *
 *   例）example sentence
 *   訳）日本語訳
 *
 * Tolerates: half/full-width colons and parens, multiple examples,
 * "例文)", "例1)", "Example:", parenthetical translation on the same
 * line as 例), section headings (## ...), and notes.
 *
 * Each example is { en: string, ja: string } where ja may be "".
 */

// CJK / kana detector — used to split inline "(訳)" tails from English.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

function splitInlineTranslation(text) {
  // "English. (日本語訳。)" or "English. （日本語訳。）"
  const m = text.match(/^(.*?)\s*[（(]\s*([^()（）]*?)\s*[）)]\s*$/);
  if (m && CJK_RE.test(m[2])) {
    return { en: m[1].trim(), ja: m[2].trim() };
  }
  return { en: text.trim(), ja: "" };
}

function parseVocab(md) {
  const entries = [];
  const lines = md.split(/\r?\n/);
  let current = null;
  let currentSection = "";
  let lastWasExample = false;

  const finalize = () => {
    if (current && current.word) entries.push(current);
    current = null;
    lastWasExample = false;
  };

  const pushExample = (text) => {
    const split = splitInlineTranslation(text);
    if (split.en) {
      current.examples.push({ en: split.en, ja: split.ja });
      lastWasExample = true;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Section heading (## Day 1 etc.)
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) {
      finalize();
      currentSection = h[1].trim();
      continue;
    }

    // **word**：meaning   (full or half width colon)
    const headed = line.match(/^\*\*\s*([^*]+?)\s*\*\*\s*[:：]?\s*(.*)$/);
    if (headed) {
      finalize();
      current = {
        word: headed[1].trim(),
        meaning: headed[2].trim(),
        examples: [],
        notes: [],
        section: currentSection,
      };
      lastWasExample = false;
      continue;
    }

    if (!current) continue;

    // 訳）/ 訳: / Translation: / Tr:
    const tr = line.match(
      /^(?:訳|和訳|日本語訳|Translation|Trans|Tr)\s*[）)\]:：]\s*(.+)$/i
    );
    if (tr && current.examples.length) {
      const last = current.examples[current.examples.length - 1];
      if (!last.ja) last.ja = tr[1].trim();
      else last.ja += " " + tr[1].trim();
      continue;
    }

    // Example: 例）..., 例文), 例1）, Example:, Ex:
    const ex = line.match(
      /^(?:例(?:文)?\s*\d*|Example|Ex)\s*[）)\]:：]\s*(.*)$/i
    );
    if (ex) {
      const text = ex[1].trim();
      if (text) pushExample(text);
      continue;
    }

    // Bullet of example (- example: ... or - 例: ...)
    const bulletEx = line.match(
      /^[-*]\s+(?:例(?:文)?|Example|Ex)\s*[）)\]:：]\s*(.+)$/i
    );
    if (bulletEx) {
      pushExample(bulletEx[1].trim());
      continue;
    }

    // - 意味: ... line
    const bulletMeaning = line.match(
      /^[-*]\s+(?:意味|Meaning|意)\s*[）)\]:：]\s*(.+)$/i
    );
    if (bulletMeaning) {
      if (!current.meaning) current.meaning = bulletMeaning[1].trim();
      else current.notes.push(bulletMeaning[1].trim());
      lastWasExample = false;
      continue;
    }

    // Continuation right after 例) line — if the line is mostly Japanese,
    // treat it as the translation of the last example.
    if (lastWasExample && current.examples.length) {
      const last = current.examples[current.examples.length - 1];
      if (!last.ja && CJK_RE.test(line)) {
        last.ja = line;
        continue;
      }
    }

    // No meaning yet → take this line as meaning
    if (!current.meaning) {
      current.meaning = line;
      lastWasExample = false;
      continue;
    }

    // Otherwise treat as a note
    current.notes.push(line);
    lastWasExample = false;
  }

  finalize();
  return entries;
}

// ---------- File loading ----------

async function loadIndex() {
  try {
    const res = await fetch("vocab/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("index.json not found");
    const data = await res.json();
    if (!Array.isArray(data.files)) throw new Error("invalid index.json");
    return data.files;
  } catch (err) {
    console.warn("Failed to load index.json:", err);
    return [];
  }
}

async function loadVocabFile(path) {
  const res = await fetch(`vocab/${path}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  const md = await res.text();
  return parseVocab(md);
}

async function loadAudioManifest(stem) {
  // Audio assets generated by scripts/generate_audio.py and committed by CI.
  // Returns null if no manifest exists for this file (e.g. local dev before CI ran).
  try {
    const res = await fetch(`vocab/audio/${encodeURIComponent(stem)}/manifest.json`, {
      cache: "no-cache",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.entries)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// ---------- Settings ----------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------- Voices ----------

function loadVoices() {
  return new Promise((resolve) => {
    const initial = speechSynthesis.getVoices();
    if (initial.length) {
      voices = initial;
      return resolve(voices);
    }
    speechSynthesis.onvoiceschanged = () => {
      voices = speechSynthesis.getVoices();
      resolve(voices);
    };
  });
}

function pickVoice(lang) {
  const stored =
    lang.startsWith("en") ? settings.enVoiceURI : settings.jaVoiceURI;
  if (stored) {
    const v = voices.find((v) => v.voiceURI === stored);
    if (v) return v;
  }
  // Prefer matching lang
  const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  if (candidates.length === 0) return null;
  // Prefer local
  return candidates.find((v) => v.localService) || candidates[0];
}

// ---------- Speech ----------

let speakAbortToken = 0;
let currentAudioEl = null;

function speakTTS(text, lang) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    const myToken = speakAbortToken;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = settings.rate;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    if (myToken !== speakAbortToken) return resolve();
    speechSynthesis.speak(u);
  });
}

function playAudioFile(relPath) {
  // Plays a pre-generated mp3 located under vocab/audio/<stem>/.
  // Resolves on `ended` / `error` / when aborted.
  return new Promise((resolve) => {
    if (!relPath || !currentFileStem) return resolve();
    const myToken = speakAbortToken;
    const url = `vocab/audio/${encodeURIComponent(currentFileStem)}/${relPath}`;
    const el = document.getElementById("playbackAudio");
    if (!el) return resolve();
    currentAudioEl = el;
    const cleanup = () => {
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("error", onEnd);
      if (currentAudioEl === el) currentAudioEl = null;
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    el.addEventListener("ended", onEnd);
    el.addEventListener("error", onEnd);
    el.src = url;
    el.playbackRate = settings.rate;
    if (myToken !== speakAbortToken) {
      cleanup();
      return resolve();
    }
    el.play().catch(() => {
      cleanup();
      resolve();
    });
  });
}

function speak(text, lang) {
  // Routed by player; kept for back-compat when no manifest is loaded.
  return speakTTS(text, lang);
}

function abortSpeak() {
  speakAbortToken++;
  try {
    speechSynthesis.cancel();
  } catch (_) {}
  if (currentAudioEl) {
    try {
      currentAudioEl.pause();
      currentAudioEl.removeAttribute("src");
      currentAudioEl.load();
    } catch (_) {}
    currentAudioEl = null;
  }
}

function audioModeForCurrent() {
  if (settings.audioSource === "tts") return "tts";
  if (currentAudioManifest) return "file";
  if (settings.audioSource === "file") return "file"; // forced but no manifest -> still try
  return "tts";
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    sleep._cancel = () => {
      clearTimeout(t);
      resolve();
    };
  });

// ---------- Player ----------

const player = {
  entries: [],
  order: [],
  cursor: 0,
  playing: false,
  abortRun: 0,

  load(entries) {
    this.entries = entries;
    this.rebuildOrder();
    this.cursor = 0;
    this.render();
  },

  rebuildOrder() {
    const n = this.entries.length;
    this.order = [...Array(n).keys()];
    if (settings.shuffle) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
    }
  },

  current() {
    if (!this.entries.length) return null;
    const idx = this.order[this.cursor];
    return this.entries[idx];
  },

  render() {
    const e = this.current();
    const wordEl = document.getElementById("wordText");
    const meaningEl = document.getElementById("meaningText");
    const exampleEl = document.getElementById("exampleText");
    const exampleJaEl = document.getElementById("exampleJaText");
    const posEl = document.getElementById("positionText");
    const fillEl = document.getElementById("progressFill");
    if (e) {
      wordEl.textContent = e.word;
      meaningEl.textContent = e.meaning || "　";
      const first = e.examples[0];
      exampleEl.textContent = first?.en || "　";
      exampleJaEl.textContent = first?.ja || "　";
    } else {
      wordEl.textContent = "—";
      meaningEl.textContent = "　";
      exampleEl.textContent = "　";
      exampleJaEl.textContent = "　";
    }
    const total = this.entries.length;
    posEl.textContent = `${this.cursor + 1} / ${total}`;
    fillEl.style.width = total ? `${((this.cursor + 1) / total) * 100}%` : "0%";

    // active highlight in word list
    document.querySelectorAll("#wordList li").forEach((li, i) => {
      li.classList.toggle("active", i === this.cursor);
    });

    // play button label
    document.getElementById("playBtn").textContent = this.playing ? "⏸" : "▶";

    updateMediaSession();
  },

  audioFor(idx) {
    // Returns the manifest entry's audio paths, or null when unavailable.
    // Per-entry word match guards against stale manifests (md updated locally
    // before CI regenerated audio): mismatched entries fall back to TTS.
    if (!currentAudioManifest) return null;
    const m = currentAudioManifest.entries[idx];
    if (!m || !m.audio) return null;
    const live = this.entries[idx];
    if (live && m.word && live.word !== m.word) return null;
    return m.audio;
  },

  async speakSegment(text, lang, audioRel) {
    // Use pre-generated mp3 when available + allowed; otherwise Web Speech.
    if (audioRel && audioModeForCurrent() === "file") {
      await playAudioFile(audioRel);
    } else {
      await speakTTS(text, lang);
    }
  },

  async play() {
    if (this.playing) return;
    if (!this.entries.length) return;
    this.playing = true;
    // Start silent audio FIRST (within the user gesture) so the browser
    // grants playback. This unlocks background speech on mobile.
    await startSilentAudio();
    this.render();
    await acquireWakeLock();
    setupMediaSession();

    const myRun = ++this.abortRun;

    while (this.playing && myRun === this.abortRun) {
      const e = this.current();
      if (!e) break;
      this.render(); // render() invokes updateMediaSession() for lock-screen metadata

      const idx = this.order[this.cursor];
      const a = this.audioFor(idx);

      // Word (repeat N times)
      for (let r = 0; r < settings.repeatWord; r++) {
        if (myRun !== this.abortRun || !this.playing) break;
        await this.speakSegment(e.word, "en-US", a?.word);
        if (r < settings.repeatWord - 1) await sleep(Math.min(settings.pauseMs, 400));
      }

      if (settings.speakMeaning && e.meaning && this.playing && myRun === this.abortRun) {
        await sleep(settings.pauseMs);
        await this.speakSegment(e.meaning, "ja-JP", a?.meaning);
      }

      if (settings.speakExample && e.examples.length && this.playing && myRun === this.abortRun) {
        await sleep(settings.pauseMs);
        for (let i = 0; i < e.examples.length; i++) {
          if (myRun !== this.abortRun || !this.playing) break;
          const ex = e.examples[i];
          const exA = a?.examples?.[i];
          await this.speakSegment(ex.en, "en-US", exA?.en);
          if (settings.speakExampleJa && ex.ja && this.playing && myRun === this.abortRun) {
            await sleep(Math.min(settings.pauseMs, 400));
            await this.speakSegment(ex.ja, "ja-JP", exA?.ja);
          }
          await sleep(Math.min(settings.pauseMs, 400));
        }
      }

      if (myRun !== this.abortRun || !this.playing) break;

      if (!settings.autoAdvance) {
        this.playing = false;
        this.render();
        break;
      }

      await sleep(settings.pauseMs);

      // advance
      if (this.cursor + 1 >= this.entries.length) {
        if (settings.repeatPlaylist) {
          this.cursor = 0;
          if (settings.shuffle) this.rebuildOrder();
        } else {
          this.playing = false;
          this.render();
          break;
        }
      } else {
        this.cursor++;
      }
    }

    releaseWakeLock();
    stopSilentAudio();
    clearMediaSession();
    this.playing = false;
    this.render();
  },

  pause() {
    this.playing = false;
    this.abortRun++;
    abortSpeak();
    sleep._cancel?.();
    releaseWakeLock();
    stopSilentAudio();
    this.render();
  },

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  },

  next() {
    const wasPlaying = this.playing;
    this.pause();
    if (this.cursor + 1 < this.entries.length) {
      this.cursor++;
    } else if (settings.repeatPlaylist) {
      this.cursor = 0;
      if (settings.shuffle) this.rebuildOrder();
    }
    this.render();
    if (wasPlaying) this.play();
  },

  prev() {
    const wasPlaying = this.playing;
    this.pause();
    if (this.cursor > 0) this.cursor--;
    this.render();
    if (wasPlaying) this.play();
  },

  jumpTo(i) {
    const wasPlaying = this.playing;
    this.pause();
    this.cursor = Math.max(0, Math.min(i, this.entries.length - 1));
    this.render();
    if (wasPlaying) this.play();
  },
};

// ---------- MediaSession (lock-screen / background controls) ----------
//
// Only meaningful when we're playing real <audio> elements (file mode).
// Web Speech API does not surface to MediaSession on any platform.

let mediaSessionReady = false;

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  if (mediaSessionReady) return;
  mediaSessionReady = true;

  navigator.mediaSession.setActionHandler("play", () => {
    if (!player.playing) player.play();
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (player.playing) player.pause();
  });
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  // 5s skips don't really fit a vocab player; alias them to track skip.
  try {
    navigator.mediaSession.setActionHandler("seekforward", () => player.next());
    navigator.mediaSession.setActionHandler("seekbackward", () => player.prev());
  } catch (_) {}
}

function clearMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = "paused";
  } catch (_) {}
}

// ---------- Wake lock ----------

async function acquireWakeLock() {
  if (!settings.wakeLock || !("wakeLock" in navigator)) return;
  if (wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

// ---------- Background audio (silent loop) ----------
// Mobile browsers suspend speechSynthesis when the tab is backgrounded.
// Playing a silent audio loop signals "media is playing" so the browser
// keeps the tab active and the OS shows lock-screen controls.

function makeSilentWavDataURL() {
  const sampleRate = 8000;
  const numSamples = 800; // 0.1s
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  // RIFF header
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + numSamples * 2, true);
  view.setUint32(8, 0x57415645, false);
  // fmt chunk
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  // data chunk (samples are zero-initialised = silence)
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, numSamples * 2, true);
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(binary);
}

function ensureSilentAudio() {
  if (silentAudio) return silentAudio;
  silentAudio = new Audio(makeSilentWavDataURL());
  silentAudio.loop = true;
  silentAudio.preload = "auto";
  // Some browsers ignore volume 0; a tiny non-zero value is safer.
  silentAudio.volume = 0.001;
  return silentAudio;
}

async function startSilentAudio() {
  const a = ensureSilentAudio();
  try {
    await a.play();
    silentAudioStarted = true;
  } catch (_) {}
}

function stopSilentAudio() {
  if (silentAudio) silentAudio.pause();
  silentAudioStarted = false;
}

// ---------- MediaSession metadata refresh (called from player.render) ----------

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const e = player.current();
  try {
    if (e && "MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: e.word || "—",
        artist: e.meaning || "",
        album: currentFileLabel || "英タンゴ復習するンゴ",
        artwork: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    }
    navigator.mediaSession.playbackState = player.playing ? "playing" : "paused";
  } catch (_) {}
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && player.playing) {
    await acquireWakeLock();
    // Re-kick silent audio in case the OS paused it on visibility change.
    if (silentAudio && silentAudio.paused) {
      try { await silentAudio.play(); } catch (_) {}
    }
  }
});

// ---------- Views ----------

function showView(name) {
  ["fileListView", "playerView", "settingsView"].forEach((id) => {
    document.getElementById(id).hidden = id !== `${name}View`;
  });
  document.getElementById("backBtn").hidden = name === "fileList";
  const titles = {
    fileList: "英タンゴ復習するンゴ",
    player: currentFileLabel || "再生",
    settings: "設定",
  };
  document.getElementById("title").textContent = titles[name] || titles.fileList;
}

// ---------- File list ----------

async function renderFileList() {
  const files = await loadIndex();
  const ul = document.getElementById("fileList");
  ul.innerHTML = "";
  const empty = document.getElementById("fileListEmpty");

  if (!files.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const file of files) {
    const path = typeof file === "string" ? file : file.path;
    const label = (typeof file === "object" && file.label) || path.replace(/\.md$/i, "");
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="label"></span><span class="count" data-count></span>`;
    btn.querySelector(".label").textContent = label;
    btn.addEventListener("click", async () => {
      try {
        const stem = path.replace(/\.md$/i, "");
        const [entries, manifest] = await Promise.all([
          loadVocabFile(path),
          loadAudioManifest(stem),
        ]);
        if (!entries.length) {
          alert("この単語ファイルから単語を抽出できませんでした。フォーマットをご確認ください。");
          return;
        }
        currentEntries = entries;
        currentFileLabel = label;
        currentFileStem = stem;
        currentAudioManifest = manifest;
        player.load(entries);
        renderWordList();
        showView("player");
        updateAudioSourceBadge();
      } catch (e) {
        alert(`ファイルの読み込みに失敗しました: ${e.message}`);
      }
    });
    li.appendChild(btn);
    ul.appendChild(li);

    // load count lazily
    loadVocabFile(path).then((entries) => {
      btn.querySelector(".count").textContent = `${entries.length} 単語`;
    }).catch(() => {});
  }
}

function renderWordList() {
  const ol = document.getElementById("wordList");
  ol.innerHTML = "";
  player.entries.forEach((e, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num"></span><span></span>`;
    li.children[0].textContent = `${i + 1}.`;
    li.children[1].textContent = `${e.word}  ${e.meaning ? "—  " + e.meaning : ""}`;
    li.addEventListener("click", () => player.jumpTo(i));
    ol.appendChild(li);
  });
}

// ---------- Settings UI ----------

function fillVoiceOptions() {
  const enSel = document.getElementById("enVoice");
  const jaSel = document.getElementById("jaVoice");
  enSel.innerHTML = "";
  jaSel.innerHTML = "";
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const ja = voices.filter((v) => v.lang.toLowerCase().startsWith("ja"));
  const fill = (sel, list, current) => {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "（自動）";
    sel.appendChild(empty);
    for (const v of list) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})${v.localService ? " - local" : ""}`;
      if (v.voiceURI === current) opt.selected = true;
      sel.appendChild(opt);
    }
  };
  fill(enSel, en, settings.enVoiceURI);
  fill(jaSel, ja, settings.jaVoiceURI);
}

function applySettingsToUI() {
  document.getElementById("rate").value = settings.rate;
  document.getElementById("rateLabel").textContent = settings.rate.toFixed(2);
  document.getElementById("pauseMs").value = settings.pauseMs;
  document.getElementById("pauseLabel").textContent = settings.pauseMs;
  document.getElementById("speakMeaning").checked = settings.speakMeaning;
  document.getElementById("speakExample").checked = settings.speakExample;
  document.getElementById("speakExampleJa").checked = settings.speakExampleJa;
  document.getElementById("repeatWord").value = String(settings.repeatWord);
  document.getElementById("wakeLock").checked = settings.wakeLock;
  document.getElementById("audioSource").value = settings.audioSource;
  document.getElementById("repeatBtn").setAttribute("aria-pressed", String(settings.repeatPlaylist));
  document.getElementById("shuffleBtn").setAttribute("aria-pressed", String(settings.shuffle));
  document.getElementById("autoBtn").setAttribute("aria-pressed", String(settings.autoAdvance));
}

function updateAudioSourceBadge() {
  const el = document.getElementById("audioSourceBadge");
  if (!el) return;
  const mode = audioModeForCurrent();
  if (mode === "file" && currentAudioManifest) {
    el.textContent = "🎵 事前生成音声 (ロック画面再生対応)";
    el.dataset.mode = "file";
  } else {
    el.textContent = "🗣 端末TTS (画面ON必須)";
    el.dataset.mode = "tts";
  }
}

function bindSettingsControls() {
  document.getElementById("enVoice").addEventListener("change", (e) => {
    settings.enVoiceURI = e.target.value;
    saveSettings();
  });
  document.getElementById("jaVoice").addEventListener("change", (e) => {
    settings.jaVoiceURI = e.target.value;
    saveSettings();
  });
  document.getElementById("rate").addEventListener("input", (e) => {
    settings.rate = parseFloat(e.target.value);
    document.getElementById("rateLabel").textContent = settings.rate.toFixed(2);
    saveSettings();
  });
  document.getElementById("pauseMs").addEventListener("input", (e) => {
    settings.pauseMs = parseInt(e.target.value, 10);
    document.getElementById("pauseLabel").textContent = settings.pauseMs;
    saveSettings();
  });
  document.getElementById("speakMeaning").addEventListener("change", (e) => {
    settings.speakMeaning = e.target.checked;
    saveSettings();
  });
  document.getElementById("speakExample").addEventListener("change", (e) => {
    settings.speakExample = e.target.checked;
    saveSettings();
  });
  document.getElementById("speakExampleJa").addEventListener("change", (e) => {
    settings.speakExampleJa = e.target.checked;
    saveSettings();
  });
  document.getElementById("repeatWord").addEventListener("change", (e) => {
    settings.repeatWord = parseInt(e.target.value, 10);
    saveSettings();
  });
  document.getElementById("wakeLock").addEventListener("change", (e) => {
    settings.wakeLock = e.target.checked;
    saveSettings();
  });
  document.getElementById("audioSource").addEventListener("change", (e) => {
    settings.audioSource = e.target.value;
    saveSettings();
    updateAudioSourceBadge();
  });
}

// ---------- Init ----------

async function init() {
  loadSettings();
  applySettingsToUI();
  bindSettingsControls();

  await loadVoices();
  fillVoiceOptions();

  document.getElementById("backBtn").addEventListener("click", () => {
    player.pause();
    showView("fileList");
  });
  document.getElementById("settingsBtn").addEventListener("click", () => {
    showView("settings");
  });

  document.getElementById("playBtn").addEventListener("click", () => player.toggle());
  document.getElementById("nextBtn").addEventListener("click", () => player.next());
  document.getElementById("prevBtn").addEventListener("click", () => player.prev());

  const repeatBtn = document.getElementById("repeatBtn");
  repeatBtn.addEventListener("click", () => {
    settings.repeatPlaylist = !settings.repeatPlaylist;
    repeatBtn.setAttribute("aria-pressed", String(settings.repeatPlaylist));
    saveSettings();
  });
  const shuffleBtn = document.getElementById("shuffleBtn");
  shuffleBtn.addEventListener("click", () => {
    settings.shuffle = !settings.shuffle;
    shuffleBtn.setAttribute("aria-pressed", String(settings.shuffle));
    player.rebuildOrder();
    player.cursor = 0;
    player.render();
    renderWordList();
    saveSettings();
  });
  const autoBtn = document.getElementById("autoBtn");
  autoBtn.addEventListener("click", () => {
    settings.autoAdvance = !settings.autoAdvance;
    autoBtn.setAttribute("aria-pressed", String(settings.autoAdvance));
    saveSettings();
  });

  setupMediaSession();

  await renderFileList();
  showView("fileList");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
