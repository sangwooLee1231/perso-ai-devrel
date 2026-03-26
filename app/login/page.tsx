import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-blue-50/50 via-white to-slate-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-8 shadow flex flex-col gap-7">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white text-xs font-bold">D</span>
            <h1 className="text-xl font-bold text-gray-900">AI Dubbing</h1>
          </div>
          <p className="text-sm text-gray-500">
            오디오·영상을 업로드하면 원하는 언어로 더빙해드립니다.
          </p>
          <ul className="flex flex-col gap-1.5 mt-1">
            {[
              "ElevenLabs STT로 자동 전사",
              "DeepL로 10개 언어 번역",
              "ElevenLabs TTS로 음성 합성",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2 text-xs text-gray-400">
                <span className="h-1 w-1 rounded-full bg-blue-400 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2.5 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors"
          >
            {/* Google "G" logo */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="w-4 h-4 shrink-0">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Google로 로그인
          </button>
        </form>
      </div>
    </main>
  );
}
