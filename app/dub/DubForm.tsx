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
  const bps = 2;
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
  v.setUint16(20, 1, true);
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

  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close();
  }

  const clampedStart = Math.max(0, Math.min(startSec, decoded.duration));
  const clampedEnd = Math.max(clampedStart + 0.1, Math.min(endSec, decoded.duration));
  const cropDuration = clampedEnd - clampedStart;

  const outRate = 22050;
  const outSamples = Math.ceil(outRate * cropDuration);
  const offCtx = new OfflineAudioContext(1, outSamples, outRate);

  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start(0, clampedStart, cropDuration);

  const rendered = await offCtx.startRendering();
  return encodeWAV(rendered);
}

/** VTT 타임스탬프 형식: "HH:MM:SS.mmm" */
function formatVTTTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    s.toFixed(3).padStart(6, "0")
  );
}

/**
 * 자막 청크 배열로 WebVTT 문자열 생성.
 * startOffset: 크롭 시작 시각(초) — 영상의 currentTime 기준에 맞게 오프셋.
 * totalDuration: 크롭 구간 길이(초) — 자막을 이 구간 전체에 고르게 분배.
 */
function buildVTT(chunks: string[], totalDuration: number, startOffset: number): string {
  const dur = Math.max(totalDuration, 1);
  const chunkDur = dur / Math.max(chunks.length, 1);
  let vtt = "WEBVTT\n\n";
  chunks.forEach((chunk, i) => {
    const start = startOffset + i * chunkDur;
    const end = startOffset + (i + 1) * chunkDur;
    // 이중 줄바꿈(\n\n)은 VTT 큐 종료 신호로 파싱되므로 단일 줄바꿈으로 압축
    const safeChunk = chunk.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    vtt += `${formatVTTTime(start)} --> ${formatVTTTime(end)}\n${safeChunk}\n\n`;
  });
  return vtt;
}

/**
 * 번역 텍스트를 2문장씩 묶어 자막 청크 배열로 분할한다.
 * 문장 구분이 없으면 약 60자 단위로 분할.
 */
function buildSubtitleChunks(text: string): string[] {
  const sentences = text
    .replace(/([.!?。！？])\s*/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    // 구두점이 없는 텍스트: 60자 단위로 분할
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 60) {
      chunks.push(text.slice(i, i + 60).trim());
    }
    return chunks.filter(Boolean);
  }

  // 2문장씩 묶기
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    chunks.push(sentences.slice(i, i + 2).join(" "));
  }
  return chunks;
}

/**
 * MediaRecorder로 영상의 [startSec, endSec] 구간을 실시간 녹화하여
 * 진짜 크롭된 영상 Blob을 반환한다.
 * captureStream 미지원 브라우저(iOS Safari 등)는 Error("CAPTURE_STREAM_UNSUPPORTED") 를 throw 한다.
 * 녹화 속도 = 실시간 (60초 구간 → 약 60초 소요).
 */
function cropVideoBlob(file: File, startSec: number, endSec: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const testEl = document.createElement("video");
    if (!("captureStream" in testEl)) {
      reject(new Error("CAPTURE_STREAM_UNSUPPORTED"));
      return;
    }

    const objUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = objUrl;
    video.muted = true;
    (video as HTMLVideoElement & { playsInline: boolean }).playsInline = true;

    const cleanup = () => URL.revokeObjectURL(objUrl);

    video.oncanplay = async () => {
      try {
        video.currentTime = startSec;
        await new Promise<void>((r) => {
          const onSeeked = () => { video.removeEventListener("seeked", onSeeked); r(); };
          video.addEventListener("seeked", onSeeked);
        });

        const stream = (video as unknown as { captureStream: () => MediaStream }).captureStream();
        const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => { cleanup(); resolve(new Blob(chunks, { type: mimeType })); };

        recorder.start(250);
        await video.play();

        const duration = endSec - startSec;
        const timer = setTimeout(() => {
          video.pause();
          if (recorder.state === "recording") recorder.stop();
        }, (duration + 1) * 1000);

        video.ontimeupdate = () => {
          if (video.currentTime >= endSec) {
            clearTimeout(timer);
            video.pause();
            if (recorder.state === "recording") recorder.stop();
          }
        };
      } catch (e) {
        cleanup();
        reject(e);
      }
    };

    video.onerror = () => { cleanup(); reject(new Error("video load failed")); };
    video.load();
  });
}

/**
 * video(음소거)와 audio(더빙)를 크롭 구간 [start, end] 내에서 동기화한다.
 * - 영상이 start 이전으로 스크럽되면 audio를 0으로 클램프
 * - 영상이 end를 넘으면 일시정지 후 start로 되감기
 * cleanup 함수를 반환한다.
 */
function attachDubSync(
  video: HTMLVideoElement,
  audio: HTMLAudioElement,
  start: number,
  end: number,
  dur: number | null,
): () => void {
  // 메타데이터 로드 후 크롭 시작 지점으로 이동
  const onLoaded = () => { if (start > 0) video.currentTime = start; };
  if (video.readyState >= 1) {
    if (start > 0) video.currentTime = start;
  } else {
    video.addEventListener("loadedmetadata", onLoaded);
  }

  // 네이티브 컨트롤로 음소거를 해제해도 항상 강제 음소거 유지
  // (해제하면 원본 오디오 트랙이 들리므로 반드시 막아야 함)
  video.muted = true;
  const onVolumeChange = () => { if (!video.muted) video.muted = true; };

  // video.currentTime 기준으로 더빙 오디오 오프셋 계산
  const onPlay = () => {
    audio.currentTime = Math.max(0, video.currentTime - start);
    audio.play();
  };
  const onPause = () => audio.pause();
  const onSeeked = () => {
    audio.currentTime = Math.max(0, video.currentTime - start);
  };
  // 크롭 끝 지점 도달 시 멈추고 시작 지점으로 복귀
  const onTimeUpdate = () => {
    if (dur !== null && end < dur && video.currentTime >= end) {
      video.pause();
      video.currentTime = start;
      audio.currentTime = 0;
    }
  };

  video.addEventListener("volumechange", onVolumeChange);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("timeupdate", onTimeUpdate);

  return () => {
    video.removeEventListener("volumechange", onVolumeChange);
    video.removeEventListener("loadedmetadata", onLoaded);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("timeupdate", onTimeUpdate);
  };
}

// ───────────────────────────────────────────────────────────────────────────

export default function DubForm() {
  const [file, setFile] = useState<File | null>(null);
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const [cropStart, setCropStart] = useState<number>(0);
  const [cropEnd, setCropEnd] = useState<number>(CROP_LIMIT_SEC);
  const [targetLanguage, setTargetLanguage] = useState<string>(SUPPORTED_LANGUAGES[0].code);
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [subtitleIndex, setSubtitleIndex] = useState<number>(0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [videoDownloadNotice, setVideoDownloadNotice] = useState<string | null>(null);
  // 영상이 MediaRecorder 로 실제 크롭된 경우 true → 플레이어 start=0 기준
  const [videoCropped, setVideoCropped] = useState<boolean>(false);
  const [isCroppingVideo, setIsCroppingVideo] = useState<boolean>(false);
  const [vttUrl, setVttUrl] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<"original" | "dubbed">("dubbed");
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<number>(-1);
  // step=2(서버 처리) 중 세부 단계: 0=전사 1=번역 2=음성합성
  const [substep, setSubstep] = useState<0 | 1 | 2>(0);
  const [result, setResult] = useState<DubResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // 더빙 video ↔ audio 동기화용 refs
  const videoRef = useRef<HTMLVideoElement>(null);          // 데스크탑 더빙 video
  const dubAudioRef = useRef<HTMLAudioElement>(null);       // 데스크탑 더빙 audio
  const mobileVideoRef = useRef<HTMLVideoElement>(null);    // 모바일 더빙 video
  const mobileDubAudioRef = useRef<HTMLAudioElement>(null); // 모바일 더빙 audio

  const blobUrlRef = useRef<string | null>(null);
  const origUrlRef = useRef<string | null>(null);
  const vttUrlRef = useRef<string | null>(null);
  // cropVideoBlob 진행 중 취소 신호 (selectFile 로 새 파일 선택 시 사용)
  const cropAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      if (origUrlRef.current) URL.revokeObjectURL(origUrlRef.current);
      if (vttUrlRef.current) URL.revokeObjectURL(vttUrlRef.current);
    };
  }, []);

  // 영상이 실제 크롭됐으면 start=0 기준, 아니면 cropStart 기준으로 동기화
  const effStart = videoCropped ? 0 : cropStart;
  const effEnd   = videoCropped ? cropEnd - cropStart : cropEnd;
  const effDur   = videoCropped ? cropEnd - cropStart : fileDuration;

  // 데스크탑 더빙 패널: 크롭 구간 동기화
  useEffect(() => {
    const video = videoRef.current;
    const audio = dubAudioRef.current;
    if (!video || !audio) return;
    return attachDubSync(video, audio, effStart, effEnd, effDur);
  }, [audioUrl, effStart, effEnd, effDur]);

  // 모바일 더빙 탭: 크롭 구간 동기화
  useEffect(() => {
    const video = mobileVideoRef.current;
    const audio = mobileDubAudioRef.current;
    if (!video || !audio) return;
    return attachDubSync(video, audio, effStart, effEnd, effDur);
  }, [audioUrl, effStart, effEnd, effDur]);

  // 결과가 바뀌면 자막 인덱스 초기화
  useEffect(() => { setSubtitleIndex(0); }, [result]);

  // 번역 결과 → WebVTT Blob 생성
  // 영상이 실제 크롭된 경우 startOffset=0, 아닌 경우 cropStart 오프셋 사용
  useEffect(() => {
    if (vttUrlRef.current) {
      URL.revokeObjectURL(vttUrlRef.current);
      vttUrlRef.current = null;
    }
    setVttUrl(null);
    if (!result) return;

    const chunks = buildSubtitleChunks(result.translation);
    const duration = Math.max(cropEnd - cropStart, 1);
    const startOffset = videoCropped ? 0 : cropStart;
    const blob = new Blob([buildVTT(chunks, duration, startOffset)], { type: "text/vtt" });
    const url = URL.createObjectURL(blob);
    vttUrlRef.current = url;
    setVttUrl(url);
  }, [result, cropStart, cropEnd, videoCropped]);

  // showSubtitles 토글 → 모든 video 요소의 track.mode 갱신
  useEffect(() => {
    [videoRef, mobileVideoRef].forEach((ref) => {
      const video = ref.current;
      if (!video) return;
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = showSubtitles ? "showing" : "hidden";
      }
    });
  }, [showSubtitles, vttUrl]);

  // 데스크탑 더빙 영상: timeupdate → 자막 인덱스 갱신
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !result) return;
    const chunks = buildSubtitleChunks(result.translation);
    const update = () => {
      const elapsed = video.currentTime - effStart;
      const p = Math.max(0, Math.min(1, elapsed / Math.max(1, effEnd - effStart)));
      setSubtitleIndex(Math.min(Math.floor(p * chunks.length), chunks.length - 1));
    };
    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [audioUrl, result, effStart, effEnd]);

  // 모바일 더빙 영상: timeupdate → 자막 인덱스 갱신
  useEffect(() => {
    const video = mobileVideoRef.current;
    if (!video || !result) return;
    const chunks = buildSubtitleChunks(result.translation);
    const update = () => {
      const elapsed = video.currentTime - effStart;
      const p = Math.max(0, Math.min(1, elapsed / Math.max(1, effEnd - effStart)));
      setSubtitleIndex(Math.min(Math.floor(p * chunks.length), chunks.length - 1));
    };
    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [audioUrl, result, effStart, effEnd]);

  // step=2 진입 시 세부 단계 타이머: 전사(~8s) → 번역(~5s) → 음성합성
  useEffect(() => {
    if (step !== 2) { setSubstep(0); return; }
    setSubstep(0);
    const t1 = window.setTimeout(() => setSubstep(1), 8000);
    const t2 = window.setTimeout(() => setSubstep(2), 13000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [step]);

  const selectFile = async (selected: File | null) => {
    // 진행 중인 영상 크롭 취소
    cropAbortRef.current.cancelled = true;
    cropAbortRef.current = { cancelled: false };

    setFile(selected);
    setFileDuration(null);
    setCropStart(0);
    setCropEnd(CROP_LIMIT_SEC);
    setResult(null);
    setError(null);
    setStatus("idle");
    setAudioUrl(null);
    setPlaybackMode("dubbed");
    setVideoCropped(false);
    setIsCroppingVideo(false);

    if (origUrlRef.current) {
      URL.revokeObjectURL(origUrlRef.current);
      origUrlRef.current = null;
      setOriginalUrl(null);
    }

    if (!selected) return;

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
      el.onerror = () => resolve();
    });

    if (Number.isFinite(el.duration)) {
      const dur = el.duration;
      setFileDuration(dur);
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

  const handleCropStartChange = (val: number) => {
    const newStart = Math.min(val, cropEnd - 1);
    setCropStart(newStart);
    if (cropEnd - newStart > CROP_LIMIT_SEC) setCropEnd(newStart + CROP_LIMIT_SEC);
  };

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
          setError(
            "이 영상에서 오디오를 추출하지 못했습니다. " +
            "MP4 또는 WebM 파일인지 확인하거나, 오디오 파일을 직접 업로드해 보세요.\n" +
            "MOV·HEVC 등 일부 코덱은 현재 브라우저가 지원하지 않을 수 있습니다.",
          );
          setStatus("error");
          setStep(-1);
          return;
        }
        console.warn("[audio crop] failed, falling back to original:", extractErr);
        uploadBlob = file;
        uploadFilename = file.name;
      }
    }

    // ── 영상 크롭을 API 호출과 동시에 시작 ──────────────────────────────
    // 병렬 실행하면 총 대기 시간 = max(API 시간, 크롭 시간).
    // API 완료 후 크롭을 시작하던 기존 방식 대비 최대 60초 절약.
    const abortCtrl = cropAbortRef.current;
    const snapStart = cropStart;
    const snapEnd = cropEnd;
    let cropPromise: Promise<Blob | null> = Promise.resolve(null);

    if (isVideo && (cropStart > 0 || cropEnd < (fileDuration ?? Infinity))) {
      const testEl = document.createElement("video");
      if ("captureStream" in testEl) {
        setIsCroppingVideo(true);
        cropPromise = cropVideoBlob(file, snapStart, snapEnd).catch((e) => {
          if ((e as Error).message !== "CAPTURE_STREAM_UNSUPPORTED") {
            console.warn("[cropVideo] fallback to fragment:", e);
          }
          return null;
        });
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

      // API가 먼저 끝난 경우 크롭 완료까지 대기
      const croppedBlob = await cropPromise;
      if (!abortCtrl.cancelled) {
        if (croppedBlob) {
          const newUrl = URL.createObjectURL(croppedBlob);
          if (origUrlRef.current) URL.revokeObjectURL(origUrlRef.current);
          origUrlRef.current = newUrl;
          setOriginalUrl(newUrl);
          setVideoCropped(true);
        }
        setIsCroppingVideo(false);
      }
    } catch (err) {
      // API 에러 시 크롭 프로미스의 미처리 거부만 억제 (blob은 GC에 맡김)
      cropPromise.catch(() => {});
      if (!abortCtrl.cancelled) setIsCroppingVideo(false);

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

  /**
   * 영상 다운로드: 원본 영상(음소거) + 더빙 오디오를 MediaRecorder로 실시간 합성.
   * captureStream 미지원 브라우저(Firefox 일부, iOS Safari)에서는 MP3 폴백.
   */
  const handleVideoDownload = async () => {
    if (!originalUrl || !audioUrl) return;

    const testEl = document.createElement("video");
    if (!("captureStream" in testEl)) {
      // iOS Safari 등 captureStream 미지원 → MP3로 폴백하며 사용자에게 안내
      setVideoDownloadNotice(
        "이 브라우저는 영상 합성을 지원하지 않아 더빙 MP3만 다운로드됩니다.\n" +
        "영상 파일로 받으려면 Chrome 또는 Edge를 사용해 주세요."
      );
      setTimeout(() => setVideoDownloadNotice(null), 7000);
      handleDownload();
      return;
    }

    setIsRecording(true);
    try {
      const video = document.createElement("video");
      video.src = originalUrl;
      video.muted = true;
      (video as HTMLVideoElement & { playsInline: boolean }).playsInline = true;

      const audio = document.createElement("audio");
      audio.src = audioUrl;

      // 메타데이터 로드 대기
      await Promise.all([
        new Promise<void>((r) => { video.oncanplay = () => r(); video.load(); }),
        new Promise<void>((r) => { audio.oncanplay = () => r(); audio.load(); }),
      ]);

      video.currentTime = cropStart;
      audio.currentTime = 0;

      const videoStream = (video as unknown as { captureStream: () => MediaStream }).captureStream();
      const audioCtx = new AudioContext();
      const audioSrc = audioCtx.createMediaElementSource(audio);
      const audioDest = audioCtx.createMediaStreamDestination();
      audioSrc.connect(audioDest);

      const combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]);

      const mimeType =
        MediaRecorder.isTypeSupported("video/mp4")
          ? "video/mp4"
          : "video/webm";

      const recorder = new MediaRecorder(combined, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        await audioCtx.close();
        const ext = mimeType === "video/mp4" ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dubbed_${targetLanguage.toLowerCase()}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setIsRecording(false);
      };

      recorder.start(250);
      await Promise.all([video.play(), audio.play()]);

      // 더빙 오디오 종료 시 녹화 중단 (더빙 = 크롭 구간 길이)
      audio.onended = () => {
        video.pause();
        if (recorder.state === "recording") recorder.stop();
      };
      // 안전 타임아웃
      setTimeout(() => {
        if (recorder.state === "recording") { video.pause(); audio.pause(); recorder.stop(); }
      }, (cropEnd - cropStart + 2) * 1000);
    } catch (e) {
      console.error("[video download]", e);
      setIsRecording(false);
      handleDownload(); // 실패 시 MP3 폴백
    }
  };

  const selectedLabel =
    SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.label ?? targetLanguage;
  const isVideoFile = file?.type.startsWith("video/") ?? false;
  const cropDuration = cropEnd - cropStart;
  const showCropSlider = fileDuration !== null && fileDuration >= 2;

  // 크롭 구간이 있으면 Media Fragments URI (#t=start,end) 를 임시 fallback 으로 사용.
  // MediaRecorder 크롭이 완료(videoCropped=true)되면 originalUrl 자체가 진짜 크롭 blob
  // 이므로 fragment 없이 그대로 사용한다.
  const isCropped =
    cropStart > 0 || (fileDuration !== null && cropEnd < fileDuration);
  const videoSrc = originalUrl
    ? (videoCropped || !isCropped)
      ? originalUrl
      : `${originalUrl}#t=${cropStart},${cropEnd}`
    : null;

  // 현재 재생 위치에 해당하는 2줄짜리 자막
  const subtitleChunks = result ? buildSubtitleChunks(result.translation) : [];
  const currentSubtitle = subtitleChunks[subtitleIndex] ?? "";

  // ── 공통 UI 조각 ────────────────────────────────────────────────────────────

  // 결과 섹션 (텍스트 + 다운로드) — 좌측 컬럼 + 모바일 모두 사용
  const resultTextPanel = result && (
    <div className="flex flex-col gap-4">
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
              a.href = URL.createObjectURL(new Blob([result.transcript], { type: "text/plain" }));
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
              a.href = URL.createObjectURL(new Blob([result.translation], { type: "text/plain" }));
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

      {/* 다운로드 */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[#a8a29e] mb-2.5">
          더빙 다운로드
        </p>
        <div className="flex flex-col gap-2">
          {/* 영상 다운로드 (영상 파일인 경우만) */}
          {isVideoFile && (
            <button
              type="button"
              onClick={handleVideoDownload}
              disabled={isRecording}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-[#93c5fd] text-white rounded-xl px-4 py-3 text-sm font-medium transition-all disabled:cursor-not-allowed"
            >
              {isRecording ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  영상 합성 중… (재생 시간만큼 소요)
                </>
              ) : (
                "↓ 영상 다운로드 (더빙 합성)"
              )}
            </button>
          )}
          {/* MP3 다운로드 */}
          <button
            type="button"
            onClick={handleDownload}
            className="w-full flex items-center justify-center gap-2 bg-[#f5f4f0] border-[1.5px] border-[#d0cfc9] rounded-xl px-4 py-3 text-sm font-medium text-[#1a1917] hover:border-blue-500 hover:bg-[rgba(37,99,235,0.04)] hover:text-blue-600 transition-all"
          >
            ↓ MP3 다운로드
          </button>
          {/* iOS Safari 등 captureStream 미지원 시 안내 */}
          {videoDownloadNotice && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <span className="text-amber-500 flex-shrink-0 mt-0.5">⚠</span>
              <p className="text-xs text-amber-700 whitespace-pre-line leading-relaxed">{videoDownloadNotice}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    // 데스크탑: 2컬럼 그리드 / 모바일: 단일 컬럼
    <div className="w-full grid md:grid-cols-2 md:gap-6 md:items-start gap-3">

      {/* ── 왼쪽 컬럼: 폼 ───────────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">

        {/* Step 01: 파일 선택 */}
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
                  <span key={f} className="bg-[#f5f4f0] border border-[#e4e3df] rounded-md px-2 py-0.5 text-[11px] font-medium text-[#a8a29e] tracking-wide">
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

          {/* 크롭 범위 슬라이더 */}
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
                <div>
                  <div className="flex justify-between mb-1.5">
                    <label className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide">시작</label>
                    <span className="text-[11px] font-semibold text-[#57534e] tabular-nums">{formatTime(cropStart)}</span>
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
                <div>
                  <div className="flex justify-between mb-1.5">
                    <label className="text-[11px] font-medium text-[#a8a29e] uppercase tracking-wide">끝</label>
                    <span className="text-[11px] font-semibold text-[#57534e] tabular-nums">{formatTime(cropEnd)}</span>
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

        {/* Step 02: 목표 언어 + 자막 토글 */}
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
              <label className="block text-[11px] font-medium text-[#a8a29e] uppercase tracking-widest mb-1.5">원본</label>
              <div className="w-full border border-[#e4e3df] rounded-xl px-3 py-2.5 text-sm font-medium text-[#a8a29e] bg-[#f5f4f0] select-none">
                자동 감지
              </div>
            </div>
            <div className="flex items-center justify-center h-[42px] text-[#a8a29e] text-base">→</div>
            <div>
              <label className="block text-[11px] font-medium text-[#a8a29e] uppercase tracking-widest mb-1.5">목표</label>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                className="w-full border-[1.5px] border-[#e4e3df] rounded-xl px-3 py-2.5 text-sm font-medium text-[#1a1917] bg-[#f5f4f0] focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none cursor-pointer transition-all appearance-none"
              >
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 자막 토글 */}
          <div className="mt-4 pt-4 border-t border-[#e4e3df]">
            <button
              type="button"
              onClick={() => setShowSubtitles((v) => !v)}
              className="flex items-center gap-3 w-full text-left group"
            >
              <div className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors duration-200 ${showSubtitles ? "bg-blue-600" : "bg-[#d0cfc9]"}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${showSubtitles ? "translate-x-4" : ""}`} />
              </div>
              <div>
                <p className="text-sm font-medium text-[#1a1917] group-hover:text-blue-600 transition-colors">번역 자막 표시</p>
                <p className="text-xs text-[#a8a29e]">더빙 재생 시 번역문을 자막으로 표시합니다</p>
              </div>
            </button>
          </div>
        </div>

        {/* 더빙 생성 버튼 */}
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
          ) : "더빙 생성"}
        </button>
        {status !== "loading" && (
          <p className="text-center text-xs text-[#a8a29e]">보통 15~45초 정도 소요됩니다</p>
        )}

        {/* 로딩 카드 */}
        {status === "loading" && (() => {
          const PIPELINE = [
            {
              icon: "🎙",
              label: "음성 전사",
              desc: "말소리를 텍스트로 변환 중",
            },
            {
              icon: "🌐",
              label: `${selectedLabel} 번역`,
              desc: "전사된 텍스트를 번역 중",
            },
            {
              icon: "🔊",
              label: "더빙 음성 생성",
              desc: "번역문으로 새 목소리 합성 중",
            },
          ];

          return (
            <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
              {/* 전처리 단계 (step 0·1) */}
              {step < 2 ? (
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="w-10 h-10 rounded-full border-[3px] border-[#e4e3df] border-t-blue-600 animate-spin" />
                  <div>
                    <p className="text-sm font-semibold text-[#1a1917]">
                      {step === 0 && "파일 준비 중…"}
                      {step === 1 && (isVideoFile ? "영상에서 오디오 추출 중…" : "오디오 구간 크롭 중…")}
                    </p>
                    <p className="text-xs text-[#a8a29e] mt-0.5">잠깐만요, 곧 서버에 전송합니다</p>
                  </div>
                </div>
              ) : (
                /* 서버 파이프라인 단계 (step 2) */
                <div className="flex flex-col gap-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[#a8a29e] text-center">
                    서버 처리 중
                  </p>
                  <div className="flex flex-col gap-2">
                    {PIPELINE.map((s, i) => {
                      const isDone    = substep > i;
                      const isActive  = substep === i;
                      return (
                        <div
                          key={i}
                          className={`flex items-center gap-3 rounded-xl px-4 py-3 transition-all ${
                            isActive
                              ? "bg-blue-50 border border-blue-200"
                              : isDone
                                ? "bg-[#f5f4f0] border border-[#e4e3df]"
                                : "bg-[#fafaf9] border border-[#efefed] opacity-40"
                          }`}
                        >
                          {/* 상태 아이콘 */}
                          <div className="flex-shrink-0 w-7 h-7 flex items-center justify-center">
                            {isDone ? (
                              <span className="text-green-500 text-base">✓</span>
                            ) : isActive ? (
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
                            ) : (
                              <span className="text-base">{s.icon}</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold ${isActive ? "text-blue-700" : isDone ? "text-[#57534e]" : "text-[#a8a29e]"}`}>
                              {s.label}
                            </p>
                            {isActive && (
                              <p className="text-xs text-blue-500 mt-0.5">{s.desc}</p>
                            )}
                          </div>
                          {isDone && (
                            <span className="text-xs text-green-500 font-medium flex-shrink-0">완료</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-[#a8a29e] text-center">보통 15~45초 소요됩니다</p>
                </div>
              )}
            </div>
          );
        })()}

        {/* 오류 */}
        {status === "error" && error && (
          <div className="bg-white border border-red-100 rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <p className="text-sm font-semibold text-red-700 mb-1">오류가 발생했습니다</p>
            <p className="whitespace-pre-wrap text-sm text-red-600">{error}</p>
            <p className="mt-2.5 text-xs text-red-400">
              다른 파일 형식으로 시도하거나, 더 짧은 오디오 파일을 업로드해 보세요.
            </p>
          </div>
        )}

        {/* 결과 텍스트 + 다운로드 (데스크탑: 왼쪽 컬럼 / 모바일: 여기 표시) */}
        {status === "done" && result && (
          <div className="bg-white border border-[#e4e3df] rounded-2xl p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-2.5 mb-5">
              <span className="w-7 h-7 rounded-full bg-[#dcfce7] text-green-600 flex items-center justify-center text-sm flex-shrink-0">✓</span>
              <div>
                <p className="text-sm font-semibold text-[#1a1917]">더빙 완료</p>
                <p className="text-xs text-[#a8a29e]">{selectedLabel}로 더빙되었습니다</p>
              </div>
            </div>

            {/* 모바일 전용: 원본/더빙 탭 플레이어 */}
            <div className="md:hidden mb-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex flex-1 rounded-xl border border-[#e4e3df] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPlaybackMode("original")}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                      playbackMode === "original" ? "bg-blue-600 text-white" : "bg-[#f5f4f0] text-[#57534e]"
                    }`}
                  >
                    원본
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlaybackMode("dubbed")}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                      playbackMode === "dubbed" ? "bg-blue-600 text-white" : "bg-[#f5f4f0] text-[#57534e]"
                    }`}
                  >
                    더빙
                  </button>
                </div>
                {/* 자막 토글 */}
                <button
                  type="button"
                  onClick={() => setShowSubtitles((v) => !v)}
                  className={`flex-shrink-0 text-xs font-medium rounded-xl px-3 py-2.5 border transition-colors ${
                    showSubtitles
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-[#f5f4f0] text-[#a8a29e] border-[#e4e3df]"
                  }`}
                >
                  자막 {showSubtitles ? "ON" : "OFF"}
                </button>
              </div>

              {isVideoFile ? (
                <div className="rounded-xl overflow-hidden bg-black">
                  {playbackMode === "original" && originalUrl && (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      src={videoSrc ?? originalUrl}
                      controls
                      playsInline
                      className="w-full max-h-64 object-contain"
                    />
                  )}
                  {playbackMode === "dubbed" && originalUrl && audioUrl && (
                    <div className="relative">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        key={videoSrc ?? originalUrl ?? ""}
                        ref={mobileVideoRef}
                        src={videoSrc ?? originalUrl}
                        controls
                        playsInline
                        muted
                        className="w-full max-h-64 object-contain"
                      >
                        {/* WebVTT 트랙: 전체화면 포함 자막 렌더링 */}
                        {vttUrl && (
                          <track
                            kind="subtitles"
                            src={vttUrl}
                            label={selectedLabel}
                            default={showSubtitles}
                          />
                        )}
                      </video>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio ref={mobileDubAudioRef} src={audioUrl} />
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  {playbackMode === "original" && originalUrl && (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <audio controls src={originalUrl ?? undefined} className="w-full" />
                  )}
                  {playbackMode === "dubbed" && audioUrl && (
                    <div>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio controls src={audioUrl} className="w-full" />
                      {showSubtitles && currentSubtitle && (
                        <div className="mt-3 bg-[#1a1917] text-white text-sm leading-relaxed rounded-xl px-4 py-3 text-center">
                          {currentSubtitle}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="h-px bg-[#e4e3df] mt-4" />
            </div>

            {resultTextPanel}
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

      {/* ── 오른쪽 컬럼: 플레이어 패널 (데스크탑만) ────────────────────────── */}
      <div className="hidden md:flex flex-col gap-3 sticky top-[5rem]">

        {/* 원본 패널 */}
        <div className="bg-white border border-[#e4e3df] rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
          <div className="px-5 py-3.5 border-b border-[#e4e3df] flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#d0cfc9]" />
            <p className="text-xs font-semibold uppercase tracking-widest text-[#a8a29e]">원본</p>
            {isCroppingVideo && (
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-600">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-200 border-t-amber-600" />
                영상 크롭 중…
              </span>
            )}
          </div>

          {videoSrc || originalUrl ? (
            isVideoFile ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={videoSrc ?? originalUrl!}
                controls
                playsInline
                className="w-full aspect-video object-contain bg-black"
              />
            ) : (
              <div className="p-4">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio controls src={originalUrl ?? undefined} className="w-full" />
              </div>
            )
          ) : (
            /* 파일 미선택 플레이스홀더 */
            <div className="flex flex-col items-center justify-center gap-2 py-10 px-6 text-center">
              <div className="w-10 h-10 rounded-xl bg-[#f5f4f0] border border-[#e4e3df] flex items-center justify-center text-lg">
                🎬
              </div>
              <p className="text-sm font-medium text-[#a8a29e]">파일을 선택하면</p>
              <p className="text-xs text-[#c8c7c2]">여기에 원본이 표시됩니다</p>
            </div>
          )}
        </div>

        {/* 화살표 */}
        <div className="flex items-center justify-center gap-3 py-1">
          <div className="flex-1 h-px bg-[#e4e3df]" />
          <span className="text-[#c8c7c2] text-lg select-none">↓</span>
          <div className="flex-1 h-px bg-[#e4e3df]" />
        </div>

        {/* 더빙 패널 */}
        <div className="bg-white border border-[#e4e3df] rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.06)]">
          <div className="px-5 py-3.5 border-b border-[#e4e3df] flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${audioUrl ? "bg-blue-500" : "bg-[#d0cfc9]"}`} />
            <p className="text-xs font-semibold uppercase tracking-widest text-[#a8a29e]">더빙</p>
            {audioUrl && (
              <>
                <span className="text-[11px] font-medium text-blue-500 bg-blue-50 rounded-md px-1.5 py-0.5">
                  {selectedLabel}
                </span>
                {/* 자막 토글 — 플레이어 헤더에서 바로 켜고 끄기 */}
                <button
                  type="button"
                  onClick={() => setShowSubtitles((v) => !v)}
                  className={`ml-auto flex items-center gap-1.5 text-[11px] font-medium rounded-md px-2 py-0.5 transition-colors ${
                    showSubtitles
                      ? "bg-blue-600 text-white"
                      : "bg-[#f5f4f0] text-[#a8a29e] hover:text-[#57534e]"
                  }`}
                >
                  자막 {showSubtitles ? "ON" : "OFF"}
                </button>
              </>
            )}
          </div>

          {audioUrl && originalUrl ? (
            isVideoFile ? (
              /* 영상: 원본 영상(음소거) + 더빙 오디오 동기화 */
              <div className="relative">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  key={videoSrc ?? originalUrl ?? ""}
                  ref={videoRef}
                  src={videoSrc ?? originalUrl}
                  controls
                  playsInline
                  muted
                  className="w-full aspect-video object-contain bg-black"
                >
                  {/* WebVTT 트랙: 일반 + 전체화면 모두 자막 표시 */}
                  {vttUrl && (
                    <track
                      kind="subtitles"
                      src={vttUrl}
                      label={selectedLabel}
                      default={showSubtitles}
                    />
                  )}
                </video>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio ref={dubAudioRef} src={audioUrl} />
              </div>
            ) : (
              /* 오디오: 더빙 오디오 플레이어 */
              <div className="p-4 flex flex-col gap-3">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio controls src={audioUrl} className="w-full" />
                {showSubtitles && currentSubtitle && (
                  <div className="bg-[#1a1917] text-white text-sm leading-relaxed rounded-xl px-4 py-3 text-center">
                    {currentSubtitle}
                  </div>
                )}
              </div>
            )
          ) : (
            /* 더빙 미완료 플레이스홀더 */
            <div className="flex flex-col items-center justify-center gap-2 py-10 px-6 text-center">
              <div className="w-10 h-10 rounded-xl bg-[#f5f4f0] border border-[#e4e3df] flex items-center justify-center text-lg">
                {status === "loading" ? (
                  <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[#e4e3df] border-t-blue-500" />
                ) : "🎙️"}
              </div>
              <p className="text-sm font-medium text-[#a8a29e]">
                {status === "loading" ? "더빙 생성 중…" : "더빙 완료 후"}
              </p>
              <p className="text-xs text-[#c8c7c2]">
                {status === "loading" ? "" : "여기에 결과가 표시됩니다"}
              </p>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
