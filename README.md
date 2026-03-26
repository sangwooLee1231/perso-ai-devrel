# AI Audio Dubbing Service

Google OAuth 로그인과 이메일 화이트리스트 기반 접근 제어를 갖춘 AI 더빙 웹 서비스입니다.

---

## 1. 서비스 소개 및 주요 기능

오디오 또는 영상 파일을 업로드하고 목표 언어를 선택하면, 음성 전사(STT) → 번역 → 음성 합성(TTS) 파이프라인을 거쳐 더빙된 오디오를 브라우저에서 재생하거나 MP3로 다운로드할 수 있습니다.

Google 계정으로 로그인하며, Turso DB에 등록된 이메일만 서비스를 이용할 수 있습니다. 미등록 계정은 로그인 시 세션 생성 없이 `/blocked` 페이지로 이동합니다.

### 주요 기능

- **Google OAuth 로그인 + Turso 화이트리스트 접근 제어** — 미등록 이메일은 세션 없이 차단
- **오디오 파일 업로드** — MP3, WAV, M4A, FLAC, OGG 등 `audio/*` 형식
- **영상 파일 업로드** — MP4, WebM, QuickTime — 오디오 트랙을 클라이언트에서 추출하여 더빙 파이프라인에 전달
- **60초 클라이언트 전처리** — 60초 초과 파일은 기기에서 앞 60초만 추출 후 업로드 (오디오·영상 모두 적용)
- **클라이언트 파일 유효성 검사** — 미지원 MIME 타입 및 500 MB 초과 파일은 업로드 전 즉시 오류 표시
- **단계별 처리 상태 표시** — 파일 확인 중 → 음성 추출/전처리 중 → 서버 처리 중
- **처리 시간 안내 및 단계별 오류 메시지** — 형식 오류·추출 실패·서버 오류를 각각 구분하여 표시
- **ElevenLabs Scribe v1 자동 전사 (STT)**
- **DeepL 번역** — 한국어·일본어·중국어(간체)·스페인어·프랑스어·독일어·포르투갈어·이탈리아어·러시아어·영어 (10개 언어)
- **ElevenLabs `eleven_multilingual_v2` 음성 합성 (TTS)**
- **결과 표시** — 원문 전사 텍스트, 번역 텍스트, 더빙 오디오 재생, MP3 다운로드

### 파일 업로드 동작

| 파일 유형 | 길이 | 클라이언트 처리 | 서버 수신 |
|---|---|---|---|
| 오디오 | ≤ 60초 | 없음 — 원본 그대로 | 원본 파일 |
| 오디오 | > 60초 | 앞 60초 추출 → WAV 인코딩 | WAV (≈ 2.5 MB) |
| 영상 | ≤ 60초 | 전체 오디오 추출 → WAV 인코딩 | WAV |
| 영상 | > 60초 | 앞 60초 오디오 추출 → WAV 인코딩 | WAV (≈ 2.5 MB) |

서버는 항상 오디오만 수신합니다. 영상 원본은 서버로 전송되지 않습니다.

### 아키텍처 선택 이유

- **클라이언트 전처리:** Vercel 서버리스 함수 요청 크기 한계(4.5 MB) 내에서 동작하도록, 긴 파일은 기기에서 앞 60초만 추출합니다. 60초 모노 WAV는 약 2.5 MB로 이 한계 안에 들어옵니다.
- **서버가 오디오만 수신:** 더빙 파이프라인(STT → 번역 → TTS)은 오디오만 처리하므로, 영상 원본을 서버로 보낼 이유가 없습니다. 클라이언트에서 오디오 트랙만 추출해 전송합니다.
- **ffmpeg 미사용:** 브라우저 내장 Web Audio API(`AudioContext`, `OfflineAudioContext`)로 MP4·WebM·오디오 파일의 디코딩·크롭·WAV 인코딩을 모두 처리합니다. 추가 npm 의존성 없이 구현 가능하고, `OfflineAudioContext`는 오디오 하드웨어를 사용하지 않아 iOS Safari 사용자 제스처 제한도 피할 수 있습니다.

---

## 2. 사용한 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 16.2.1 (App Router) |
| 언어 | TypeScript 5 |
| UI | React 19, Tailwind CSS 4 |
| 인증 | Auth.js v5 (next-auth@beta), Google OAuth |
| DB | Turso (libSQL) — 화이트리스트 이메일 저장 |
| STT | ElevenLabs Scribe v1 |
| 번역 | DeepL API  |
| TTS | ElevenLabs `eleven_multilingual_v2` |
| 미디어 처리 | 브라우저 내장 Web Audio API (`AudioContext`, `OfflineAudioContext`) |
| 배포 | Vercel |

추가 설치 라이브러리는 `next-auth@beta`, `@libsql/client` 두 개입니다. 외부 API는 모두 `fetch`로 직접 호출합니다. 영상·오디오 처리는 ffmpeg 없이 Web Audio API만 사용합니다.

---

## 3. 로컬 실행 방법

### 환경 변수

프로젝트 루트에 `.env.local` 파일을 생성하고 아래 값을 입력하세요.

```bash
# Auth.js — npx auth secret 으로 생성
AUTH_SECRET=

# Google OAuth — Google Cloud Console → APIs & Services → Credentials
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Turso
TURSO_DATABASE_URL=     # libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=       # turso db tokens create <db-name>

# ElevenLabs
ELEVENLABS_API_KEY=     # elevenlabs.io → Profile → API Key
ELEVENLABS_VOICE_ID=    # Voice Lab에서 본인 소유 보이스 ID (필수, 기본값 없음)

# DeepL
DEEPL_API_KEY=          # deepl.com/pro-api 무료 키 (끝이 :fx)
```

### 외부 서비스 설정

**Google OAuth** — [Google Cloud Console](https://console.cloud.google.com) → Credentials → OAuth 2.0 클라이언트 생성 → 리디렉션 URI에 `http://localhost:3000/api/auth/callback/google` 추가

**Turso** — DB 생성 후 아래 SQL 실행

```bash
turso db create <db-name> && turso db shell <db-name>
```
```sql
CREATE TABLE whitelist (email TEXT PRIMARY KEY NOT NULL);
INSERT INTO whitelist (email) VALUES ('your@email.com');
```

**ElevenLabs** — `elevenlabs.io/app/voice-lab` → 본인 계정 소유 보이스의 Voice ID 복사 → `ELEVENLABS_VOICE_ID`에 입력
Voice Library의 타인 보이스는 무료 플랜에서 402 오류 발생합니다.

**DeepL** — `deepl.com/pro-api` 무료 계정 생성 → API 키 복사

### 설치 및 실행

```bash
npm install
npm run dev
```

`http://localhost:3000` 접속 시 자동으로 `/login`으로 이동합니다.

---

## 4. 배포된 서비스 URL

**[https://perso-ai-devrel.vercel.app](https://perso-ai-devrel.vercel.app/login)**

GitHub `main` 브랜치 push 시 Vercel이 자동으로 빌드·배포합니다. Vercel 프로젝트 Settings → Environment Variables에 위 환경 변수 8개를 모두 입력하고, Google Cloud Console에 Vercel 도메인의 리디렉션 URI도 추가해야 합니다.




---

## 5. 코딩 에이전트 활용 방법 및 노하우

Claude Code를 아키텍처 설계·코드 작성·디버깅·문서화 전 과정에서 활용했습니다. 각 단계를 명확한 요청 단위로 나눠 진행하고, 결과를 직접 실행해 검증하는 방식으로 작업했습니다.

**잘 처리한 작업**

- **Next.js 16 breaking change 파악:** 구현 전 `node_modules/next/dist/docs/`를 직접 읽어 `middleware.ts` → `proxy.ts` 변경, `cookies()` async 필수화 등을 확인하고 코드에 반영했습니다.
- **Auth 구조 설계:** `signIn` 콜백에서 `return "/blocked"`(문자열)는 세션 생성 후 리다이렉트한다는 점을 스스로 지적하고, `return false` + `pages.error: "/blocked"` 구조로 수정해 차단 계정에 세션이 생성되지 않도록 했습니다.
- **TypeScript 타입 오류 수정:** `Buffer`를 `new Blob()`에 직접 전달 시 발생하는 `ArrayBufferLike` 불일치를 `new Uint8Array(buffer)` 래핑으로 즉시 해결했습니다.
- **영상 지원 추가:** ffmpeg 없이 Web Audio API만으로 영상 파일에서 오디오를 추출하는 구조를 설계하고 구현했습니다. `OfflineAudioContext`가 오디오 하드웨어를 사용하지 않아 iOS Safari 제스처 제한을 피할 수 있다는 점도 문서를 읽고 직접 파악했습니다.
- **UX 개선 패치:** 단계별 진행 상태, 파일 유효성 검사, 처리 시간 안내, 오류 메시지 분류를 기존 컴포넌트를 전면 재작성하지 않고 최소한의 변경으로 추가했습니다.

**사람이 직접 확인한 작업**

- Google Cloud Console OAuth 클라이언트 설정 및 리디렉션 URI 등록
- Turso 계정 생성, DB 생성, 화이트리스트 이메일 입력
- ElevenLabs 무료 플랜 호환 보이스 ID 확인 및 입력
- 전체 더빙 흐름 로컬 동작 검증

**겪은 문제와 해결**

- **ElevenLabs 402 오류:** 초기 기본값으로 설정한 Rachel 보이스가 무료 플랜에서 사용 불가한 Voice Library 보이스였습니다. 기본값을 제거하고, `ELEVENLABS_VOICE_ID` 미설정 시 명확한 오류 메시지를, 402 응답 시 무료 플랜 안내 메시지를 별도로 출력하도록 수정했습니다.
- **`proxy.ts` 호환성:** Auth.js v5의 `auth()` 래퍼 패턴이 Next.js 16 Node.js 런타임에서 동작하는지 문서만으로 확신하기 어려워 실제 실행으로 검증했습니다.

**노하우**

- "먼저 계획만 세우고, 즉시 코드 수정은 하지 않기" 방식이 효과적이었습니다. 인증·DB·배포처럼 되돌리기 어려운 영역은 구조를 먼저 검토한 뒤 구현했습니다.
- 외부 서비스(Google OAuth, Turso, ElevenLabs, DeepL) 설정은 코드 구현보다 사람의 직접 확인이 더 중요합니다. 코드 생성 후 반드시 로컬·배포 환경에서 직접 테스트하는 단계가 필요합니다.
- 코딩 에이전트는 코드를 빠르게 작성하지만, 외부 서비스 연동과 실제 API 동작은 반드시 사람이 검증해야 합니다.

---

## 한계점 및 고려사항

- 더빙된 오디오를 원본 영상에 합성하는 기능은 미지원입니다. 출력물은 MP3 오디오입니다.
- 500 MB 초과 파일은 클라이언트에서 업로드 전 차단됩니다. 그 이하여도 수백 MB 이상 파일은 저사양 모바일에서 메모리 부족으로 실패할 수 있습니다 (파일 전체를 메모리에 로드하므로).
- 영상 오디오 추출 브라우저 지원: Chrome/Android ✅ MP4·WebM, iOS Safari ✅ MP4/AAC, MOV·HEVC 등 일부 코덱은 브라우저에 따라 실패할 수 있으며 이 경우 오류 메시지를 표시합니다.
- 화자 분리(diarization) 및 보이스 클로닝 미지원 — 출력 음성은 `ELEVENLABS_VOICE_ID`에 설정한 단일 보이스입니다.
- 서버리스 함수 타임아웃은 60초입니다. 전사 텍스트가 매우 길면 TTS 합성이 타임아웃될 수 있습니다.

---

## 수동 테스트 체크리스트

로컬(`npm run dev`) 또는 배포 환경에서 아래 항목을 확인하세요.

### 기본 흐름

| # | 시나리오 | 기대 동작 |
|---|---|---|
| 1 | **오디오 ≤ 60초** 업로드 → 더빙 생성 | 원본 파일 그대로 서버 전송, 전사·번역·TTS 정상 완료 |
| 2 | **오디오 > 60초** 업로드 | 파일 선택 직후 황색 경고 표시. 제출 시 파일 확인 중 → 음원 전처리 중 (앞 60초 추출)… → 서버 처리 중… 단계 표시 후 더빙 완료 |
| 3 | **영상(MP4) ≤ 60초** 업로드 | 제출 시 파일 확인 중 → 영상에서 오디오 추출 중… → 서버 처리 중… 단계 표시 후 더빙 완료 |
| 4 | **영상(MP4) > 60초** 업로드 | 파일 선택 직후 황색 경고 표시. 제출 시 파일 확인 중 → 영상에서 오디오 추출 중… → 서버 처리 중… 단계 표시 후 더빙 완료 |
| 5 | 결과 확인 | 원문 전사 텍스트, 번역 텍스트, 오디오 플레이어 재생, MP3 다운로드 모두 정상 |
| 6 | 비허가 계정 로그인 | `/blocked` 페이지 이동, 세션 미생성 |
| 7 | 로그아웃 | `/login` 리다이렉트, 이후 `/dub` 직접 접근 시 `/login` 리다이렉트 |

### 모바일

| # | 환경 | 확인 항목 |
|---|---|---|
| 8 | **Android Chrome** | MP4 영상 업로드 → 오디오 추출 및 더빙 완료 |
| 9 | **iPhone Safari** | MP4 영상(카메라 촬영본) 업로드 → 오디오 추출 및 더빙 완료 |
| 10 | **iPhone Safari** | MOV 파일 업로드 시 오류 메시지 표시 (조용히 실패하지 않음) |

### 오류 처리 및 유효성 검사

| # | 시나리오 | 기대 동작 |
|---|---|---|
| 11 | 지원되지 않는 영상 코덱(MOV 등) 업로드 | 추출 실패 오류 메시지 (코덱 안내 포함), 서버 미전송 |
| 12 | `.docx` 등 미지원 파일 형식 제출 | 즉시 "지원하지 않는 파일 형식" 오류 표시, 서버 미전송 |
| 13 | **500 MB 초과** 파일 제출 | 즉시 파일 크기 초과 오류 표시 (MB 수치 포함), 서버 미전송 |
| 14 | 환경 변수 미설정 상태로 더빙 시도 | 서버에서 명확한 오류 메시지 반환 |
| 15 | 더빙 대기 상태에서 처리 시간 안내 확인 | 제출 버튼 하단에 "보통 15~45초 정도 소요될 수 있어요." 표시 |
