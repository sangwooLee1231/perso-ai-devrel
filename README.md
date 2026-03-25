# AI Audio Dubbing Service

Google OAuth 로그인과 이메일 화이트리스트 기반 접근 제어를 갖춘 AI 오디오 더빙 웹 서비스입니다.

---

## 1. 서비스 소개 및 주요 기능

오디오 파일을 업로드하고 목표 언어를 선택하면 자동으로 전사(STT) → 번역 → 음성 합성(TTS)을 거쳐 더빙된 오디오를 브라우저에서 재생하거나 MP3로 다운로드할 수 있습니다. Google 계정으로 로그인하며, Turso DB에 등록된 이메일만 서비스를 이용할 수 있습니다. 미등록 계정은 로그인 시 세션 없이 차단 페이지로 이동합니다.

**구현된 기능**

- Google OAuth 로그인 + Turso 화이트리스트 접근 제어
- 오디오 파일 업로드 (MP3, WAV, M4A, FLAC, OGG 등)
- ElevenLabs Scribe v1 자동 전사 (STT)
- DeepL 번역 — 한국어, 일본어, 중국어, 스페인어, 프랑스어, 독일어, 포르투갈어, 이탈리아어, 러시아어, 영어 (10개 언어)
- ElevenLabs `eleven_multilingual_v2` 음성 합성 (TTS)
- 원문 전사 · 번역 텍스트 화면 표시, 더빙 오디오 재생 및 MP3 다운로드

> **현재 범위:** 오디오 입력 우선(audio-first) MVP입니다. 영상 파일 입력과 영상 출력은 이번 MVP에 포함되지 않습니다.

---

## 2. 사용한 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 16.2.1 (App Router) |
| 언어 | TypeScript 5 |
| UI | React 19, Tailwind CSS 4 |
| 인증 | Auth.js, Google OAuth |
| DB | Turso (libSQL) — 화이트리스트 저장 |
| STT | ElevenLabs Scribe v1 |
| 번역 | DeepL API  |
| TTS | ElevenLabs `eleven_multilingual_v2` |
| 배포 | Vercel |

추가 라이브러리는 `next-auth@beta`, `@libsql/client` 두 개만 설치했습니다. 외부 API는 모두 `fetch`로 직접 호출합니다.

---

## 3. 로컬 실행 방법

### 환경 변수

`.env.local` 파일을 생성하고 아래 값을 입력하세요.

```bash
AUTH_SECRET=          # npx auth secret 으로 생성
AUTH_GOOGLE_ID=       # Google Cloud Console → OAuth 2.0 클라이언트 ID
AUTH_GOOGLE_SECRET=   # Google Cloud Console → OAuth 2.0 클라이언트 보안 비밀
TURSO_DATABASE_URL=   # libsql://your-db.turso.io
TURSO_AUTH_TOKEN=     # turso db tokens create <db-name>
ELEVENLABS_API_KEY=   # elevenlabs.io → Profile → API Key
ELEVENLABS_VOICE_ID=  # Voice Lab에서 본인 계정 보이스 ID (기본값 없음)
DEEPL_API_KEY=        # deepl.com/pro-api → 무료 키 (끝이 :fx)
```

### 외부 서비스 최소 설정

**Google OAuth** — [Google Cloud Console](https://console.cloud.google.com) → Credentials → OAuth 2.0 클라이언트 생성 후 리디렉션 URI에 `http://localhost:3000/api/auth/callback/google` 추가

**Turso** — DB 생성 후 아래 SQL 실행

```bash
turso db create <db-name> && turso db shell <db-name>
```
```sql
CREATE TABLE whitelist (email TEXT PRIMARY KEY NOT NULL);
INSERT INTO whitelist (email) VALUES ('your@email.com');
```

**ElevenLabs** — `elevenlabs.io/app/voice-lab` → 본인 계정 보이스의 Voice ID 복사 → `ELEVENLABS_VOICE_ID` 입력 (Voice Library 타인 보이스는 무료 플랜에서 402 오류 발생)

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

GitHub `main` 브랜치에 push하면 Vercel이 자동으로 빌드·배포합니다. Vercel 프로젝트 Settings → Environment Variables에 위 환경 변수 8개를 입력하고, Google Cloud Console에 Vercel 도메인의 리디렉션 URI도 추가해야 합니다.

---

## 5. 코딩 에이전트 활용 방법 및 노하우

Claude Code를 아키텍처 설계부터 코드 작성, 디버깅, 문서화까지 전 과정의 협업 파트너로 활용했습니다. 각 단계를 명확한 요청 단위로 나눠 진행하고, 결과를 직접 실행하며 검증하는 방식으로 작업했습니다.

**잘 처리한 작업**

- **버전별 문서 탐색:** 구현 전 `node_modules/next/dist/docs/`를 직접 읽어 Next.js 16 breaking change(`middleware.ts` → `proxy.ts`, `cookies()` async 필수화 등)를 파악하고 코드에 반영했습니다.
- **Auth 구조 설계:** `signIn` 콜백에서 `return "/blocked"`(문자열)는 세션을 생성한 뒤 리다이렉트한다는 점을 스스로 지적하고, `return false` + `pages.error: "/blocked"` 구조로 수정해 차단 계정에 세션이 생성되지 않도록 했습니다.
- **TypeScript 오류 수정:** `Buffer`를 `new Blob()`에 직접 전달 시 발생하는 `ArrayBufferLike` 타입 불일치를 `new Uint8Array(buffer)` 래핑으로 즉시 해결하고 `tsc --noEmit`으로 확인했습니다.

**사람이 직접 확인한 작업**

- Google Cloud Console OAuth 클라이언트 설정 및 리디렉션 URI 등록
- Turso 계정 생성, DB 생성, 화이트리스트 이메일 입력
- ElevenLabs 무료 플랜 호환 보이스 ID 확인 및 입력
- 전체 더빙 흐름 로컬 동작 검증

**겪은 문제와 해결**

- **ElevenLabs 402 오류:** 기본값으로 설정한 Rachel 보이스가 무료 플랜에서 사용 불가한 Voice Library 보이스였습니다. 기본값을 제거하고, `ELEVENLABS_VOICE_ID` 미설정 시 명확한 오류 메시지를, 402 응답 시 무료 플랜 안내 메시지를 별도로 출력하도록 수정했습니다.
- **`proxy.ts` 호환성:** `auth()` 함수를 proxy 래퍼로 사용하는 패턴이 Next.js 16 Node.js 런타임에서 동작하는지 문서만으로 확신하기 어려워 실제 실행으로 검증했습니다.

**노하우**

- 구현 전 "계획만 세우고, 바로 코드 수정은 하지 않기" 방식이 효과적이었습니다. 인증·DB·배포처럼 되돌리기 어려운 영역은 구조를 먼저 검토한 뒤 구현을 진행했습니다.
- Google OAuth, Turso, ElevenLabs, DeepL 설정은 코드 구현 자체보다 사람의 직접 확인이 더 중요했습니다. 코드 생성 후 반드시 로컬·배포 환경에서 직접 테스트하는 단계가 필요합니다.
- 코딩 에이전트는 코드를 빠르게 작성하지만, 외부 서비스 연동과 실제 API 동작은 반드시 사람이 검증해야 합니다.
