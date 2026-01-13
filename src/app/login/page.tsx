"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";

export default function LoginPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.push("/");
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-white">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0a0a0a] text-white p-4">
      <div className="w-full max-w-md p-8 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="p-4 rounded-2xl bg-blue-600/20 mb-4">
            <LogIn className="w-12 h-12 text-blue-500" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Notion AI Chat</h1>
          <p className="text-white/60 text-center">
            Sign in with your Google account to start chatting with your Notion
            database.
          </p>
        </div>

        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="w-full py-4 px-6 rounded-xl bg-white text-black font-semibold flex items-center justify-center gap-3 hover:bg-white/90 transition-all active:scale-[0.98]"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="currentColor"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="currentColor"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="currentColor"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 12-4.53z"
            />
          </svg>
          Continue with Google
        </button>

        <p className="mt-8 text-center text-xs text-white/40">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
