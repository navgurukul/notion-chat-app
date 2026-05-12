"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { Send, LogOut, MessageSquare, Bot, User, Loader2, AlertTriangle, X, RefreshCw, CheckCircle, XCircle, Plus, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

const STREAM_TAGS = {
  thinkingStart: "[[THINKING]]",
  thinkingEnd: "[[/THINKING]]",
  answerStart: "[[ANSWER]]",
  answerEnd: "[[/ANSWER]]",
};

const STREAM_TAG_LIST = Object.values(STREAM_TAGS);
const MAX_STREAM_TAG_LENGTH = Math.max(
  ...STREAM_TAG_LIST.map((tag) => tag.length),
);
const STREAM_TAG_SEARCH_LIMIT = 800;
const STREAM_TAG_PATTERN = /\[\[(?:\/)?(?:THINKING|ANSWER)\]\]/g;

function findNextStreamTag(text: string) {
  let nextIndex = -1;
  let nextTag = "";

  for (const tag of STREAM_TAG_LIST) {
    const index = text.indexOf(tag);
    if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
      nextIndex = index;
      nextTag = tag;
    }
  }

  if (nextIndex === -1) return null;
  return { index: nextIndex, tag: nextTag };
}

function containsStreamTag(text: string) {
  return STREAM_TAG_LIST.some((tag) => text.includes(tag));
}

function stripStreamTags(text: string) {
  return text.replace(STREAM_TAG_PATTERN, "");
}

export default function ChatPage() {
  const LAST_SYNC_STORAGE_KEY = "notion_last_synced_at";
  const { data: session, status } = useSession();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingByMessage, setThinkingByMessage] = useState<ThinkingByMessage>({});
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncClock, setSyncClock] = useState(Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const botMessageIndexRef = useRef<number | null>(null);

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
        const stored = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
        if (stored) setLastSyncedAt(stored);

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
        }

        if (!chatsResponse.ok) throw new Error("Failed to load chats");
        const chatsData = await chatsResponse.json();
        let sessions = Array.isArray(chatsData?.sessions) ? chatsData.sessions : [];

        if (!sessions.length) {
          const createResponse = await fetch("/api/chats", { method: "POST" });
          if (!createResponse.ok) throw new Error("Failed to create chat");
          const createData = await createResponse.json();
          sessions = createData?.session ? [createData.session] : [];
        }

        setChatSessions(sessions);
        setActiveSessionId(sessions[0]?.id ?? null);
      } catch (error) {
        console.error("Failed to load initial chat data:", error);
      } finally {
        setIsLoadingChats(false);
      }
    };

    loadInitialData();
  }, [status]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    const loadSessionMessages = async () => {
      try {
        const response = await fetch(`/api/chats/${activeSessionId}/messages`);
        if (!response.ok) throw new Error("Failed to load chat messages");
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
  }, [activeSessionId]);

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

  const saveServerMessage = async (sessionId: string, message: Message) => {
    await fetch(`/api/chats/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    refreshChatSessions().catch((error) => console.error("Failed to refresh chats:", error));
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

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !activeSessionId) return;

    const userMessage = input.trim();
    const sessionId = activeSessionId;
    setInput("");

    const newUserMsg: Message = { role: "user", content: userMessage };
    setMessages((prev) => [...prev, newUserMsg]);
    await saveServerMessage(sessionId, newUserMsg);

    setIsLoading(true);
    botMessageIndexRef.current = null;

    try {
      const history = messages
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content.length > 1200 ? `${message.content.slice(0, 1200)}...` : message.content,
        }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, history }),
      });

      if (!response.ok) throw new Error("Failed to get response");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response stream unavailable");
      const decoder = new TextDecoder();

      let answerText = "";
      let thinkingText = "";
      let buffer = "";
      let parseMode: "searching" | "tagged" | "untagged" = "searching";
      let activeSection: "thinking" | "answer" | null = null;
      let hasReceivedChunk = false;

      const botMsgPlaceholder: Message = { role: "bot", content: "" };
      const botIndex = messages.length + 1;
      setMessages((prev) => [...prev, botMsgPlaceholder]);
      botMessageIndexRef.current = botIndex;
      setThinkingByMessage((prev) => ({
        ...prev,
        [botIndex]: {
          summary: "",
          status: "retrieving",
          isStreaming: true,
        },
      }));

      const updateThinkingSummary = (summary: string) => {
        const trimmedSummary = summary.trim();
        setThinkingByMessage((prev) => {
          const entry = prev[botIndex];
          if (!entry) return prev;
          if (entry.summary === trimmedSummary) return prev;
          return {
            ...prev,
            [botIndex]: {
              ...entry,
              summary: trimmedSummary,
            },
          };
        });
      };

      const updateMessageContent = () => {
        setMessages((prev) => {
          const targetIndex = botMessageIndexRef.current;
          if (targetIndex === null || !prev[targetIndex]) return prev;
          const next = [...prev];
          next[targetIndex] = { role: "bot", content: answerText };
          return next;
        });
      };

      const appendToSection = (text: string) => {
        if (!text) return;

        if (activeSection === "thinking") {
          thinkingText += text;
          updateThinkingSummary(thinkingText.trim());
          return;
        }

        if (activeSection === "answer") {
          answerText += text;
        }
      };

      const parseTaggedBuffer = () => {
        while (true) {
          const nextTag = findNextStreamTag(buffer);
          if (!nextTag) {
            if (activeSection) {
              const safeLength = Math.max(0, buffer.length - (MAX_STREAM_TAG_LENGTH - 1));
              if (safeLength > 0) {
                const safeText = buffer.slice(0, safeLength);
                appendToSection(safeText);
                buffer = buffer.slice(safeLength);
              }
            }
            break;
          }

          const before = buffer.slice(0, nextTag.index);
          appendToSection(before);
          buffer = buffer.slice(nextTag.index + nextTag.tag.length);

          if (nextTag.tag === STREAM_TAGS.thinkingStart) {
            activeSection = "thinking";
          } else if (nextTag.tag === STREAM_TAGS.thinkingEnd) {
            activeSection = null;
          } else if (nextTag.tag === STREAM_TAGS.answerStart) {
            activeSection = "answer";
          } else if (nextTag.tag === STREAM_TAGS.answerEnd) {
            activeSection = null;
          }
        }
      };

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
        buffer += chunk;

        if (parseMode === "searching") {
          if (containsStreamTag(buffer)) {
            parseMode = "tagged";
          } else if (buffer.length >= STREAM_TAG_SEARCH_LIMIT) {
            parseMode = "untagged";
          }
        }

        if (parseMode === "untagged") {
          answerText += buffer;
          buffer = "";
        } else if (parseMode === "tagged") {
          parseTaggedBuffer();
        }

        updateMessageContent();
      }

      if (parseMode === "searching") {
        answerText += buffer;
        buffer = "";
      } else if (parseMode === "tagged") {
        if (activeSection) {
          appendToSection(buffer);
        }
        buffer = "";
      }

      const cleanedAnswer = stripStreamTags(answerText);
      if (cleanedAnswer !== answerText) {
        answerText = cleanedAnswer;
        updateMessageContent();
      }

      await saveServerMessage(sessionId, { role: "bot", content: cleanedAnswer });

    } catch {
      const failMsg: Message = { role: "bot", content: "Failed to connect to the server." };
      setMessages((prev) => [...prev, failMsg]);
      await saveServerMessage(sessionId, failMsg);
    } finally {
      setIsLoading(false);
      const finalBotIndex = botMessageIndexRef.current;
      botMessageIndexRef.current = null;
      setThinkingByMessage((prev) => {
        if (finalBotIndex === null) return prev;
        const entry = prev[finalBotIndex];
        if (!entry) return prev;
        return {
          ...prev,
          [finalBotIndex]: {
            ...entry,
            status: "idle",
            isStreaming: false,
          },
        };
      });
    }
  };

  const handleLogout = async () => {
    setThinkingByMessage({});
    signOut();
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncStatus('idle');

    try {
      const response = await fetch("/api/sync?refreshContent=true&embed=false", {
        method: "POST",
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to sync");
      }

      if (typeof data?.synced_at === "string" && data.synced_at) {
        setLastSyncedAt(data.synced_at);
        setSyncClock(Date.now());
        localStorage.setItem(LAST_SYNC_STORAGE_KEY, data.synced_at);
      }

      setSyncStatus('success');
      setTimeout(() => setSyncStatus('idle'), 5000);
    } catch (error) {
      console.error("Sync error:", error);
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  const formatRelativeSyncTime = (isoTime: string | null) => {
    if (!isoTime) return "Last synced: never";
    const syncTime = new Date(isoTime).getTime();
    if (!Number.isFinite(syncTime)) return "Last synced: unknown";

    const now = syncClock;
    const diffMs = Math.max(0, now - syncTime);
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Last synced: just now";
    if (diffMins < 60) return `Last synced: ${diffMins} min ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `Last synced: ${diffHours} hr ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `Last synced: ${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  };

  const formatFullSyncTime = (isoTime: string | null) => {
    if (!isoTime) return "No sync completed yet";
    const syncTime = new Date(isoTime);
    if (!Number.isFinite(syncTime.getTime())) return "Sync time unavailable";

    return syncTime.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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
              Your chats are now stored securely in PostgreSQL. Logging out will end this session, but it will not delete saved chat history.
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
              <button
                key={chat.id}
                onClick={() => setActiveSessionId(chat.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors ${
                  activeSessionId === chat.id
                    ? "bg-blue-600/20 text-blue-200 border border-blue-500/30"
                    : "bg-white/5 text-white/55 hover:bg-white/[0.08] hover:text-white"
                }`}
              >
                {chat.title || "New Chat"}
              </button>
            ))}
            {!chatSessions.length && (
              <p className="text-xs text-white/35 px-2">No chats yet.</p>
            )}
          </div>

          <div className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-4 px-2">
            Active Connection
          </div>
          <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-sm flex items-center mb-6 gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            Connected to Notion Database
          </div>

          <div className="text-xs font-semibold text-white/30 uppercase tracking-wider mb-4 px-2">
            Database Sync
          </div>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className={`w-full p-4 rounded-xl border flex flex-col items-center gap-3 transition-all ${isSyncing
              ? "bg-white/5 border-white/10"
              : syncStatus === 'success'
                ? "bg-green-500/10 border-green-500/50 text-green-400"
                : syncStatus === 'error'
                  ? "bg-red-500/10 border-red-500/50 text-red-400"
                  : "bg-white/5 border-white/10 hover:bg-white/[0.08] text-white/70 hover:text-white"
              }`}
          >
            {isSyncing ? (
              <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
            ) : syncStatus === 'success' ? (
              <CheckCircle className="w-6 h-6" />
            ) : syncStatus === 'error' ? (
              <XCircle className="w-6 h-6" />
            ) : (
              <RefreshCw className="w-6 h-6" />
            )}
            <div className="text-center">
              <span className="text-sm font-bold block">
                {isSyncing ? "Syncing..." : syncStatus === 'success' ? "Sync Success" : syncStatus === 'error' ? "Sync Failed" : "Sync Database"}
              </span>
              <span className="text-[10px] opacity-40 uppercase tracking-widest mt-1">Notion → PostgreSQL</span>
            </div>
          </button>
          <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-center">
            <p className="text-[11px] font-medium text-white/60">{formatRelativeSyncTime(lastSyncedAt)}</p>
            <p className="mt-1 text-[10px] text-white/35">{formatFullSyncTime(lastSyncedAt)}</p>
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
            messages.map((msg, idx) => {
              const thinkingEntry = thinkingByMessage[idx];
              const showThinking =
                msg.role === "bot" &&
                Boolean(thinkingEntry) &&
                Boolean(thinkingEntry?.isStreaming);
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
                    <div className="text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10 prose-code:text-blue-400">
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
                    </div>
                  </div>
                </div>
              );
            })
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
            Powered by Notion & Gemini AI
          </p>
        </div>
      </main>
    </div>
  );
}
