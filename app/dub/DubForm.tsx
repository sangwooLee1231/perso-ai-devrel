"use client";

import { useState, useRef, useEffect } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

const CROP_LIMIT_SEC = 60;
const MAX_FILE_MB = 500;

/** 파일 유효성 검사. 오류 문자열 반환 또는 null(정상). */
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

// ── 시간 포맷 헬퍼 ──────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}초`;
}

// ── 클라이언트 사이드 미디어 헬퍼 ──────────────────────────────────────────

/**
 * AudioBuffer를 16비트 PCM WAV Blob으로 인코딩.
 * 60초 모노 22,050 Hz ≈ 2.5 MB — Vercel 4.5 MB 제한 이내.
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
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);       // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true);
  v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true);
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
 * 파일에서 startSec ~ endSec 구간의 오디오를 추출하여 WAV Blob 반환.
 *
 * 동작 방식:
 *   1. AudioContext.decodeAudioData() 로 파일 디코딩 (MP4/AAC, WebM/Opus 지원)
 *   2. OfflineAudioContext 로 구간 추출 + 모노 믹스 + 22,050 Hz 리샘플링 (1패스)
 *   3. encodeWAV() 로 PCM WAV Blob 생성
 *
 * 브라우저 지원:
 *   Chrome/Edge Android 57+  ✅ MP4, WebM
 *   iOS Safari 14.5+         ✅ MP4/AAC
 *   Firefox Android 4+       ✅ WebM(Vorbis/Opus), 대부분 빌드에서 MP4
 */
async function extractAndCropAudio(
  file: File,
  startSec: number,
  endSec: number,
): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();

  // 디코딩 후 즉시 AudioContext 닫아 모바일 오디오 하드웨어 자원 해제
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close();
  }

  // 실제 길이에 맞게 범위 보정
  const clampedStart = Math.max(0, Math.min(startSec, decoded.duration));
  const clampedEnd = Math.max(clampedStart + 0.1, Math.min(endSec, decoded.duration));
  const cropDuration = clampedEnd - clampedStart;

  const outRate = 22050;
  const outSamples = Math.ceil(outRate * cropDuration);
  const offCtx = new OfflineAudioContext(1, outSamples, outRate);

  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  // offset: 버퍼 내 시작 지점(초), duration: 재생할 길이(초)
  src.start(0, clampedStart, cropDuration);

  const rendered = await offCtx.startRendering();
  return encodeWAV(rendered);
}

// ───────────────────────────────────────────────────────────────────────────

export default function DubForm() {
  const [file, setFile] = useState<File | null>(null);
  const [fileDuration, setFileDuration] = useState<number | null>(null);

  // 크롭 범위 (초 단위)
  const [cropStart, setCropStart] = useState<number>(0);
  const [cropEnd, setCropEnd] = useState<number>(CROP_LIMIT_SEC);

  const [targetLanguage, setTargetLanguage] = useState<string>(SUPPORTED_LANGUAGES[0].code);

  // 번역 자막 표시 여부
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);

  // 멀티 재생 탭: 원본 / 더빙
  const [playbackMode, setPlaybackMode] = useState<"original" | "dubbed">("dubbed");

  const [status, setStatus] = useState<Status>("idle");
  // -1 = 대기, 0 = 파일 확인, 1 = 추출/전처리, 2 = 서버 처리
  const [step, setStep] = useState<number>(-1);
  const [result, setResult] = useState<DubResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // 더빙 탭: 영상 ↔ 더빙 오디오 동기화용 ref
  const videoRef = useRef<HTMLVideoElement>(null);
  const dubAudioRef = useRef<HTMLAudioElement>(null);

  // Blob URL 정리용 ref
  const blobUrlRef = useRef<string | null>(null);
  const origUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      if (origUrlRef.current) URL.revokeObjectURL(origUrlRef.current);
    };
  }, []);

  // 더빙 탭: <video>(음소거) 재생 이벤트 → <audio>(더빙) 동기화
  useEffect(() => {
    const video = videoRef.current;
    const audio = dubAudioRef.current;
    if (!video || !audio || playbackMode !== "dubbed") return;

    const onPlay = () => { audio.currentTime = video.currentTime; audio.play(); };
    const onPause = () => audio.pause();
    const onSeeked = () => { audio.currentTime = video.currentTime; };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [playbackMode, audioUrl]);

  /**
   * 파일 선택/해제. 메타데이터 탐색 + 원본 URL 생성.
   * iOS Safari는 <audio> 보다 <video> 엘리먼트로 메타데이터를 더 안정적으로 읽음.
   */
  const selectFile = async (selected: File | null) => {
    setFile(selected);
    setFileDuration(null);
    setCropStart(0);
    setCropEnd(CROP_LIMIT_SEC);
    setResult(null);
    setError(null);
    setStatus("idle");
    setAudioUrl(null);
    setPlaybackMode("dubbed");

    // 이전 원본 URL 해제
    if (origUrlRef.current) {
      URL.revokeObjectURL(origUrlRef.current);
      origUrlRef.current = null;
      setOriginalUrl(null);
    }

    if (!selected) return;

    // 원본 파일 Blob URL — 메타데이터 탐색 + 멀티 재생 플레이어 공용
    const origUrl = URL.createObjectURL(selected);
    origUrlRef.current = origUrl;
    setOriginalUrl(origUrl);

    const isVid = selected.type.startsWith("video/");
    const el = document.createElement(isVid ? "video" : "audio") as
      HTMLVideoElement | HTMLAudioElement;
    el.preload = "metadata";
    el.src = origUrl;

    await new Promise<void>((resolve) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => resolve(); // 탐색 실패 시 무시 (슬라이더 미표시)
    });

    if (Number.isFinite(el.duration)) {
      const dur = el.duration;
      setFileDuration(dur);
      // 기본 크롭 끝 지점: 파일 길이와 60초 중 작은 값
      setCropEnd(Math.min(dur, CROP_LIMIT_SEC));
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
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    await selectFile(e.dataTransfer.files[0] ?? null);
  };

  // 시작 슬라이더: 끝보다 1초 이상 앞, 범위 60초 초과 시 끝 자동 조정
  const handleCropStartChange = (val: number) => {
    const newStart = Math.min(val, cropEnd - 1);
    setCropStart(newStart);
    if (cropEnd - newStart > CROP_LIMIT_SEC) setCropEnd(newStart + CROP_LIMIT_SEC);
  };

  // 끝 슬라이더: 시작보다 1초 이상 뒤, 범위 60초 초과 시 시작 자동 조정
  const handleCropEndChange = (val: number) => {
    const newEnd = Math.max(val, cropStart + 1);
    setCropEnd(newEnd);
    if (newEnd - cropStart > CROP_LIMIT_SEC) setCropStart(newEnd - CROP_LIMIT_SEC);
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
    setStep(0);
    setError(null);
    setResult(null);
    setAudioUrl(null);

    const isVideo = file.type.startsWith("video/");
    // 추출 필요 여부: 영상이거나 / 시작이 0이 아니거나 / 끝이 파일 길이보다 짧은 경우
    // fileDuration을 알 수 없으면 cropEnd(기본 60초)가 Infinity보다 작으므로 항상 추출
    const needsExtract = isVideo || cropStart > 0 || cropEnd < (fileDuration ?? Infinity);

    let uploadBlob: Blob = file;
    let uploadFilename = file.name;

    if (needsExtract) {
      setStep(1);
      try {
        uploadBlob = await extractAndCropAudio(file, cropStart, cropEnd);
        uploadFilename = isVideo ? "extracted_audio.wav" : "cropped_audio.wav";
      } catch (extractErr) {
        console.error("[extract] failed:", extractErr);
        if (isVideo) {
          // 영상 오디오 추출 실패: 하드 스탑 (서버는 영상 파일 처리 불가)
          setError(
            "이 영상에서 오디오를 추출하지 못했습니다. " +
            "MP4 또는 WebM 파일인지 확인하거나, 오디오 파일을 직접 업로드해 보세요.\n" +
            "MOV·HEVC 등 일부 코덱은 현재 브라우저가 지원하지 않을 수 있습니다.",
          );
          setStatus("error");
          setStep(-1);
          return;
        }
        // 오디오 크롭 실패: 원본 파일로 폴백
        console.warn("[audio crop] failed, falling back to original:", extractErr);
        uploadBlob = file;
        uploadFilename = file.name;
      }
    }

    setStep(2);

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
  const cropDuration = cropEnd - cropStart;
  // 슬라이더 표시: 길이를 알고 있고 2초 이상인 파일
  const showCropSlider = fileDuration !== null && fileDuration >= 2;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">

      {/* ── Step 1: 파일 선택 ──────────────────────────────────────────────── */}
      <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-7 h-7 rounded-lg bg-[rgba(37,99,235,0.1)] text-blue-600 text-[13px] font-bold flex items-center justify-center flex-shrink-0">
            01
          </span>
          <div>
            <p className="text-sm font-semibold text-[#1a1917]">파일 선택</p>
            <p className="text-xs text-[#a8a29e]">오디오 또는 영상 파일을 업로드하세요</p>
          </div>
        </div>

        {!file ? (
          <label
            className={`flex flex-col items-center gap-3 w-full cursor-pointer rounded-xl border-[1.5px] border-dashed py-8 px-4 text-center transition-all duration-150 ${
              isDragging
                ? "border-blue-400 bg-[rgba(37,99,235,0.06)]"
                : "border-[#d0cfc9] hover:border-blue-500 hover:bg-[rgba(37,99,235,0.04)]"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className={`w-11 h-11 rounded-xl border flex items-center justify-center text-xl transition-all ${
              isDragging
                ? "bg-[rgba(37,99,235,0.07)] border-[rgba(37,99,235,0.25)]"
                : "bg-[#f5f4f0] border-[#e4e3df]"
            }`}>
              🎵
            </div>
            <div>
              <p className="text-sm font-medium text-[#1a1917] mb-0.5">
                {isDragging ? "여기에 놓으세요" : (
                  <><span className="text-blue-600">파일 선택</span> 또는 드래그 앤 드롭</>
                )}
              </p>
              <p className="text-xs text-[#a8a29e]">최대 60초 구간을 직접 선택할 수 있습니다</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {["MP3", "WAV", "M4A", "FLAC", "OGG", "MP4", "WebM"].map((f) => (
                <span
                  key={f}
                  className="bg-[#f5f4f0] border border-[#e4e3df] rounded-md px-2 py-0.5 text-[11px] font-medium text-[#a8a29e] tracking-wide"
                >
                  {f}
                </span>
              ))}
            </div>
            <input
              type="file"
              accept="audio/*,video/mp4,video/webm,video/quicktime"
              onChange={handleFileChange}
              className="sr-only"
            />
          </label>
        ) : (
          <div className="flex items-center gap-3 bg-[rgba(37,99,235,0.06)] border border-[rgba(37,99,235,0.2)] rounded-xl px-4 py-3.5">
            <span className="text-2xl">{isVideoFile ? "🎬" : "🎵"}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[#1a1917] truncate">{file.name}</p>
              <p className="text-xs text-[#a8a29e]">
                {(file.size / 1024 / 1024).toFixed(1)} MB
                {fileDuration !== null && ` · 전체 ${formatTime(fileDuration)}`}
                {isVideoFile && " · 영상"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => selectFile(null)}
              className="text-[#a8a29e] hover:text-[#1a1917] hover:bg-black/5 rounded-lg p-1.5 transition-colors text-xl leading-none"
            >
              ×
            </button>
          </div>
        )}

        {/* ── 크롭 범위 슬라이더 ──────────────────────────────────────────── */}
        {file && showCropSlider && (
          <div className="mt-4 bg-[#f5f4f0] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-[#57534e]">처리 구간 선택</p>
              <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-100 rounded-lg px-2 py-0.5 tabular-nums">
                {formatTime(cropStart)} ~ {formatTime(cropEnd)}
                <span className="text-blue-400 ml-1">({Math.round(cropDuration)}초)</span>
              </span>
            </div>

            <div className="flex flex-col gap-4">
              {/* 시작 지점 */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide">
                    시작
                  </label>
                  <span className="text-[11px] font-semibold text-[#57534e] tabular-nums">
                    {formatTime(cropStart)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, Math.floor(fileDuration) - 1)}
                  step={1}
                  value={cropStart}
                  onChange={(e) => handleCropStartChange(Number(e.target.value))}
                  className="w-full h-2 accent-blue-600 cursor-pointer"
                />
              </div>

              {/* 끝 지점 */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide">
                    끝
                  </label>
                  <span className="text-[11px] font-semibold text-[#57534e] tabular-nums">
                    {formatTime(cropEnd)}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={Math.ceil(fileDuration)}
                  step={1}
                  value={cropEnd}
                  onChange={(e) => handleCropEndChange(Number(e.target.value))}
                  className="w-full h-2 accent-blue-600 cursor-pointer"
                />
              </div>
            </div>

            {cropDuration > CROP_LIMIT_SEC && (
              <p className="text-xs text-amber-600 mt-2.5">
                ⚠ 최대 60초까지 선택할 수 있습니다. 범위를 줄여 주세요.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Step 2: 목표 언어 + 자막 설정 ─────────────────────────────────── */}
      <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-7 h-7 rounded-lg bg-[rgba(37,99,235,0.1)] text-blue-600 text-[13px] font-bold flex items-center justify-center flex-shrink-0">
            02
          </span>
          <div>
            <p className="text-sm font-semibold text-[#1a1917]">목표 언어</p>
            <p className="text-xs text-[#a8a29e]">원본 언어는 자동으로 감지됩니다</p>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_40px_1fr] items-end gap-2">
          <div>
            <label className="block text-[11px] font-medium text-[#a8a29e] uppercase tracking-widest mb-1.5">
              원본
            </label>
            <div className="w-full border border-[#e4e3df] rounded-xl px-3 py-2.5 text-sm font-medium text-[#a8a29e] bg-[#f5f4f0] select-none">
              자동 감지
            </div>
          </div>
          <div className="flex items-center justify-center h-[42px] text-[#a8a29e] text-base">
            →
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[#a8a29e] uppercase tracking-widest mb-1.5">
              목표
            </label>
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              className="w-full border-[1.5px] border-[#e4e3df] rounded-xl px-3 py-2.5 text-sm font-medium text-[#1a1917] bg-[#f5f4f0] focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none cursor-pointer transition-all appearance-none"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 번역 자막 토글 */}
        <div className="mt-4 pt-4 border-t border-[#e4e3df]">
          <button
            type="button"
            onClick={() => setShowSubtitles((v) => !v)}
            className="flex items-center gap-3 w-full text-left group"
          >
            {/* 토글 스위치 */}
            <div
              className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors duration-200 ${
                showSubtitles ? "bg-blue-600" : "bg-[#d0cfc9]"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                  showSubtitles ? "translate-x-4" : ""
                }`}
              />
            </div>
            <div>
              <p className="text-sm font-medium text-[#1a1917] group-hover:text-blue-600 transition-colors">
                번역 자막 표시
              </p>
              <p className="text-xs text-[#a8a29e]">
                더빙 재생 시 번역문을 자막으로 표시합니다
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* ── 더빙 생성 버튼 ──────────────────────────────────────────────────── */}
      <button
        type="submit"
        disabled={!file || status === "loading"}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-[#93c5fd] text-white rounded-2xl px-6 py-4 text-[15px] font-semibold transition-all hover:-translate-y-px hover:shadow-[0_6px_20px_rgba(37,99,235,0.28)] active:translate-y-0 disabled:cursor-not-allowed"
      >
        {status === "loading" ? (
          <>
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            처리 중…
          </>
        ) : (
          "더빙 생성"
        )}
      </button>
      {status !== "loading" && (
        <p className="text-center text-xs text-[#a8a29e]">보통 15~45초 정도 소요됩니다</p>
      )}

      {/* ── 로딩 카드 ────────────────────────────────────────────────────────── */}
      {status === "loading" && (
        <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full border-[3px] border-[#e4e3df] border-t-blue-600 animate-spin" />
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-sm font-semibold text-[#1a1917]">
                {step === 0 && "파일 확인 중…"}
                {step === 1 && (isVideoFile ? "영상에서 오디오 추출 중…" : "음원 전처리 중…")}
                {step === 2 && "서버에서 처리 중…"}
              </p>
              {step === 2 && (
                <div className="flex flex-wrap items-center justify-center gap-1.5 mt-1">
                  <span className="text-xs font-medium text-blue-500">음성 전사</span>
                  <span className="text-xs text-[#a8a29e]">→</span>
                  <span className="text-xs font-medium text-blue-500">{selectedLabel} 번역</span>
                  <span className="text-xs text-[#a8a29e]">→</span>
                  <span className="text-xs font-medium text-blue-500">음성 합성</span>
                </div>
              )}
              <p className="text-xs text-[#a8a29e] mt-0.5">오디오 길이에 따라 15~45초 소요됩니다</p>
            </div>
          </div>
        </div>
      )}

      {/* ── 오류 ──────────────────────────────────────────────────────────────── */}
      {status === "error" && error && (
        <div className="bg-white border border-red-100 rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <p className="text-sm font-semibold text-red-700 mb-1">오류가 발생했습니다</p>
          <p className="whitespace-pre-wrap text-sm text-red-600">{error}</p>
          <p className="mt-2.5 text-xs text-red-400">
            다른 파일 형식으로 시도하거나, 더 짧은 오디오 파일을 업로드해 보세요.
          </p>
        </div>
      )}

      {/* ── 결과 ──────────────────────────────────────────────────────────────── */}
      {status === "done" && result && (
        <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2.5 mb-5">
            <span className="w-7 h-7 rounded-full bg-[#dcfce7] text-green-600 flex items-center justify-center text-sm flex-shrink-0">
              ✓
            </span>
            <div>
              <p className="text-sm font-semibold text-[#1a1917]">더빙 완료</p>
              <p className="text-xs text-[#a8a29e]">{selectedLabel}로 더빙되었습니다</p>
            </div>
          </div>

          <div className="flex flex-col gap-4">

            {/* ── 멀티 재생 플레이어 ──────────────────────────────────────────── */}
            <div>
              {/* 원본 / 더빙 탭 */}
              <div className="flex rounded-xl border border-[#e4e3df] overflow-hidden mb-3">
                <button
                  type="button"
                  onClick={() => setPlaybackMode("original")}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    playbackMode === "original"
                      ? "bg-blue-600 text-white"
                      : "bg-[#f5f4f0] text-[#57534e] hover:text-[#1a1917]"
                  }`}
                >
                  원본
                </button>
                <button
                  type="button"
                  onClick={() => setPlaybackMode("dubbed")}
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    playbackMode === "dubbed"
                      ? "bg-blue-600 text-white"
                      : "bg-[#f5f4f0] text-[#57534e] hover:text-[#1a1917]"
                  }`}
                >
                  더빙
                </button>
              </div>

              {isVideoFile ? (
                /* 비디오 파일 ─────────────────────────────────────────────── */
                <div className="rounded-xl overflow-hidden bg-black">
                  {/* 원본 탭: 원본 영상 + 오디오 그대로 */}
                  {playbackMode === "original" && originalUrl && (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      src={originalUrl}
                      controls
                      playsInline
                      className="w-full max-h-72 object-contain"
                    />
                  )}

                  {/* 더빙 탭: 원본 영상(음소거) + 더빙 오디오 동기화 */}
                  {playbackMode === "dubbed" && originalUrl && audioUrl && (
                    <div className="relative">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        ref={videoRef}
                        src={originalUrl}
                        controls
                        playsInline
                        muted
                        className="w-full max-h-72 object-contain"
                      />
                      {/* 숨겨진 더빙 오디오 — videoRef 이벤트에 연동 */}
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio ref={dubAudioRef} src={audioUrl} />

                      {/* 번역 자막 오버레이 */}
                      {showSubtitles && (
                        <div className="absolute bottom-12 left-0 right-0 px-3 flex justify-center pointer-events-none">
                          <p className="bg-black/75 text-white text-sm leading-relaxed rounded-lg px-3 py-1.5 text-center max-w-full backdrop-blur-sm">
                            {result.translation}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* 오디오 파일: 원본/더빙 오디오 플레이어 ─────────────────── */
                <div>
                  {playbackMode === "original" && originalUrl && (
                    <div>
                      <p className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide mb-2">
                        원본 오디오
                      </p>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio controls src={originalUrl} className="w-full" />
                    </div>
                  )}
                  {playbackMode === "dubbed" && audioUrl && (
                    <div>
                      <p className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide mb-2">
                        더빙 오디오
                      </p>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio controls src={audioUrl} className="w-full" />
                      {/* 번역 자막 */}
                      {showSubtitles && (
                        <div className="mt-3 bg-[#1a1917] text-white text-sm leading-relaxed rounded-xl px-4 py-3 text-center">
                          {result.translation}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="h-px bg-[#e4e3df]" />

            {/* 원문 전사 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[#a8a29e]">
                  원문 전사
                  {result.detectedLanguage && (
                    <span className="ml-2 normal-case text-blue-400">
                      {LANGUAGE_NAMES[result.detectedLanguage] ?? result.detectedLanguage}
                    </span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(
                      new Blob([result.transcript], { type: "text/plain" }),
                    );
                    a.download = "transcript.txt";
                    a.click();
                  }}
                  className="text-xs text-[#a8a29e] hover:text-blue-500 transition-colors"
                >
                  ↓ txt
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#57534e] bg-[#f5f4f0] rounded-xl px-4 py-3">
                {result.transcript}
              </p>
            </div>

            <div className="h-px bg-[#e4e3df]" />

            {/* 번역 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[#a8a29e]">
                  번역 — {selectedLabel}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(
                      new Blob([result.translation], { type: "text/plain" }),
                    );
                    a.download = `translation_${targetLanguage.toLowerCase()}.txt`;
                    a.click();
                  }}
                  className="text-xs text-[#a8a29e] hover:text-blue-500 transition-colors"
                >
                  ↓ txt
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#57534e] bg-[#f5f4f0] rounded-xl px-4 py-3">
                {result.translation}
              </p>
            </div>

            <div className="h-px bg-[#e4e3df]" />

            {/* MP3 다운로드 */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[#a8a29e] mb-2.5">
                더빙 다운로드
              </p>
              <button
                type="button"
                onClick={handleDownload}
                className="w-full flex items-center justify-center gap-2 bg-[#f5f4f0] border-[1.5px] border-[#d0cfc9] rounded-xl px-4 py-3 text-sm font-medium text-[#1a1917] hover:border-blue-500 hover:bg-[rgba(37,99,235,0.04)] hover:text-blue-600 transition-all"
              >
                ↓ MP3 다운로드
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 다시 더빙하기 */}
      {status === "done" && (
        <button
          type="button"
          onClick={() => selectFile(null)}
          className="w-full rounded-xl border border-[#e4e3df] py-2.5 text-sm font-medium text-[#a8a29e] hover:border-[#d0cfc9] hover:text-[#57534e] transition-colors"
        >
          다시 더빙하기
        </button>
      )}
    </form>
  );
}
