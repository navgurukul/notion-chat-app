"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { Send, LogOut, MessageSquare, Bot, User, Loader2, AlertTriangle, X } from "lucide-react";
import { saveMessage, getMessages, clearMessages } from "@/lib/db";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "bot";
  content: string;
}

export default function ChatPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    const loadMessages = async () => {
      const savedMessages = await getMessages();
      setMessages(savedMessages.map(m => ({ role: m.role, content: m.content })));
    };
    if (status === "authenticated") {
      loadMessages();
    }
  }, [status]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");

    const newUserMsg: Message = { role: "user", content: userMessage };
    setMessages((prev) => [...prev, newUserMsg]);
    await saveMessage(newUserMsg);

    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!response.ok) throw new Error("Failed to get response");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let botContent = "";

      const botMsgPlaceholder: Message = { role: "bot", content: "" };
      setMessages((prev) => [...prev, botMsgPlaceholder]);

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        botContent += chunk;

        setMessages((prev) => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = { role: "bot", content: botContent };
          return newMessages;
        });
      }

      await saveMessage({ role: "bot", content: botContent });

    } catch (error) {
      const failMsg: Message = { role: "bot", content: "Failed to connect to the server." };
      setMessages((prev) => [...prev, failMsg]);
      await saveMessage(failMsg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    await clearMessages();
    signOut();
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-white">
        <Loader2 className="animate-spin h-10 w-10 text-blue-500" />
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white overflow-hidden relative">
      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowLogoutConfirm(false)} />
          <div className="bg-[#1a1a1a] border border-white/10 p-8 rounded-2xl max-w-sm w-full relative z-10 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-start mb-4">
              <div className="p-3 rounded-full bg-red-500/20 text-red-500">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <button onClick={() => setShowLogoutConfirm(false)} className="text-white/40 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <h3 className="text-xl font-bold mb-2">Erase Chat History?</h3>
            <p className="text-white/60 text-sm mb-6 leading-relaxed">
              For your privacy, chats are stored locally in your browser. Logging out will <span className="text-white font-semibold">permanently delete</span> all your chat history.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 px-4 rounded-xl border border-white/10 hover:bg-white/5 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleLogout}
                className="flex-1 py-3 px-4 rounded-xl bg-red-500 hover:bg-red-600 transition-all font-medium active:scale-[0.98]"
              >
                Logout & Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className="w-80 bg-white/5 border-r border-white/10 backdrop-blur-xl flex flex-col">
        <div className="p-6 border-b border-white/10">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-blue-600">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Notion AI</h1>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
            {session.user?.image ? (
              <img src={session.user.image} alt="User" className="w-10 h-10 rounded-full" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-bold">
                {session.user?.name?.[0]}
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-medium truncate">{session.user?.name}</p>
              <p className="text-xs text-white/40 truncate">{session.user?.email}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto">
          <div className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-4 px-2">
            Active Connection
          </div>
          <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-sm flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            Connected to Notion Database
          </div>
        </div>

        <div className="p-4 border-t border-white/10">
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="w-full p-3 rounded-xl flex items-center gap-3 text-white/60 hover:text-white hover:bg-white/5 transition-colors"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative text-white">
        {/* Header */}
        <header className="h-16 border-b border-white/10 flex items-center px-8 bg-[#0a0a0a]/50 backdrop-blur-md z-10">
          <h2 className="text-lg font-medium">Chat Assistant</h2>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-8 space-y-8 scroll-smooth antialiased">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
              <div className="p-6 rounded-3xl bg-blue-600/10 mb-6">
                <Bot className="w-12 h-12 text-blue-500" />
              </div>
              <h3 className="text-2xl font-bold mb-2">How can I help you?</h3>
              <p className="text-white/40">
                Ask me anything about the content in your Notion database. I can summarize, find details, and answer specific questions.
              </p>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex gap-4 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
              >
                <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${msg.role === "user" ? "bg-white text-black" : "bg-blue-600 text-white"
                  }`}>
                  {msg.role === "user" ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                </div>
                <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === "user"
                    ? "bg-white/10 border border-white/10 rounded-tr-none"
                    : "bg-blue-600/10 border border-blue-500/10 rounded-tl-none"
                  }`}>
                  <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10 prose-code:text-blue-400">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}
          {isLoading && messages[messages.length - 1]?.role !== 'bot' && (
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center">
                <Bot className="w-5 h-5" />
              </div>
              <div className="p-4 rounded-2xl bg-blue-600/10 border border-blue-500/10 rounded-tl-none">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-8">
          <form
            onSubmit={handleSend}
            className="max-w-4xl mx-auto relative group"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              className="w-full p-4 pr-14 rounded-2xl bg-white/5 border border-white/10 focus:outline-none focus:border-blue-500/50 focus:bg-white/[0.07] transition-all placeholder:text-white/20 text-white"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="absolute right-2 top-2 p-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-all font-semibold"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
          <p className="text-center text-[10px] text-white/20 mt-4 uppercase tracking-[0.2em]">
            Powered by Notion & Gemini AI
          </p>
        </div>
      </main>
    </div>
  );
}
