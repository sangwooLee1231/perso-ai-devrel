import { auth } from "@/auth";
import { signOut } from "@/auth";
import { redirect } from "next/navigation";
import DubForm from "./DubForm";

export default async function DubPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50/50 via-white to-slate-50">
      <main className="mx-auto w-full max-w-xl px-4 py-10 sm:py-16">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-white text-[10px] font-bold tracking-tight">D</span>
              <h1 className="text-lg font-bold text-gray-900">AI Dubbing</h1>
            </div>
            <p className="text-xs text-gray-400">
              오디오 또는 영상을 업로드하고 목표 언어를 선택하면 더빙된 오디오를 생성합니다.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <p className="text-xs text-gray-400">{session.user?.email}</p>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600 transition-colors"
              >
                로그아웃
              </button>
            </form>
          </div>
        </div>

        <DubForm />
      </main>
    </div>
  );
}
