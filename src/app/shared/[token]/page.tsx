import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { authOptions } from "@/lib/auth/options";
import { getSharedChatByToken } from "@/lib/chat/share/share-read";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";

export const metadata: Metadata = {
  title: "Shared chat",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UNAVAILABLE_MESSAGE = "This shared chat is not available.";

type SharedPageProps = {
  params: Promise<{ token: string }>;
};

export default async function SharedChatPage({ params }: SharedPageProps) {
  const { token } = await params;
  if (!TOKEN_PATTERN.test(token)) {
    return <Unavailable />;
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    const callbackUrl = `/shared/${token}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  if (!hasNavgurukulDomainAccess(session)) {
    return <Unavailable />;
  }

  const sharedChat = await getSharedChatByToken(token);
  if (!sharedChat) {
    return <Unavailable />;
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-8 sm:px-6 md:px-8">
        <header className="mb-8 border-b border-white/10 pb-5">
          <p className="mb-2 text-xs font-medium text-white/45">Shared chat, read only</p>
          <h1 className="text-xl font-semibold text-white sm:text-2xl">{sharedChat.title}</h1>
        </header>

        <section aria-label="Shared chat messages" className="space-y-6">
          {sharedChat.messages.map((message, index) => {
            const isUser = message.role === "user";
            const role = isUser ? "User" : "Assistant";

            return (
              <article key={`${message.createdAt}-${index}`} className="space-y-2">
                <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className={`flex min-w-0 max-w-[94%] flex-col sm:max-w-[86%] lg:max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
                    <div className={`min-w-0 max-w-full rounded-2xl p-3.5 shadow-sm sm:p-4 ${isUser
                      ? "rounded-tr-none border border-white/10 bg-white/10"
                      : "rounded-tl-none border border-blue-500/10 bg-blue-600/10"
                    }`}>
                      <p className="mb-2 text-xs font-medium text-white/45">{role}</p>
                      <div className="chat-answer min-w-0 max-w-full text-sm leading-7 text-slate-200 prose prose-invert prose-sm max-w-none prose-p:my-2.5 prose-p:leading-7 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-white prose-headings:mt-5 prose-headings:mb-2 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-sm prose-ul:my-3 prose-ol:my-3 prose-li:my-1.5 prose-li:marker:text-slate-500 prose-strong:text-white prose-a:text-slate-200 prose-a:underline prose-a:decoration-white/40 prose-a:underline-offset-2 prose-blockquote:border-slate-500 prose-blockquote:bg-white/[0.03] prose-blockquote:rounded-r-lg prose-blockquote:py-1 prose-blockquote:text-slate-300 prose-table:text-sm prose-th:border prose-th:border-white/15 prose-th:bg-white/5 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-xl prose-pre:bg-slate-950/70 prose-pre:border prose-pre:border-white/10 prose-code:text-slate-200 prose-code:before:content-none prose-code:after:content-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                    <time className="mt-1 px-1 text-xs text-white/40" dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Asia/Kolkata",
                      })}
                    </time>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function Unavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 text-center text-white">
      <p className="text-sm text-white/70">{UNAVAILABLE_MESSAGE}</p>
    </main>
  );
}
