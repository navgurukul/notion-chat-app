"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { Send, LogOut, MessageSquare, Bot, User, Loader2, AlertTriangle, X, RefreshCw, CheckCircle, XCircle, Plus, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  extractFinalAnswer,
  stripInternalReasoning,
  stripStreamTags,
} from "@/lib/chat/stream-tags";

interface Message {
  role: "user" | "bot";
  content: string;
}

type ChatSession = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ThinkingStatus = "idle" | "retrieving" | "generating";

type ThinkingEntry = {
  summary: string;
  status: ThinkingStatus;
  isStreaming: boolean;
};

type ThinkingByMessage = { [key: number]: ThinkingEntry };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ChatPage() {
  const LAST_SYNC_STORAGE_KEY = "notion_last_synced_at";
  const LAST_CHAT_SESSION_KEY = "notion_active_chat_session";
  const { data: session, status } = useSession();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [chatsReady, setChatsReady] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingByMessage, setThinkingByMessage] = useState<ThinkingByMessage>({});
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [chatPendingDelete, setChatPendingDelete] = useState<ChatSession | null>(null);
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMode, setSyncMode] = useState<"incremental" | "full" | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncClock, setSyncClock] = useState(Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const botMessageIndexRef = useRef<number | null>(null);
  /** Index of the next bot bubble; set when the user message is appended (setState updaters run later). */
  const pendingBotMessageIndexRef = useRef<number | null>(null);
  /** Prevents session message reload from wiping in-flight user/bot bubbles. */
  const chatInFlightRef = useRef(false);
  const messagesLoadGenerationRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  useEffect(() => {
    const tick = () => setSyncClock(Date.now());
    const intervalId = setInterval(tick, 30_000);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;

    const loadInitialData = async () => {
      setIsLoadingChats(true);
      try {
        const [syncResponse, chatsResponse] = await Promise.all([
          fetch("/api/sync"),
          fetch("/api/chats"),
        ]);

        if (syncResponse.ok) {
          const data = await syncResponse.json();
          if (typeof data?.synced_at === "string" && data.synced_at) {
            setLastSyncedAt(data.synced_at);
            setSyncClock(Date.now());
            localStorage.setItem(LAST_SYNC_STORAGE_KEY, data.synced_at);
          }
        } else {
          const stored = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
          if (stored) setLastSyncedAt(stored);
        }

        if (!chatsResponse.ok) throw new Error("Failed to load chats");
        const chatsData = await chatsResponse.json();
        let sessions: ChatSession[] = Array.isArray(chatsData?.sessions)
          ? (chatsData.sessions as ChatSession[])
          : [];

        if (!sessions.length) {
          const createResponse = await fetch("/api/chats", { method: "POST" });
          if (!createResponse.ok) throw new Error("Failed to create chat");
          const createData = await createResponse.json();
          sessions = createData?.session ? [createData.session as ChatSession] : [];
        }

        setChatSessions(sessions);
        const storedSessionId = localStorage.getItem(LAST_CHAT_SESSION_KEY);
        const restored = storedSessionId
          ? sessions.find((s) => s.id === storedSessionId)
          : undefined;
        setActiveSessionId(restored?.id ?? sessions[0]?.id ?? null);
      } catch (error) {
        console.error("Failed to load initial chat data:", error);
      } finally {
        setIsLoadingChats(false);
        setChatsReady(true);
      }
    };

    loadInitialData();
  }, [status]);

  const syncMessagesFromSession = async (
    sessionId: string,
    options?: { keepLocalBotIndex?: number },
  ) => {
    const response = await fetch(`/api/chats/${sessionId}/messages`);
    if (!response.ok) return false;
    const data = await response.json();
    const loadedMessages = Array.isArray(data?.messages) ? data.messages : [];
    const mapped: Message[] = loadedMessages.map((message: Message) => ({
      role: message.role,
      content: message.content,
    }));

    setMessages((prev) => {
      const keepIdx = options?.keepLocalBotIndex;
      const localBot = keepIdx !== undefined ? prev[keepIdx]?.content?.trim() : "";
      if (!localBot) return mapped;

      const lastBotIdx = mapped.map((m, i) => (m.role === "bot" ? i : -1)).filter((i) => i >= 0).pop();
      if (lastBotIdx === undefined) return mapped;

      const remoteBot = mapped[lastBotIdx]?.content?.trim() ?? "";
      if (localBot.length <= remoteBot.length) return mapped;

      const merged = [...mapped];
      merged[lastBotIdx] = { role: "bot", content: localBot };
      return merged;
    });
    setThinkingByMessage({});
    return mapped.length > 0;
  };

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(LAST_CHAT_SESSION_KEY, activeSessionId);
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      if (chatsReady) setMessages([]);
      return;
    }

    const loadGeneration = ++messagesLoadGenerationRef.current;
    const sessionId = activeSessionId;

    const loadSessionMessages = async () => {
      try {
        const response = await fetch(`/api/chats/${sessionId}/messages`);
        if (!response.ok) throw new Error("Failed to load chat messages");
        if (loadGeneration !== messagesLoadGenerationRef.current) return;
        if (chatInFlightRef.current) return;

        const data = await response.json();
        const loadedMessages = Array.isArray(data?.messages) ? data.messages : [];
        setMessages(
          loadedMessages.map((message: Message) => ({
            role: message.role,
            content: message.content,
          })),
        );
        setThinkingByMessage({});
      } catch (error) {
        console.error("Failed to load chat messages:", error);
      }
    };

    loadSessionMessages();
  }, [activeSessionId, chatsReady]);

  useEffect(() => {
    const timer = window.setInterval(() => setSyncClock(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const refreshChatSessions = async () => {
    const response = await fetch("/api/chats");
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data?.sessions)) setChatSessions(data.sessions);
  };

  const createNewChat = async () => {
    if (isLoading || isLoadingChats) return;
    setIsLoadingChats(true);
    try {
      const response = await fetch("/api/chats", { method: "POST" });
      if (!response.ok) throw new Error("Failed to create chat");
      const data = await response.json();
      if (data?.session) {
        setChatSessions((prev) => [data.session, ...prev]);
        setActiveSessionId(data.session.id);
        setMessages([]);
        setThinkingByMessage({});
      }
    } catch (error) {
      console.error("Failed to create chat:", error);
    } finally {
      setIsLoadingChats(false);
    }
  };

  const clearActiveChat = async () => {
    if (!activeSessionId || isLoading) return;
    try {
      const response = await fetch(`/api/chats/${activeSessionId}/messages`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to clear chat");
      setMessages([]);
      setThinkingByMessage({});
      await refreshChatSessions();
    } catch (error) {
      console.error("Failed to clear chat:", error);
    }
  };

  const requestDeleteChat = (chat: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLoadingChats || isLoading) return;
    setChatPendingDelete(chat);
  };

  const confirmDeleteChat = async () => {
    if (!chatPendingDelete || isLoadingChats || isLoading) return;

    const chatId = chatPendingDelete.id;
    setChatPendingDelete(null);
    setIsLoadingChats(true);

    try {
      const response = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete chat");

      const wasActive = chatId === activeSessionId;
      let sessions = chatSessions.filter((chat) => chat.id !== chatId);

      if (!sessions.length) {
        const createResponse = await fetch("/api/chats", { method: "POST" });
        if (!createResponse.ok) throw new Error("Failed to create chat");
        const createData = await createResponse.json();
        sessions = createData?.session ? [createData.session] : [];
      }

      setChatSessions(sessions);

      if (wasActive) {
        const nextId = sessions[0]?.id ?? null;
        setActiveSessionId(nextId);
        if (!nextId) {
          setMessages([]);
          setThinkingByMessage({});
        }
      }
    } catch (error) {
      console.error("Failed to delete chat:", error);
    } finally {
      setIsLoadingChats(false);
    }
  };

  const setBotMessageAt = (botIndex: number, content: string) => {
    setMessages((prev) => {
      if (!prev[botIndex]) return prev;
      const next = [...prev];
      next[botIndex] = { role: "bot", content };
      return next;
    });
  };

  const clearThinkingAt = (botIndex: number) => {
    setThinkingByMessage((prev) => {
      const entry = prev[botIndex];
      if (!entry) return prev;
      return {
        ...prev,
        [botIndex]: {
          ...entry,
          status: "idle",
          isStreaming: false,
        },
      };
    });
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !activeSessionId) return;

    const userMessage = input.trim();
    const sessionId = activeSessionId;
    setInput("");

    const newUserMsg: Message = { role: "user", content: userMessage };
    const botIndex = messages.length + 1;
    pendingBotMessageIndexRef.current = botIndex;
    setMessages((prev) => [...prev, newUserMsg, { role: "bot", content: "" }]);

    chatInFlightRef.current = true;
    messagesLoadGenerationRef.current += 1;
    setIsLoading(true);
    botMessageIndexRef.current = botIndex;
    setThinkingByMessage((prev) => ({
      ...prev,
      [botIndex]: {
        summary: "",
        status: "retrieving",
        isStreaming: true,
      },
    }));

    try {
      const history = [...messages, newUserMsg]
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content.length > 1200 ? `${message.content.slice(0, 1200)}...` : message.content,
        }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, history, sessionId }),
      });

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        const data: unknown = await response.json();
        const answer =
          data &&
          typeof data === "object" &&
          "answer" in data &&
          typeof (data as { answer: unknown }).answer === "string"
            ? (data as { answer: string }).answer
            : null;
        const errorText =
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : null;

        if (answer !== null) {
          setBotMessageAt(botIndex, answer);
          clearThinkingAt(botIndex);
          refreshChatSessions().catch((error) => console.error("Failed to refresh chats:", error));
          return;
        }

        if (!response.ok) {
          setBotMessageAt(botIndex, errorText || answer || "Failed to get response");
          clearThinkingAt(botIndex);
          return;
        }

        throw new Error("Invalid chat response");
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        setBotMessageAt(botIndex, errText || "Failed to get response");
        clearThinkingAt(botIndex);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response stream unavailable");
      const decoder = new TextDecoder();

      let rawStream = "";
      let hasReceivedChunk = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!hasReceivedChunk) {
          hasReceivedChunk = true;
          setThinkingByMessage((prev) => {
            const entry = prev[botIndex];
            if (!entry || entry.status !== "retrieving") return prev;
            return {
              ...prev,
              [botIndex]: {
                ...entry,
                status: "generating",
              },
            };
          });
        }

        const chunk = decoder.decode(value, { stream: true });
        rawStream += chunk;
        const display = stripInternalReasoning(stripStreamTags(rawStream));
        setBotMessageAt(botIndex, display);
      }

      rawStream += decoder.decode();
      const answerText = extractFinalAnswer(rawStream);
      setBotMessageAt(botIndex, answerText);
      clearThinkingAt(botIndex);

      if (!answerText.trim()) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await sleep(400 * (attempt + 1));
          const synced = await syncMessagesFromSession(sessionId);
          if (synced) break;
        }
      }

      refreshChatSessions().catch((error) => console.error("Failed to refresh chats:", error));

    } catch {
      setBotMessageAt(botIndex, "Failed to connect to the server.");
      clearThinkingAt(botIndex);
    } finally {
      setIsLoading(false);
      chatInFlightRef.current = false;
      botMessageIndexRef.current = null;
      pendingBotMessageIndexRef.current = null;
      clearThinkingAt(botIndex);
    }
  };

  const handleLogout = async () => {
    setThinkingByMessage({});
    localStorage.removeItem(LAST_SYNC_STORAGE_KEY);
    localStorage.removeItem(LAST_CHAT_SESSION_KEY);
    await signOut({ callbackUrl: "/login" });
  };

  const runSync = async (mode: "incremental" | "full") => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncMode(mode);
    setSyncStatus("idle");

    const params =
      mode === "full"
        ? "force=true&refreshContent=true&embed=true"
        : "embed=true";

    try {
      const response = await fetch(`/api/sync?${params}`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to sync");
      }

      if (typeof data?.synced_at === "string" && data.synced_at) {
        setLastSyncedAt(data.synced_at);
        setSyncClock(Date.now());
        localStorage.setItem(LAST_SYNC_STORAGE_KEY, data.synced_at);
      }

      setSyncStatus("success");
      setTimeout(() => setSyncStatus("idle"), 5000);
    } catch (error) {
      console.error("Sync error:", error);
      setSyncStatus("error");
      setTimeout(() => setSyncStatus("idle"), 5000);
    } finally {
      setIsSyncing(false);
      setSyncMode(null);
    }
  };

  const handleIncrementalSync = () => runSync("incremental");

  const handleFullSync = () => {
    setShowFullSyncConfirm(false);
    runSync("full");
  };

  const parseSyncTimestamp = (value: string) => {
    const trimmed = value.trim();
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
      return new Date(trimmed).getTime();
    }
    if (trimmed.includes("T")) {
      return new Date(trimmed).getTime();
    }
    return new Date(trimmed.replace(" ", "T") + "Z").getTime();
  };

  const formatRelativeSyncTime = (isoTime: string | null) => {
    if (!isoTime) return "Last synced: never";
    const syncTime = parseSyncTimestamp(isoTime);
    if (!Number.isFinite(syncTime)) return "Last synced: unknown";

    const diffMs = Math.max(0, syncClock - syncTime);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffMs / 60000);

    if (diffSec < 15) return "Last synced: just now";
    if (diffSec < 60) return `Last synced: ${diffSec} sec ago`;
    if (diffMins < 60) return `Last synced: ${diffMins} min ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Last synced: ${diffHours} hr ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `Last synced: ${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  };

  const formatSyncTimeTitle = (isoTime: string | null) => {
    if (!isoTime) return "No sync recorded yet";
    const syncTime = parseSyncTimestamp(isoTime);
    if (!Number.isFinite(syncTime)) return isoTime;
    return new Date(syncTime).toLocaleString();
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
      {/* Full sync confirmation */}
      {showFullSyncConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowFullSyncConfirm(false)}
            role="presentation"
          />
          <div className="bg-[#1a1a1a] border border-white/10 p-8 rounded-2xl max-w-sm w-full relative z-10 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-amber-400 mb-4">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="text-xl font-bold">Full rebuild?</h3>
            </div>
            <p className="text-white/60 text-sm mb-8 leading-relaxed">
              This re-syncs every Notion page from Notion and rebuilds embeddings.
              It can take many hours. For routine updates use{" "}
              <span className="text-white/80">Sync changes</span> (also embeds when enabled in server .env).
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowFullSyncConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleFullSync}
                className="flex-1 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors"
              >
                Rebuild all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete chat confirmation */}
      {chatPendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setChatPendingDelete(null)}
            role="presentation"
          />
          <div className="bg-[#1a1a1a] border border-white/10 p-8 rounded-2xl max-w-sm w-full relative z-10 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-start mb-4">
              <div className="p-3 rounded-full bg-red-500/20 text-red-500">
                <Trash2 className="w-6 h-6" />
              </div>
              <button
                type="button"
                onClick={() => setChatPendingDelete(null)}
                className="text-white/40 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <h3 className="text-xl font-bold mb-2">Delete this chat?</h3>
            <p className="text-white/60 text-sm mb-2 leading-relaxed">
              <span className="text-white/90 font-medium">
                {chatPendingDelete.title || "New Chat"}
              </span>{" "}
              and all its messages will be permanently removed.
            </p>
            <p className="text-white/40 text-xs mb-6">This cannot be undone.</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setChatPendingDelete(null)}
                disabled={isLoadingChats}
                className="flex-1 py-3 px-4 rounded-xl border border-white/10 hover:bg-white/5 transition-colors font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteChat}
                disabled={isLoadingChats}
                className="flex-1 py-3 px-4 rounded-xl bg-red-500 hover:bg-red-600 transition-all font-medium active:scale-[0.98] disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

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
            <h3 className="text-xl font-bold mb-2">Sign out?</h3>
            <p className="text-white/60 text-sm mb-6 leading-relaxed">
              You will be logged out of this browser session. Your saved chats in PostgreSQL are not deleted.
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
                Sign Out
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
              // eslint-disable-next-line @next/next/no-img-element
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
            <button
              type="button"
              onClick={() => setShowLogoutConfirm(true)}
              className="shrink-0 p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-blue-600/10 border border-blue-500/20 px-3 py-2 text-blue-400 text-xs">
              <div className="w-2 h-2 shrink-0 rounded-full bg-blue-500 animate-pulse" />
              <span className="font-medium">Connected to Notion Database</span>
            </div>
            <button
              type="button"
              onClick={handleIncrementalSync}
              disabled={isSyncing}
              title="Sync updated Notion pages"
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all disabled:opacity-60 ${
                isSyncing
                  ? "bg-white/5 text-white/70"
                  : syncStatus === "success"
                    ? "bg-green-500/10 text-green-400"
                    : syncStatus === "error"
                      ? "bg-red-500/10 text-red-400"
                      : "hover:bg-white/[0.08] text-white/80 hover:text-white"
              }`}
            >
              {isSyncing ? (
                <RefreshCw className="w-4 h-4 shrink-0 animate-spin text-blue-500" />
              ) : syncStatus === "success" ? (
                <CheckCircle className="w-4 h-4 shrink-0" />
              ) : syncStatus === "error" ? (
                <XCircle className="w-4 h-4 shrink-0" />
              ) : (
                <RefreshCw className="w-4 h-4 shrink-0" />
              )}
              <span className="flex-1 text-left text-sm font-semibold">
                {isSyncing
                  ? syncMode === "full"
                    ? "Full rebuild..."
                    : "Syncing..."
                  : syncStatus === "success"
                    ? "Synced"
                    : syncStatus === "error"
                      ? "Sync failed"
                      : "Sync Notion"}
              </span>
            </button>
            <p
              className="mt-2 px-1 text-[10px] text-white/45 leading-snug"
              title={formatSyncTimeTitle(lastSyncedAt)}
            >
              {isSyncing ? "Sync in progress…" : formatRelativeSyncTime(lastSyncedAt)}
            </p>
            <button
              type="button"
              onClick={() => setShowFullSyncConfirm(true)}
              disabled={isSyncing}
              className="mt-1.5 w-full text-left px-1 text-[10px] text-white/35 hover:text-amber-400/90 disabled:opacity-30 transition-colors"
            >
              Full rebuild (all pages)…
            </button>
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto">
          <button
            onClick={createNewChat}
            disabled={isLoadingChats || isLoading}
            className="w-full mb-3 p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/[0.08] text-white/80 hover:text-white transition-colors flex items-center justify-center gap-2 text-sm font-semibold disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>

          <div className="flex items-center justify-between mb-3 px-2">
            <div className="text-xs font-semibold text-white/30 uppercase tracking-wider">
              Recent Chats
            </div>
            <button
              onClick={clearActiveChat}
              disabled={!activeSessionId || isLoading}
              className="text-white/35 hover:text-red-400 transition-colors disabled:opacity-40"
              title="Clear current chat"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2 mb-6">
            {chatSessions.map((chat) => (
              <div
                key={chat.id}
                className={`group flex items-center gap-1 rounded-lg border transition-colors ${
                  activeSessionId === chat.id
                    ? "bg-blue-600/20 border-blue-500/30"
                    : "bg-white/5 border-transparent hover:bg-white/[0.08]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveSessionId(chat.id)}
                  className={`flex-1 min-w-0 text-left px-3 py-2 text-sm truncate transition-colors ${
                    activeSessionId === chat.id ? "text-blue-200" : "text-white/55 group-hover:text-white"
                  }`}
                >
                  {chat.title || "New Chat"}
                </button>
                <button
                  type="button"
                  onClick={(e) => requestDeleteChat(chat, e)}
                  disabled={isLoadingChats || isLoading}
                  className="shrink-0 p-2 mr-1 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all disabled:opacity-40"
                  title="Delete chat"
                  aria-label={`Delete ${chat.title || "chat"}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {!chatSessions.length && (
              <p className="text-xs text-white/35 px-2">No chats yet.</p>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-white/10">
          <button
            type="button"
            onClick={() => setShowLogoutConfirm(true)}
            className="w-full p-3 rounded-xl flex items-center justify-center gap-2 border border-white/10 bg-white/5 text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors font-medium text-sm"
          >
            <LogOut className="w-4 h-4" />
            Log out
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
          {!chatsReady || isLoadingChats ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              <p className="mt-4 text-sm text-white/40">Loading chat...</p>
            </div>
          ) : messages.length === 0 ? (
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
            messages.map((msg, idx) => {
              const isPendingBot =
                isLoading &&
                msg.role === "bot" &&
                !msg.content.trim() &&
                idx === messages.length - 1;
              if (msg.role === "bot" && !msg.content.trim() && !isPendingBot) {
                return null;
              }
              const thinkingEntry = thinkingByMessage[idx];
              const showThinking =
                msg.role === "bot" &&
                Boolean(thinkingEntry) &&
                Boolean(thinkingEntry?.isStreaming) &&
                !msg.content.trim();
              const thinkingLabel =
                thinkingEntry?.status === "retrieving"
                  ? "Searching Notion..."
                  : "Generating answer...";

              return (
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
                    {showThinking && thinkingEntry && (
                      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-100/80">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>{thinkingLabel}</span>
                      </div>
                    )}
                    {(msg.content.trim() || showThinking) && (
                      <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-2 prose-p:leading-relaxed prose-headings:mt-4 prose-headings:mb-2 prose-h2:text-base prose-h3:text-sm prose-h4:text-sm prose-ul:my-2 prose-li:my-0.5 prose-table:text-sm prose-th:border prose-th:border-white/15 prose-th:px-2 prose-th:py-1 prose-td:border prose-td:border-white/15 prose-td:px-2 prose-td:py-1 prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10 prose-code:text-blue-400">
                        {msg.content.trim() ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ href, children }) => (
                                <a href={href} target="_blank" rel="noopener noreferrer">
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
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
              disabled={!activeSessionId || isLoadingChats}
              placeholder={activeSessionId ? "Ask anything..." : "Creating chat..."}
              className="w-full p-4 pr-14 rounded-2xl bg-white/5 border border-white/10 focus:outline-none focus:border-blue-500/50 focus:bg-white/[0.07] transition-all placeholder:text-white/20 text-white"
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading || !activeSessionId}
              className="absolute right-2 top-2 p-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-all font-semibold"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
          <p className="text-center text-[10px] text-white/20 mt-4 uppercase tracking-[0.2em]">
            Powered by Notion & OpenAI
          </p>
        </div>
      </main>
    </div>
  );
}
