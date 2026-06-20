#!/usr/bin/env python3
import argparse
import glob
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def run_cmd(cmd, cwd=None, timeout=1200):
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def clean_caption_text(raw: str) -> str:
    raw = html.unescape(raw or "")
    raw = re.sub(r"<[^>]+>", "", raw)
    lines = []
    last = None
    for line in raw.splitlines():
        line = line.strip().replace("\ufeff", "")
        if not line:
            continue
        if line.upper().startswith(("WEBVTT", "KIND:", "LANGUAGE:", "STYLE", "NOTE")):
            continue
        if "-->" in line:
            continue
        if re.fullmatch(r"\d+", line):
            continue
        line = re.sub(r"\s+", " ", line).strip()
        if not line or line == last:
            continue
        lines.append(line)
        last = line
    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def try_subtitles(url: str, tmp: str, timeout: int):
    outtmpl = os.path.join(tmp, "subs.%(id)s.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--skip-download",
        "--no-playlist",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "pt.*,en.*,es.*",
        "--sub-format", "vtt/best",
        "-o", outtmpl,
        url,
    ]
    run_cmd(cmd, cwd=tmp, timeout=min(timeout, 240))
    files = sorted(glob.glob(os.path.join(tmp, "*.vtt")))
    best_text = ""
    best_file = ""
    for file in files:
        try:
            text = clean_caption_text(Path(file).read_text("utf-8", errors="ignore"))
        except Exception:
            continue
        if len(text) > len(best_text):
            best_text = text
            best_file = file
    if len(best_text) >= 40:
        return {
            "ok": True,
            "transcript": best_text,
            "source": "legendas/auto-legendas do vídeo",
            "file": os.path.basename(best_file),
        }
    return None


def download_audio(url: str, tmp: str, timeout: int) -> str:
    outtmpl = os.path.join(tmp, "audio.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--no-playlist",
        "--force-overwrites",
        "-x",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "-o", outtmpl,
        url,
    ]
    code, stdout, stderr = run_cmd(cmd, cwd=tmp, timeout=timeout)
    if code != 0:
        raise RuntimeError((stderr or stdout or "Não consegui baixar o áudio do link.")[-1800:])
    audio_files = sorted(glob.glob(os.path.join(tmp, "audio*.wav")))
    if not audio_files:
        audio_files = sorted(glob.glob(os.path.join(tmp, "*.wav")))
    if not audio_files:
        raise RuntimeError("O áudio foi baixado, mas o arquivo WAV não foi encontrado.")
    return audio_files[0]


def whisper_transcribe(audio_path: str, timeout_note: int):
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise RuntimeError("Motor de transcrição não instalado no servidor: " + str(exc))

    model_name = os.environ.get("TRANSCRIBE_MODEL", "tiny")
    language = os.environ.get("TRANSCRIBE_LANGUAGE", "") or None
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
    )
    parts = []
    timed = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        parts.append(text)
        timed.append(f"[{seg.start:0.1f}s - {seg.end:0.1f}s] {text}")
    transcript = " ".join(parts).strip()
    return {
        "ok": True,
        "transcript": transcript,
        "timedTranscript": "\n".join(timed).strip(),
        "source": "Whisper local no Render",
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
        "model": model_name,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="silencepro-transcribe-") as tmp:
        subtitle = try_subtitles(args.url, tmp, args.timeout)
        if subtitle:
            print(json.dumps(subtitle, ensure_ascii=False))
            return
        audio_path = download_audio(args.url, tmp, args.timeout)
        result = whisper_transcribe(audio_path, args.timeout)
        if not result.get("transcript"):
            raise RuntimeError("Não consegui gerar texto a partir do áudio deste vídeo.")
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": "A transcrição demorou demais. Tente um vídeo menor."}, ensure_ascii=False))
        sys.exit(2)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
