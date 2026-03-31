import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { transcribe, textToSpeech, WordTimestamp } from "@/lib/elevenlabs";
import { translateBatch } from "@/lib/translate";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

// Allow up to 60 s for the full STT → translate → TTS pipeline
export const maxDuration = 60;

// ── 인메모리 레이트 리미터 ────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 10 * 60 * 1000; // 10분 윈도우(ms)

interface RateEntry { count: number; resetAt: number }
const rateLimitMap = new Map<string, RateEntry>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();

  if (rateLimitMap.size > 500) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// ── 단어 → 발화 세그먼트 그룹화 ─────────────────────────────────────────────
// silenceThreshold(초) 이상 묵음이 있으면 새 세그먼트로 분리
function groupWords(
  words: WordTimestamp[],
  silenceThreshold = 0.4,
): Array<{ start: number; end: number; text: string }> {
  const speechWords = words.filter((w) => w.type === "word" && w.text.trim());
  if (speechWords.length === 0) return [];

  const segments: Array<{ start: number; end: number; text: string }> = [];
  let cur = { start: speechWords[0].start, end: speechWords[0].end, text: speechWords[0].text };

  for (let i = 1; i < speechWords.length; i++) {
    const w = speechWords[i];
    if (w.start - cur.end >= silenceThreshold) {
      segments.push({ ...cur, text: cur.text.trim() });
      cur = { start: w.start, end: w.end, text: w.text };
    } else {
      cur.end = w.end;
      cur.text += " " + w.text;
    }
  }
  segments.push({ ...cur, text: cur.text.trim() });
  return segments;
}

// ── 단계별 오류 → 한국어 친화 메시지 변환 ──────────────────────────────────

function errCode(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sttError(err: unknown): string {
  const c = errCode(err);
  if (c === "ELEVENLABS_QUOTA") return "ElevenLabs 음성 인식(STT) 크레딧이 소진되었습니다. ElevenLabs 대시보드에서 크레딧을 충전해 주세요.";
  if (c === "ELEVENLABS_RATE_LIMIT") return "ElevenLabs API 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (c === "ELEVENLABS_AUTH") return "ElevenLabs API 키가 올바르지 않습니다. .env.local의 ELEVENLABS_API_KEY를 확인해 주세요.";
  return `음성 인식(STT) 중 오류가 발생했습니다: ${c}`;
}

function translateError(err: unknown): string {
  const c = errCode(err);
  if (c === "DEEPL_QUOTA") return "DeepL 번역 API 월간 무료 한도(500,000자)를 초과했습니다. DeepL 계정에서 사용량을 확인하거나 유료 플랜으로 업그레이드해 주세요.";
  if (c === "DEEPL_RATE_LIMIT") return "DeepL API 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (c === "DEEPL_AUTH") return "DeepL API 키가 올바르지 않습니다. .env.local의 DEEPL_API_KEY를 확인해 주세요.";
  return `번역 중 오류가 발생했습니다: ${c}`;
}

function ttsError(err: unknown): string {
  const c = errCode(err);
  if (c === "ELEVENLABS_QUOTA") return "ElevenLabs 음성 합성(TTS) 크레딧이 소진되었습니다. ElevenLabs 대시보드에서 크레딧을 충전해 주세요.";
  if (c === "ELEVENLABS_RATE_LIMIT") return "ElevenLabs API 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (c === "ELEVENLABS_AUTH") return "ElevenLabs API 키가 올바르지 않습니다. .env.local의 ELEVENLABS_API_KEY를 확인해 주세요.";
  if (c === "ELEVENLABS_PLAN") return "선택한 ElevenLabs 보이스는 현재 플랜에서 사용할 수 없습니다. ElevenLabs Voice Lab에서 직접 소유한 보이스 ID를 ELEVENLABS_VOICE_ID에 설정해 주세요.";
  return `음성 합성(TTS) 중 오류가 발생했습니다: ${c}`;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user?.email ?? "unknown";
  if (isRateLimited(userId)) {
    return NextResponse.json(
      { error: `요청이 너무 많습니다. 10분당 최대 ${RATE_LIMIT_MAX}회까지 가능합니다. 잠시 후 다시 시도해 주세요.` },
      { status: 429 }
    );
  }

  try {
    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;
    const targetLanguage = formData.get("targetLanguage") as string | null;

    if (!audioFile || !targetLanguage) {
      return NextResponse.json(
        { error: "Missing required fields: audio and targetLanguage" },
        { status: 400 }
      );
    }

    const validLang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage);
    if (!validLang) {
      return NextResponse.json({ error: "Unsupported target language" }, { status: 400 });
    }

    // 1. Read audio into buffer
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());

    // 2. STT with word-level timestamps
    let transcript: string;
    let languageCode: string | null;
    let words: WordTimestamp[];
    try {
      const result = await transcribe(audioBuffer, audioFile.name || "audio.mp3", audioFile.type || "audio/mpeg");
      transcript = result.text;
      languageCode = result.languageCode;
      words = result.words;
    } catch (err) {
      console.error("[/api/dub] STT", err);
      return NextResponse.json({ error: sttError(err) }, { status: 500 });
    }

    if (!transcript.trim()) {
      return NextResponse.json(
        { error: "음성을 인식하지 못했습니다. 오디오가 포함된 파일인지 확인하거나 더 명확하게 녹음된 파일을 사용해 주세요." },
        { status: 422 }
      );
    }

    // 3. 단어를 발화 세그먼트로 그룹화
    // 타임스탬프가 없거나 "word" 타입 토큰이 전혀 없으면 단일 세그먼트로 처리
    const grouped = words.length > 0 ? groupWords(words) : [];
    const rawSegments =
      grouped.length > 0
        ? grouped
        : [{ start: 0, end: 60, text: transcript }];

    // 4. 세그먼트 텍스트를 DeepL에 일괄 번역 (1번 요청)
    const segmentTexts = rawSegments.map((s) => s.text);
    let segmentTranslations: string[];
    let fullTranslation: string;
    try {
      // 전체 텍스트도 함께 번역해 VTT 자막 생성에 활용
      const allTexts = [...segmentTexts, transcript];
      const allTranslations = await translateBatch(allTexts, validLang.code);
      segmentTranslations = allTranslations.slice(0, segmentTexts.length);
      fullTranslation = allTranslations[allTranslations.length - 1];
    } catch (err) {
      console.error("[/api/dub] Translate", err);
      return NextResponse.json({ error: translateError(err) }, { status: 500 });
    }

    // 5. 세그먼트별 TTS — 동시 요청 3개로 제한 (ElevenLabs 동시성 제한 대응)
    let ttsBuffers: Buffer[];
    try {
      const CONCURRENCY = 3;
      const results: Buffer[] = new Array(segmentTranslations.length);
      for (let i = 0; i < segmentTranslations.length; i += CONCURRENCY) {
        const batch = segmentTranslations.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map((text) => textToSpeech(text)));
        batchResults.forEach((buf, j) => { results[i + j] = buf; });
      }
      ttsBuffers = results;
    } catch (err) {
      console.error("[/api/dub] TTS", err);
      return NextResponse.json({ error: ttsError(err) }, { status: 500 });
    }

    // 6. 세그먼트 결과 조합
    const segments = rawSegments.map((seg, i) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text,
      translation: segmentTranslations[i],
      audio: ttsBuffers[i].toString("base64"),
    }));

    return NextResponse.json({
      transcript,
      translation: fullTranslation,
      detectedLanguage: languageCode,
      segments,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[/api/dub]", message);
    return NextResponse.json({ error: `서버 오류가 발생했습니다: ${message}` }, { status: 500 });
  }
}
