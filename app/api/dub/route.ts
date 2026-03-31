import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { transcribe, textToSpeech } from "@/lib/elevenlabs";
import { translate } from "@/lib/translate";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

// Allow up to 60 s for the full STT → translate → TTS pipeline
export const maxDuration = 60;

// ── 인메모리 레이트 리미터 ────────────────────────────────────────────────────
// Vercel 서버리스 특성상 인스턴스별로 독립 동작하므로 엄밀한 전역 제한은 아니나
// 단일 사용자의 반복 남용(API 크레딧 소진)을 효과적으로 방지함.
// 프로덕션 확장 시 Upstash Redis 등 외부 스토어로 교체 권장.
const RATE_LIMIT_MAX = 10;      // 최대 요청 수
const RATE_LIMIT_WINDOW = 10 * 60 * 1000; // 10분 윈도우(ms)

interface RateEntry { count: number; resetAt: number }
const rateLimitMap = new Map<string, RateEntry>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// ── 단계별 오류 → 한국어 친화 메시지 변환 ──────────────────────────────────

function errCode(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sttError(err: unknown): string {
  const c = errCode(err);
  if (c === "ELEVENLABS_QUOTA") return "ElevenLabs 음성 인식(STT) 크레딧이 소진되었습니다. ElevenLabs 대시보드에서 크레딧을 충전해 주세요.";
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
  if (c === "ELEVENLABS_AUTH") return "ElevenLabs API 키가 올바르지 않습니다. .env.local의 ELEVENLABS_API_KEY를 확인해 주세요.";
  if (c === "ELEVENLABS_PLAN") return "선택한 ElevenLabs 보이스는 현재 플랜에서 사용할 수 없습니다. ElevenLabs Voice Lab에서 직접 소유한 보이스 ID를 ELEVENLABS_VOICE_ID에 설정해 주세요.";
  return `음성 합성(TTS) 중 오류가 발생했습니다: ${c}`;
}

export async function POST(request: Request) {
  // Auth guard — proxy already handles redirects, but API routes need an explicit check
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

    // 2. Transcribe with ElevenLabs Scribe
    let transcript: string;
    let languageCode: string | null;
    try {
      const result = await transcribe(audioBuffer, audioFile.name || "audio.mp3", audioFile.type || "audio/mpeg");
      transcript = result.text;
      languageCode = result.languageCode;
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

    // 3. Translate with DeepL
    let translation: string;
    try {
      translation = await translate(transcript, validLang.code);
    } catch (err) {
      console.error("[/api/dub] Translate", err);
      return NextResponse.json({ error: translateError(err) }, { status: 500 });
    }

    // 4. Generate dubbed speech with ElevenLabs TTS
    let ttsBuffer: Buffer;
    try {
      ttsBuffer = await textToSpeech(translation);
    } catch (err) {
      console.error("[/api/dub] TTS", err);
      return NextResponse.json({ error: ttsError(err) }, { status: 500 });
    }

    return NextResponse.json({
      transcript,
      translation,
      detectedLanguage: languageCode,
      audio: ttsBuffer.toString("base64"),
      mimeType: "audio/mpeg",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[/api/dub]", message);
    return NextResponse.json({ error: `서버 오류가 발생했습니다: ${message}` }, { status: 500 });
  }
}
