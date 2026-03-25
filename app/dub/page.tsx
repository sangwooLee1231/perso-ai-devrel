import { auth } from "@/auth";
import { signOut } from "@/auth";
import { redirect } from "next/navigation";
import DubForm from "./DubForm";

export default async function DubPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      {/* Header row */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AI Audio Dubbing</h1>
          <p className="mt-1 text-sm text-gray-500">
            Upload audio, choose a target language, and get a dubbed version in seconds.
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="shrink-0 rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            Sign out
          </button>
        </form>
      </div>

      <p className="mb-6 text-xs text-gray-400">
        Signed in as {session.user?.email}
      </p>

      {/* TODO: video support — extract audio with ffmpeg here when needed */}

      <DubForm />
    </main>
  );
}
