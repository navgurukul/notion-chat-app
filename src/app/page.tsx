"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { Send, LogOut, MessageSquare, Bot, User, Loader2, AlertTriangle, X, RefreshCw, CheckCircle, XCircle, Plus, Trash2, PanelLeftClose, PanelLeftOpen, Square, Pencil, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { hasKnowledgeBaseAccess } from "@/lib/shared/access";
import {
  extractFinalAnswer,
  stripInternalReasoning,
  stripStreamTags,
} from "@/lib/chat/stream-tags";

interface Message {
  id?: string;
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const botMessageIndexRef = useRef<number | null>(null);
  const pendingBotMessageIndexRef = useRef<number | null>(null);
  const chatInFlightRef = useRef(false);
  const messagesLoadGenerationRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const chatRequestIdRef = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [stopConfirmState, setStopConfirmState] = useState<"idle" | "confirm">("idle");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const canManageKnowledgeBase = hasKnowledgeBaseAccess(session);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

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
      id: message.id,
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
            id: message.id,
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
    const response = await fetch("/api/chats", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Failed to create chat");
    }

    const data = await response.json();

    if (data?.session) {
      setChatSessions((prev) => {
        // Remove existing copy if already present
        const filtered = prev.filter(
          (chat) => chat.id !== data.session.id
        );

        // Put returned chat at top
        return [data.session, ...filtered];
      });

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

  const stopActiveChat = () => {
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
    setIsLoading(false);
    chatInFlightRef.current = false;
  };

  const executeChatFlow = async (userMessage: string, customHistory?: Message[]) => {
    if (isLoading || !activeSessionId) return;

    const sessionId = activeSessionId;
    const baseMessages = customHistory || messages;
    const newUserMsg: Message = { role: "user", content: userMessage };
    const botIndex = baseMessages.length + 1;
    pendingBotMessageIndexRef.current = botIndex;

    if (customHistory) {
      setMessages([...customHistory, newUserMsg, { role: "bot", content: "" }]);
    } else {
      setMessages((prev) => [...prev, newUserMsg, { role: "bot", content: "" }]);
    }

    chatInFlightRef.current = true;
    messagesLoadGenerationRef.current += 1;
    setIsLoading(true);
    botMessageIndexRef.current = botIndex;
    const requestId = ++chatRequestIdRef.current;
    const abortController = new AbortController();
    chatAbortControllerRef.current = abortController;
    setThinkingByMessage((prev) => ({
      ...prev,
      [botIndex]: {
        summary: "",
        status: "retrieving",
        isStreaming: true,
      },
    }));

    try {
      const history = [...baseMessages, newUserMsg]
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content.length > 1200 ? `${message.content.slice(0, 1200)}...` : message.content,
        }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, history, sessionId }),
        signal: abortController.signal,
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
          await syncMessagesFromSession(sessionId);
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

      await syncMessagesFromSession(sessionId);
      refreshChatSessions().catch((error) => console.error("Failed to refresh chats:", error));

    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setBotMessageAt(botIndex, "Failed to connect to the server.");
      }
      clearThinkingAt(botIndex);
    } finally {
      if (chatRequestIdRef.current === requestId) {
        chatAbortControllerRef.current = null;
        setIsLoading(false);
        chatInFlightRef.current = false;
        botMessageIndexRef.current = null;
        pendingBotMessageIndexRef.current = null;
      }
      clearThinkingAt(botIndex);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !activeSessionId) return;

    const userMessage = input.trim();
    setInput("");
    await executeChatFlow(userMessage);
  };

  const handleStopClick = () => {
    if (stopConfirmState === "idle") {
      setStopConfirmState("confirm");
      setTimeout(() => {
        setStopConfirmState("idle");
      }, 3000);
    } else {
      stopActiveChat();
      setStopConfirmState("idle");
    }
  };

  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (isLoading || !activeSessionId || !newContent.trim()) return;
    setEditingMessageId(null);

    const targetIdx = messages.findIndex((m) => m.id === messageId);
    if (targetIdx === -1) return;

    try {
      const response = await fetch(`/api/chats/${activeSessionId}/messages?messageId=${messageId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete message history");

      const historyUpToEdited = messages.slice(0, targetIdx);
      await executeChatFlow(newContent, historyUpToEdited);
    } catch (error) {
      console.error("Failed to edit message:", error);
    }
  };

  const handleRegenerate = async () => {
    if (isLoading || !activeSessionId || messages.length < 2) return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "bot") return;

    const secondLastMsg = messages[messages.length - 2];
    if (secondLastMsg.role !== "user") return;

    try {
      const response = await fetch(`/api/chats/${activeSessionId}/messages?messageId=${lastMsg.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete message for regeneration");

      const historyUpToLastUser = messages.slice(0, messages.length - 2);
      await executeChatFlow(secondLastMsg.content, historyUpToLastUser);
    } catch (error) {
      console.error("Failed to regenerate response:", error);
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
    if (!isoTime) return "No sync recorded yet";
    const syncTime = parseSyncTimestamp(isoTime);
    if (!Number.isFinite(syncTime)) return "Unknown sync time";

    const diffMs = Math.max(0, Date.now() - syncTime);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffMs / 60000);

    if (diffSec < 60) return diffSec < 15 ? "just now" : `${diffSec} sec ago`;
    if (diffMins < 60) return `${diffMins} min ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  };

  const formatAbsoluteSyncTime = (isoTime: string | null) => {
    if (!isoTime) return "No sync recorded yet";
    const syncTime = parseSyncTimestamp(isoTime);
    if (!Number.isFinite(syncTime)) return "Unknown sync time";

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(syncTime));
  };

  const formatSyncDisplay = (isoTime: string | null) => {
    if (!isoTime) return "No sync recorded yet";
    const absolute = formatAbsoluteSyncTime(isoTime);
    const relative = formatRelativeSyncTime(isoTime);
    if (absolute === "Unknown sync time") return absolute;
    return `${absolute} (${relative})`;
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
              You'll be signed out. Your chats are saved and will be here when you sign back in.
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
      <aside className={`${sidebarOpen ? "w-80" : "w-0"} shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out bg-white/5 border-r border-white/10 backdrop-blur-xl flex flex-col`}>
        <div className="p-6 border-b border-white/10">
          {/* Header row: logo + title + toggle button on the far right */}
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-blue-600">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight flex-1">Notion AI</h1>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              title="Close sidebar"
              aria-label="Close sidebar"
            >
              <PanelLeftClose className="w-5 h-5" />
            </button>
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
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-blue-600/10 border border-blue-500/20 px-3 py-2 text-blue-400 text-xs">
              <div className="w-2 h-2 shrink-0 rounded-full bg-blue-500 animate-pulse" />
              <span className="font-medium">Connected to Notion Database</span>
            </div>
            {canManageKnowledgeBase ? (
              <>
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
                <button
                  type="button"
                  onClick={() => setShowFullSyncConfirm(true)}
                  disabled={isSyncing}
                  className="mt-1.5 w-full text-left px-1 text-[10px] text-white/35 hover:text-amber-400/90 disabled:opacity-30 transition-colors"
                >
                  Full rebuild (all pages)…
                </button>
              </>
            ) : (
              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-white/70">
                <div className="text-white/45 uppercase tracking-wide text-[10px] mb-1">
                  Last sync by admin
                </div>
                <div className="font-medium text-white/90" title={formatSyncDisplay(lastSyncedAt)}>
                  {formatSyncDisplay(lastSyncedAt)}
                </div>
              </div>
            )}
            <p
              className="mt-2 px-1 text-[10px] text-white/45 leading-snug"
              title={formatSyncDisplay(lastSyncedAt)}
            >
              {isSyncing ? "Sync in progress…" : formatSyncDisplay(lastSyncedAt)}
            </p>
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

          {/* Recent Chats header — single MessageSquare icon for all chats */}
          <div className="flex items-center justify-between mb-3 px-2">
            <div className="flex items-center gap-2 text-white/30">
              <MessageSquare className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold uppercase tracking-wider">Recent Chats</span>
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
                  onClick={() => {
                    stopActiveChat();
                    setMessages([]);
                    setThinkingByMessage({});
                    setActiveSessionId(chat.id);
                  }}
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
          <p className="text-xs text-white/35 truncate text-center mb-2">{session.user?.email}</p>
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
      <main className="flex-1 flex flex-col relative text-white min-w-0">
        {/* Header — toggle open button shown here only when sidebar is closed */}
        <header className="h-16 border-b border-white/10 flex items-center gap-3 px-4 bg-[#0a0a0a]/50 backdrop-blur-md z-10">
          {!sidebarOpen && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          )}
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
                <div key={idx} className="space-y-2 group/msg">
                  <div
                    className={`flex gap-4 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
                  >
                    <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${msg.role === "user" ? "bg-white text-black" : "bg-blue-600 text-white"
                      }`}>
                      {msg.role === "user" ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                    </div>

                    {msg.role === "user" && editingMessageId === msg.id ? (
                      <div className="flex-1 max-w-[80%] p-4 rounded-2xl bg-white/10 border border-white/10 rounded-tr-none space-y-3">
                        <textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          className="w-full p-3 rounded-xl bg-white/5 border border-white/20 focus:outline-none focus:border-blue-500 text-sm text-white resize-none"
                          rows={3}
                        />
                        <div className="flex gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => setEditingMessageId(null)}
                            className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs font-semibold text-white/70 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditMessage(msg.id!, editingText)}
                            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors"
                          >
                            Save & Submit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative max-w-[80%]">
                        <div className={`p-4 rounded-2xl ${msg.role === "user"
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

                         {msg.role === "user" && msg.id && !isLoading && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMessageId(msg.id!);
                              setEditingText(msg.content);
                            }}
                            className="absolute -left-10 top-2 p-1.5 rounded-lg text-white/45 hover:text-white hover:bg-white/10 transition-colors"
                            title="Edit message"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {idx === messages.length - 1 && msg.role === "bot" && msg.id && !isLoading && (
                    <div className="flex justify-start pl-12 mt-1">
                      <button
                        type="button"
                        onClick={handleRegenerate}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 text-white/60 hover:text-white hover:bg-white/10 transition-colors font-medium"
                        title="Regenerate response"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Regenerate</span>
                      </button>
                    </div>
                  )}
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
            {isLoading ? (
              <button
                type="button"
                onClick={handleStopClick}
                className={`absolute right-2 top-2 p-2 rounded-xl text-white transition-all duration-200 flex items-center justify-center min-h-[36px] ${
                  stopConfirmState === "confirm"
                    ? "bg-red-700 hover:bg-red-800 px-3 animate-pulse"
                    : "bg-red-500 hover:bg-red-600"
                }`}
                title={stopConfirmState === "confirm" ? "Click again to confirm" : "Stop generating"}
              >
                {stopConfirmState === "confirm" ? (
                  <span className="text-[10px] font-bold tracking-wider uppercase">Click again</span>
                ) : (
                  <Square className="w-5 h-5 fill-current" />
                )}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !activeSessionId}
                className="absolute right-2 top-2 p-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-all font-semibold"
                title="Send message"
              >
                <Send className="w-5 h-5" />
              </button>
            )}
          </form>
          <p className="text-center text-[10px] text-white/20 mt-4 uppercase tracking-[0.2em]">
            Powered by Notion & OpenAI
          </p>
        </div>
      </main>
    </div>
  );
}