#!/usr/bin/env python3
"""Pre-generate per-segment TTS audio for every vocab/*.md file.

Mirrors the parser in app.js so the resulting audio matches what the
runtime player would have spoken via Web Speech API.

For each source file `vocab/<name>.md` we produce:

    vocab/audio/<name>/
        manifest.json                 # entries + audio file paths
        e0001/word.mp3
        e0001/meaning.mp3
        e0001/ex0_en.mp3
        e0001/ex0_ja.mp3
        e0002/...

The manifest stores the source file's SHA-256 so re-runs are no-ops
when the source has not changed.

Backends
--------
- English: espeak-ng (-v en-us+f3)
- Japanese: espeak-ng (-v ja)
- WAV  -> MP3 via ffmpeg (mono, 48 kbps) to keep audio assets small.

Both binaries are present on a default ubuntu-latest GitHub Actions
runner after `apt-get install -y espeak-ng ffmpeg`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# --------------------------------------------------------------------------- #
# Markdown parser (mirror of app.js parser)
# --------------------------------------------------------------------------- #

CJK_RE = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]")

HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")
WORD_RE = re.compile(r"^\*\*\s*([^*]+?)\s*\*\*\s*[:：]?\s*(.*)$")
TR_RE = re.compile(
    r"^(?:訳|和訳|日本語訳|Translation|Trans|Tr)\s*[）)\]:：]\s*(.+)$",
    re.IGNORECASE,
)
EX_RE = re.compile(
    r"^(?:例(?:文)?\s*\d*|Example|Ex)\s*[）)\]:：]\s*(.*)$",
    re.IGNORECASE,
)
BULLET_EX_RE = re.compile(
    r"^[-*]\s+(?:例(?:文)?|Example|Ex)\s*[）)\]:：]\s*(.+)$",
    re.IGNORECASE,
)
BULLET_MEAN_RE = re.compile(
    r"^[-*]\s+(?:意味|Meaning|意)\s*[）)\]:：]\s*(.+)$",
    re.IGNORECASE,
)
INLINE_TR_RE = re.compile(r"^(.*?)\s*[（(]\s*([^()（）]*?)\s*[）)]\s*$")


@dataclass
class Example:
    en: str
    ja: str = ""


@dataclass
class Entry:
    word: str
    meaning: str = ""
    examples: list[Example] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    section: str = ""


def split_inline_translation(text: str) -> tuple[str, str]:
    m = INLINE_TR_RE.match(text)
    if m and CJK_RE.search(m.group(2)):
        return m.group(1).strip(), m.group(2).strip()
    return text.strip(), ""


def parse_vocab(md: str) -> list[Entry]:
    entries: list[Entry] = []
    current: Entry | None = None
    section = ""
    last_was_example = False

    def finalize() -> None:
        nonlocal current, last_was_example
        if current and current.word:
            entries.append(current)
        current = None
        last_was_example = False

    def push_example(text: str) -> None:
        nonlocal last_was_example
        en, ja = split_inline_translation(text)
        if en:
            current.examples.append(Example(en=en, ja=ja))
            last_was_example = True

    for raw in md.splitlines():
        line = raw.strip()
        if not line:
            continue

        h = HEADING_RE.match(line)
        if h:
            finalize()
            section = h.group(1).strip()
            continue

        headed = WORD_RE.match(line)
        if headed:
            finalize()
            current = Entry(
                word=headed.group(1).strip(),
                meaning=headed.group(2).strip(),
                section=section,
            )
            last_was_example = False
            continue

        if not current:
            continue

        tr = TR_RE.match(line)
        if tr and current.examples:
            last = current.examples[-1]
            if not last.ja:
                last.ja = tr.group(1).strip()
            else:
                last.ja += " " + tr.group(1).strip()
            continue

        ex = EX_RE.match(line)
        if ex:
            text = ex.group(1).strip()
            if text:
                push_example(text)
            continue

        bullet_ex = BULLET_EX_RE.match(line)
        if bullet_ex:
            push_example(bullet_ex.group(1).strip())
            continue

        bullet_mean = BULLET_MEAN_RE.match(line)
        if bullet_mean:
            if not current.meaning:
                current.meaning = bullet_mean.group(1).strip()
            else:
                current.notes.append(bullet_mean.group(1).strip())
            last_was_example = False
            continue

        if last_was_example and current.examples:
            last = current.examples[-1]
            if not last.ja and CJK_RE.search(line):
                last.ja = line
                continue

        if not current.meaning:
            current.meaning = line
            last_was_example = False
            continue

        current.notes.append(line)
        last_was_example = False

    finalize()
    return entries


# --------------------------------------------------------------------------- #
# TTS backends
# --------------------------------------------------------------------------- #


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def synth_espeak(text: str, lang: str, wav_path: Path, rate: int = 165) -> None:
    """Synthesize text to WAV via espeak-ng. lang = 'en' or 'ja'."""
    voice = "en-us+f3" if lang == "en" else "ja+f3"
    subprocess.run(
        [
            "espeak-ng",
            "-v",
            voice,
            "-s",
            str(rate),
            "-w",
            str(wav_path),
            text,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    """Encode WAV to mono 48 kbps MP3 (small, suitable for speech)."""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(wav_path),
            "-ac",
            "1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "48k",
            str(mp3_path),
        ],
        check=True,
    )


def synth_segment(text: str, lang: str, out_mp3: Path) -> None:
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    wav_path = out_mp3.with_suffix(".wav")
    try:
        synth_espeak(text, lang, wav_path)
        wav_to_mp3(wav_path, out_mp3)
    finally:
        if wav_path.exists():
            wav_path.unlink()


# --------------------------------------------------------------------------- #
# Per-file generation
# --------------------------------------------------------------------------- #


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def build_entry_audio(entry: Entry, entry_dir: Path) -> dict:
    """Generate audio for one entry. Returns the manifest fragment."""
    files: dict = {}

    if entry.word:
        path = entry_dir / "word.mp3"
        synth_segment(entry.word, "en", path)
        files["word"] = f"{entry_dir.name}/word.mp3"

    if entry.meaning:
        path = entry_dir / "meaning.mp3"
        synth_segment(entry.meaning, "ja", path)
        files["meaning"] = f"{entry_dir.name}/meaning.mp3"

    examples_audio: list[dict] = []
    for i, ex in enumerate(entry.examples):
        ex_audio: dict = {}
        if ex.en:
            p = entry_dir / f"ex{i}_en.mp3"
            synth_segment(ex.en, "en", p)
            ex_audio["en"] = f"{entry_dir.name}/ex{i}_en.mp3"
        if ex.ja:
            p = entry_dir / f"ex{i}_ja.mp3"
            synth_segment(ex.ja, "ja", p)
            ex_audio["ja"] = f"{entry_dir.name}/ex{i}_ja.mp3"
        examples_audio.append(ex_audio)
    if examples_audio:
        files["examples"] = examples_audio

    return {
        "word": entry.word,
        "meaning": entry.meaning,
        "section": entry.section,
        "examples": [{"en": e.en, "ja": e.ja} for e in entry.examples],
        "audio": files,
    }


def generate_for_file(md_path: Path, audio_root: Path, force: bool) -> bool:
    """Generate audio for one .md file. Returns True if (re)generated."""
    md_text = md_path.read_text(encoding="utf-8")
    src_hash = sha256_text(md_text)

    out_dir = audio_root / md_path.stem
    manifest_path = out_dir / "manifest.json"

    if not force and manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if existing.get("sourceHash") == src_hash:
                print(f"  skip (unchanged): {md_path.name}")
                return False
        except Exception:
            pass  # fall through and regenerate

    # Wipe and regenerate. Audio files are derived data; clean rebuild keeps
    # the directory free of stale segments.
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = parse_vocab(md_text)
    print(f"  parsing: {md_path.name} -> {len(entries)} entries")

    entry_manifests: list[dict] = []
    for i, entry in enumerate(entries):
        entry_dir = out_dir / f"e{i + 1:04d}"
        entry_manifests.append(build_entry_audio(entry, entry_dir))

    manifest = {
        "source": md_path.name,
        "sourceHash": src_hash,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "engine": {"en": "espeak-ng:en-us+f3", "ja": "espeak-ng:ja+f3"},
        "format": "mp3",
        "entries": entry_manifests,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"  wrote: {manifest_path.relative_to(audio_root.parent)}")
    return True


# --------------------------------------------------------------------------- #
# Cleanup of audio dirs whose source .md was deleted
# --------------------------------------------------------------------------- #


def prune_orphans(vocab_dir: Path, audio_root: Path) -> list[str]:
    if not audio_root.exists():
        return []
    md_stems = {p.stem for p in vocab_dir.glob("*.md") if p.is_file()}
    pruned = []
    for child in audio_root.iterdir():
        if child.is_dir() and child.name not in md_stems:
            shutil.rmtree(child)
            pruned.append(child.name)
    return pruned


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--vocab-dir",
        default="vocab",
        help="Directory containing source .md files (default: vocab)",
    )
    ap.add_argument(
        "--audio-dir",
        default="vocab/audio",
        help="Where to write generated audio (default: vocab/audio)",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Regenerate even when sourceHash matches",
    )
    args = ap.parse_args(argv)

    if not have("espeak-ng"):
        print("error: espeak-ng not found in PATH", file=sys.stderr)
        return 2
    if not have("ffmpeg"):
        print("error: ffmpeg not found in PATH", file=sys.stderr)
        return 2

    vocab_dir = Path(args.vocab_dir)
    audio_root = Path(args.audio_dir)
    audio_root.mkdir(parents=True, exist_ok=True)

    md_files = sorted(p for p in vocab_dir.glob("*.md") if p.is_file())
    print(f"Found {len(md_files)} source file(s) under {vocab_dir}/")

    regenerated = 0
    for md_path in md_files:
        if generate_for_file(md_path, audio_root, args.force):
            regenerated += 1

    pruned = prune_orphans(vocab_dir, audio_root)
    if pruned:
        print(f"Pruned {len(pruned)} orphan dir(s): {', '.join(pruned)}")

    print(f"Done. {regenerated} file(s) (re)generated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
