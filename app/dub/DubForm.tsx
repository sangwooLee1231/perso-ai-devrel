"use client";

import { useState, useRef, useEffect } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

const CROP_LIMIT_SEC = 60;
const MAX_FILE_MB = 500;

/** Returns a Korean error string if the file is invalid, null if OK. */
function validateFile(file: File): string | null {
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > MAX_FILE_MB) {
    return `파일이 너무 큽니다 (${Math.round(sizeMB)} MB). ${MAX_FILE_MB} MB 이하 파일을 사용해 주세요.`;
  }
  const isAudio = file.type.startsWith("audio/");
  const isVideo = ["video/mp4", "video/webm", "video/quicktime"].includes(file.type);
  if (!isAudio && !isVideo) {
    return (
      `지원하지 않는 파일 형식입니다 (${file.type || "알 수 없음"}).\n` +
      "오디오: MP3, WAV, M4A, FLAC, OGG 등 / 영상: MP4, WebM 파일을 사용해 주세요."
    );
  }
  return null;
}

type Status = "idle" | "loading" | "done" | "error";

interface DubResult {
  transcript: string;
  translation: string;
  detectedLanguage: string | null;
  audio: string; // base64
  mimeType: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ko: "한국어", en: "영어", ja: "일본어", zh: "중국어",
  es: "스페인어", fr: "프랑스어", de: "독일어",
  pt: "포르투갈어", it: "이탈리아어", ru: "러시아어",
};

// ── Client-side media helpers ─────────────────────────────────────────────────

/**
 * Encode an AudioBuffer as 16-bit PCM WAV.
 * 60 s mono 22 050 Hz → ≈ 2.5 MB — well under Vercel's 4.5 MB request limit.
 * No external library — pure DataView.
 */
function encodeWAV(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const numSamples = buffer.length;
  const bps = 2; // 16-bit PCM
  const dataLen = numCh * numSamples * bps;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);

  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);      // chunk size
  v.setUint16(20, 1, true);       // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true);
  v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true);      // bits per sample
  ws(36, "data");
  v.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

/**
 * Extract audio from an audio OR video file, optionally cropping to maxSec.
 * Pass maxSec = Infinity to extract the full duration without cropping.
 *
 * How it works:
 *   1. AudioContext.decodeAudioData(file.arrayBuffer())
 *      Modern browsers can decode the audio track from common video containers
 *      (MP4/AAC, WebM/Opus) the same way they decode audio files — no ffmpeg.
 *   2. OfflineAudioContext (1 ch, 22 050 Hz) renders the crop + mix-to-mono +
 *      resample in a single pass. Does NOT touch audio hardware, so iOS Safari
 *      does not apply the user-gesture lock.
 *   3. encodeWAV() writes a PCM WAV Blob (~2.5 MB for 60 s).
 *
 * Browser support:
 *   Chrome/Edge Android 57+   ✅ MP4, WebM
 *   iOS Safari 14.5+           ✅ MP4/AAC (most iOS-recorded videos)
 *   Firefox Android 4+         ✅ WebM (Vorbis/Opus), MP4 in most builds
 *
 * Limitations:
 *   - Reads entire file into memory before processing. Not suitable for files
 *     several hundred MB or larger on low-memory devices.
 *   - WebM/Vorbis: not supported on Safari (video recorded on iOS is MP4).
 *   - Video with no audio track: decodeAudioData throws — caller shows error.
 *
 * Must be called inside a user-gesture handler (form submit satisfies this).
 */
async function extractAndCropAudio(file: File, maxSec: number): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();

  // Step 1 — decode audio track. Close AudioContext immediately after to
  // release mobile audio hardware resources.
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close();
  }
  // AudioBuffer objects survive AudioContext.close() — decoded is still valid.

  // Step 2 — render crop/extract via OfflineAudioContext.
  const cropDuration = Math.min(decoded.duration, maxSec);
  const outRate = 22050;
  const outSamples = Math.ceil(outRate * cropDuration);
  const offCtx = new OfflineAudioContext(1, outSamples, outRate);

  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0);
  // offCtx renders exactly outSamples frames; any remaining source data is
  // discarded automatically.

  const rendered = await offCtx.startRendering();

  // Step 3 — encode to WAV.
  return encodeWAV(rendered);
}

// ─────────────────────────────────────────────────────────────────────────────

export default function DubForm() {
  const [file, setFile] = useState<File | null>(null);
  // Duration probed from file metadata on select — no full decode needed.
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<string>(SUPPORTED_LANGUAGES[0].code);
  const [status, setStatus] = useState<Status>("idle");
  // -1 = not loading; 0 = 파일 확인 중; 1 = 추출/전처리 중; 2 = 서버 처리 중
  const [step, setStep] = useState<number>(-1);
  const [result, setResult] = useState<DubResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  /**
   * Probe duration from file metadata without full decode.
   * Uses <video> element for video files — iOS Safari reads video metadata
   * more reliably from a <video> element than from <audio>.
   */
  const selectFile = async (selected: File | null) => {
    setFile(selected);
    setFileDuration(null);
    if (!selected) return;

    const url = URL.createObjectURL(selected);
    const isVid = selected.type.startsWith("video/");
    const el = document.createElement(isVid ? "video" : "audio") as
      | HTMLVideoElement
      | HTMLAudioElement;
    el.preload = "metadata";
    el.src = url;

    await new Promise<void>((resolve) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => resolve(); // graceful: unknown duration → no warning shown
    });
    URL.revokeObjectURL(url);

    // Infinity can occur for some streaming/live formats — treat as unknown.
    if (Number.isFinite(el.duration)) {
      setFileDuration(el.duration);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await selectFile(e.target.files?.[0] ?? null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    await selectFile(e.dataTransfer.files[0] ?? null);
  };

  const buildBlobUrl = (base64: string, mimeType: string): string => {
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mimeType }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    // Client-side validation before any processing
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      setStatus("error");
      return;
    }

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    setStatus("loading");
    setStep(0); // 파일 확인 중
    setError(null);
    setResult(null);
    setAudioUrl(null);

    const isVideo = file.type.startsWith("video/");
    const needsCrop = fileDuration !== null && fileDuration > CROP_LIMIT_SEC;

    let uploadBlob: Blob = file;
    let uploadFilename = file.name;

    if (isVideo) {
      // ── Video path ─────────────────────────────────────────────────────────
      // Always extract audio from video — the server only accepts audio; we
      // must never send a raw video file to /api/dub.
      // On extraction failure we hard-stop and show an error instead of
      // silently uploading the video (which the server cannot process).
      setStep(1); // 음성 추출 중

      try {
        uploadBlob = await extractAndCropAudio(
          file,
          needsCrop ? CROP_LIMIT_SEC : Infinity,
        );
        uploadFilename = "extracted_audio.wav";
      } catch (extractErr) {
        console.error("[video extract] failed:", extractErr);
        setError(
          "이 영상에서 오디오를 추출하지 못했습니다. " +
            "MP4 또는 WebM 파일인지 확인하거나, 오디오 파일을 직접 업로드해 보세요.\n" +
            "MOV·HEVC 등 일부 코덱은 현재 브라우저가 지원하지 않을 수 있습니다.",
        );
        setStatus("error");
        setStep(-1);
        return; // hard stop — do not attempt to upload raw video
      }
    } else if (needsCrop) {
      // ── Long audio path ────────────────────────────────────────────────────
      setStep(1); // 음원 전처리 중
      try {
        uploadBlob = await extractAndCropAudio(file, CROP_LIMIT_SEC);
        uploadFilename = "cropped_audio.wav";
      } catch (cropErr) {
        // Crop failed but the file is still audio — fall back to original so
        // the server can attempt transcription directly.
        console.warn("[audio crop] failed, falling back to original:", cropErr);
        uploadBlob = file;
        uploadFilename = file.name;
      }
    }
    // else: short audio — send original file as-is (fast path, no processing).

    setStep(2); // 서버 처리 중

    const form = new FormData();
    form.append("audio", uploadBlob, uploadFilename);
    form.append("targetLanguage", targetLanguage);

    try {
      const res = await fetch("/api/dub", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? `서버 오류 (${res.status}). 잠시 후 다시 시도해 주세요.`);
      }

      const url = buildBlobUrl(data.audio, data.mimeType);
      blobUrlRef.current = url;
      setAudioUrl(url);
      setResult(data);
      setStatus("done");
      setStep(-1);
    } catch (err) {
      const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      setError(message);
      setStatus("error");
      setStep(-1);
    }
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = `dubbed_${targetLanguage.toLowerCase()}.mp3`;
    a.click();
  };

  const selectedLabel =
    SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.label ?? targetLanguage;

  const isVideoFile = file?.type.startsWith("video/") ?? false;
  const willCrop = fileDuration !== null && fileDuration > CROP_LIMIT_SEC;
  const durationLabel =
    fileDuration !== null
      ? fileDuration < 60
        ? `${Math.round(fileDuration)}초`
        : `${Math.floor(fileDuration / 60)}분 ${Math.round(fileDuration % 60)}초`
      : null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">

      {/* ── File upload card ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow">
        <p className="text-sm font-semibold text-gray-800 mb-0.5">파일 선택</p>
        <p className="text-xs text-gray-400 mb-3">
          MP3 · WAV · M4A · FLAC · OGG &nbsp;|&nbsp; MP4 · WebM &nbsp;·&nbsp; 60초 초과 시 앞 60초만 처리
        </p>

        {/* Drop zone */}
        <label
          className={`flex flex-col items-center gap-2 w-full cursor-pointer rounded-xl border-2 border-dashed py-8 px-4 text-center transition-all duration-150 ${
            isDragging
              ? "border-blue-400 bg-blue-50 scale-[1.01]"
              : "border-gray-200 bg-gray-50/60 hover:border-blue-300 hover:bg-blue-50/30"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <svg
            className={`w-7 h-7 transition-colors ${isDragging ? "text-blue-400" : "text-gray-300"}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
            />
          </svg>
          <span className={`text-sm font-medium transition-colors ${isDragging ? "text-blue-500" : "text-gray-500"}`}>
            {isDragging ? "여기에 놓으세요" : file ? file.name : "파일 선택 또는 드래그 앤 드롭"}
          </span>
          {!file && !isDragging && (
            <span className="text-xs text-gray-400">
              audio/* · video/mp4 · video/webm
            </span>
          )}
          <input
            type="file"
            accept="audio/*,video/mp4,video/webm,video/quicktime"
            onChange={handleFileChange}
            className="sr-only"
          />
        </label>

        {/* File metadata + warnings */}
        {file && (
          <div className="mt-3 flex flex-col gap-1">
            <p className="text-xs text-gray-400">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
              {durationLabel && ` · ${durationLabel}`}
              {isVideoFile && " · 영상"}
            </p>
            {isVideoFile && !willCrop && (
              <p className="text-xs text-gray-400">
                영상에서 오디오 트랙만 추출하여 전송됩니다.
              </p>
            )}
            {willCrop && (
              <p className="text-xs font-medium text-amber-600">
                {isVideoFile
                  ? "영상이 1분을 초과하여 앞 60초의 오디오만 처리합니다."
                  : "파일이 1분을 초과하여 앞 60초만 처리합니다."}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Language selector card ───────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow">
        <p className="text-sm font-semibold text-gray-800 mb-0.5">목표 언어</p>
        <p className="text-xs text-gray-400 mb-3">
          원본 음성을 전사·번역·합성하여 선택한 언어로 더빙합니다.
        </p>
        <select
          value={targetLanguage}
          onChange={(e) => setTargetLanguage(e.target.value)}
          className="w-full max-w-xs rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      </section>

      {/* ── Submit ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={!file || status === "loading"}
          className="w-full rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-blue-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === "loading" ? "처리 중…" : "더빙 생성"}
        </button>
        {status !== "loading" && (
          <p className="text-center text-xs text-gray-400">
            보통 15~45초 정도 소요될 수 있어요.
          </p>
        )}
      </div>

      {/* ── Loading — step chips + spinner ───────────────────────────────────── */}
      {status === "loading" && (
        <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50/40 px-5 py-4">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-500" />
            <p className="text-sm font-semibold text-blue-700">
              {step === 0 && "파일 확인 중…"}
              {step === 1 &&
                (isVideoFile
                  ? "영상에서 오디오 추출 중…"
                  : "음원 전처리 중 (앞 60초 추출)…")}
              {step === 2 && "서버 처리 중…"}
            </p>
          </div>
          {step === 2 && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-white/70 border border-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                  음성 전사
                </span>
                <span className="text-xs text-blue-300">→</span>
                <span className="rounded-full bg-white/70 border border-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                  {selectedLabel} 번역
                </span>
                <span className="text-xs text-blue-300">→</span>
                <span className="rounded-full bg-white/70 border border-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                  음성 합성
                </span>
              </div>
              <p className="mt-2 text-xs text-blue-400">
                오디오 길이에 따라 15~45초 소요됩니다.
              </p>
            </>
          )}
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────────────────── */}
      {status === "error" && error && (
        <div className="rounded-2xl border border-red-100 bg-red-50/80 px-5 py-4">
          <p className="mb-1 text-sm font-semibold text-red-700">오류가 발생했습니다</p>
          <p className="whitespace-pre-wrap text-sm text-red-600">{error}</p>
          <p className="mt-2.5 text-xs text-red-400">
            다른 파일 형식으로 시도하거나, 더 짧은 오디오 파일을 업로드해 보세요.
          </p>
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────────── */}
      {status === "done" && result && (
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-green-100">
              <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </span>
            <span className="text-xs font-semibold text-green-700">더빙 완료</span>
          </div>

          {/* Transcript */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                원문 전사
                {result.detectedLanguage && (
                  <span className="ml-2 normal-case font-medium text-blue-400">
                    {LANGUAGE_NAMES[result.detectedLanguage] ?? result.detectedLanguage}
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([result.transcript], { type: "text/plain" }));
                  a.download = "transcript.txt";
                  a.click();
                }}
                className="text-xs text-gray-300 hover:text-blue-400 transition-colors"
              >
                ↓ txt
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
              {result.transcript}
            </p>
          </div>

          {/* Translation */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                번역 — {selectedLabel}
              </p>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([result.translation], { type: "text/plain" }));
                  a.download = `translation_${targetLanguage.toLowerCase()}.txt`;
                  a.click();
                }}
                className="text-xs text-gray-300 hover:text-blue-400 transition-colors"
              >
                ↓ txt
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
              {result.translation}
            </p>
          </div>

          {/* Audio output */}
          <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
              더빙 오디오
            </p>
            {audioUrl && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio controls src={audioUrl} className="w-full mb-3" />
            )}
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 active:bg-gray-200"
            >
              ↓ MP3 다운로드
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
