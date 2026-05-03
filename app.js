// 英単語リスナー - Web Speech API で読み上げる単語帳 PWA

const SETTINGS_KEY = "vocab-pwa.settings.v1";
const DEFAULT_SETTINGS = {
  enVoiceURI: "",
  jaVoiceURI: "",
  rate: 1.0,
  pauseMs: 600,
  speakMeaning: true,
  speakExample: true,
  repeatWord: 2,
  wakeLock: true,
  repeatPlaylist: false,
  shuffle: false,
  autoAdvance: true,
};

let settings = { ...DEFAULT_SETTINGS };
let voices = [];
let currentEntries = [];
let currentFileLabel = "";
let wakeLockSentinel = null;

// ---------- Markdown parser ----------

/**
 * Parse vocabulary markdown into entries.
 * Supported entry format:
 *   **word**：meaning
 *
 *   例）example sentence
 *
 * Tolerates: half/full-width colons and parens, multiple examples,
 * "例文)", "例1)", "Example:", section headings (## ...), and notes.
 */
function parseVocab(md) {
  const entries = [];
  const lines = md.split(/\r?\n/);
  let current = null;
  let currentSection = "";

  const finalize = () => {
    if (current && current.word) entries.push(current);
    current = null;
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
      continue;
    }

    if (!current) continue;

    // Example: 例）..., 例文), 例1）, Example:, Ex:
    const ex = line.match(
      /^(?:例(?:文)?\s*\d*|Example|Ex)\s*[）)\]:：]\s*(.*)$/i
    );
    if (ex) {
      const text = ex[1].trim();
      if (text) current.examples.push(text);
      continue;
    }

    // Bullet of example (- example: ... or - 例: ...)
    const bulletEx = line.match(
      /^[-*]\s+(?:例(?:文)?|Example|Ex)\s*[）)\]:：]\s*(.+)$/i
    );
    if (bulletEx) {
      current.examples.push(bulletEx[1].trim());
      continue;
    }

    // - 意味: ... line
    const bulletMeaning = line.match(
      /^[-*]\s+(?:意味|Meaning|意)\s*[）)\]:：]\s*(.+)$/i
    );
    if (bulletMeaning) {
      if (!current.meaning) current.meaning = bulletMeaning[1].trim();
      else current.notes.push(bulletMeaning[1].trim());
      continue;
    }

    // No meaning yet → take this line as meaning
    if (!current.meaning) {
      current.meaning = line;
      continue;
    }

    // Otherwise treat as a note (append to last example if it looks like a continuation)
    current.notes.push(line);
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

function speak(text, lang) {
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
    // If aborted before we even start
    if (myToken !== speakAbortToken) return resolve();
    speechSynthesis.speak(u);
  });
}

function abortSpeak() {
  speakAbortToken++;
  speechSynthesis.cancel();
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
    const posEl = document.getElementById("positionText");
    const fillEl = document.getElementById("progressFill");
    if (e) {
      wordEl.textContent = e.word;
      meaningEl.textContent = e.meaning || "　";
      exampleEl.textContent = e.examples[0] || "　";
    } else {
      wordEl.textContent = "—";
      meaningEl.textContent = "　";
      exampleEl.textContent = "　";
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
  },

  async play() {
    if (this.playing) return;
    if (!this.entries.length) return;
    this.playing = true;
    this.render();
    await acquireWakeLock();

    const myRun = ++this.abortRun;

    while (this.playing && myRun === this.abortRun) {
      const e = this.current();
      if (!e) break;
      this.render();

      // Word (repeat N times)
      for (let r = 0; r < settings.repeatWord; r++) {
        if (myRun !== this.abortRun || !this.playing) break;
        await speak(e.word, "en-US");
        if (r < settings.repeatWord - 1) await sleep(Math.min(settings.pauseMs, 400));
      }

      if (settings.speakMeaning && e.meaning && this.playing && myRun === this.abortRun) {
        await sleep(settings.pauseMs);
        await speak(e.meaning, "ja-JP");
      }

      if (settings.speakExample && e.examples.length && this.playing && myRun === this.abortRun) {
        await sleep(settings.pauseMs);
        for (const ex of e.examples) {
          if (myRun !== this.abortRun || !this.playing) break;
          await speak(ex, "en-US");
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
    this.playing = false;
    this.render();
  },

  pause() {
    this.playing = false;
    this.abortRun++;
    abortSpeak();
    sleep._cancel?.();
    releaseWakeLock();
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

// ---------- Wake lock ----------

async function acquireWakeLock() {
  if (!settings.wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && player.playing) {
    await acquireWakeLock();
  }
});

// ---------- Views ----------

function showView(name) {
  ["fileListView", "playerView", "settingsView"].forEach((id) => {
    document.getElementById(id).hidden = id !== `${name}View`;
  });
  document.getElementById("backBtn").hidden = name === "fileList";
  const titles = {
    fileList: "英単語リスナー",
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
        const entries = await loadVocabFile(path);
        if (!entries.length) {
          alert("この単語ファイルから単語を抽出できませんでした。フォーマットをご確認ください。");
          return;
        }
        currentEntries = entries;
        currentFileLabel = label;
        player.load(entries);
        renderWordList();
        showView("player");
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
  document.getElementById("repeatWord").value = String(settings.repeatWord);
  document.getElementById("wakeLock").checked = settings.wakeLock;
  document.getElementById("repeatBtn").setAttribute("aria-pressed", String(settings.repeatPlaylist));
  document.getElementById("shuffleBtn").setAttribute("aria-pressed", String(settings.shuffle));
  document.getElementById("autoBtn").setAttribute("aria-pressed", String(settings.autoAdvance));
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
  document.getElementById("repeatWord").addEventListener("change", (e) => {
    settings.repeatWord = parseInt(e.target.value, 10);
    saveSettings();
  });
  document.getElementById("wakeLock").addEventListener("change", (e) => {
    settings.wakeLock = e.target.checked;
    saveSettings();
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

  await renderFileList();
  showView("fileList");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
