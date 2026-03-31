import { auth } from "@/auth";
import { signOut } from "@/auth";
import { redirect } from "next/navigation";
import DubForm from "./DubForm";

export default async function DubPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Sticky Nav */}
      <nav className="sticky top-0 z-50 bg-white border-b border-[#e4e3df] h-14 px-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="font-[family-name:var(--font-syne)] text-[15px] font-bold tracking-tight text-[#1a1917]">
            Dubago
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#57534e] hidden sm:block">{session.user?.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              className="text-sm font-medium text-blue-600 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors"
            >
              로그아웃
            </button>
          </form>
        </div>
      </nav>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center px-5 pt-10 pb-16">
        <div className="text-center mb-9">
          <h2 className="font-[family-name:var(--font-syne)] text-[26px] font-bold tracking-tight text-[#1a1917] mb-1.5">
            어떤 언어로 더빙할까요?
          </h2>
          <p className="text-sm text-[#57534e] leading-relaxed">
            오디오·영상을 업로드하고 목표 언어를 선택하면
            <br className="hidden sm:block" /> 더빙 오디오를 자동으로 생성합니다.
          </p>
        </div>

        <div className="w-full max-w-[560px] md:max-w-[1080px]">
          <DubForm />
        </div>
      </div>
    </div>
  );
}
