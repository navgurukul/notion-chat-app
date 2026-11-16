"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type ChatShareDialogProps = {
  sessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
};

type ShareView = "loading" | "create" | "already-shared" | "link" | "error";

export default function ChatShareDialog({ sessionId, isOpen, onClose }: ChatShareDialogProps) {
  const [view, setView] = useState<ShareView>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const createControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen || !sessionId) {
      createControllerRef.current?.abort();
      createControllerRef.current = null;
      setToken(null);
      setView("loading");
      setIsCreating(false);
      return;
    }

    const controller = new AbortController();
    setToken(null);
    setView("loading");
    setIsCreating(false);

    fetch(`/api/chats/${sessionId}/share`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data: { shared?: boolean } = await response.json();
        setView(data.shared ? "already-shared" : "create");
      })
      .catch(() => {
        if (!controller.signal.aborted) setView("error");
      });

    return () => controller.abort();
  }, [isOpen, sessionId]);

  const close = () => {
    createControllerRef.current?.abort();
    createControllerRef.current = null;
    setToken(null);
    setView("loading");
    onClose();
  };

  const createLink = async () => {
    if (!sessionId || isCreating) return;
    const controller = new AbortController();
    createControllerRef.current = controller;
    setIsCreating(true);
    try {
      const response = await fetch(`/api/chats/${sessionId}/share`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      const data: { alreadyShared?: boolean; token?: string } = await response.json();
      if (data.alreadyShared) {
        setView("already-shared");
        return;
      }
      if (!data.token) throw new Error();
      setToken(data.token);
      setView("link");
    } catch {
      if (!controller.signal.aborted) setView("error");
    } finally {
      if (createControllerRef.current === controller) createControllerRef.current = null;
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={close}
        aria-label="Close share dialog"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-share-title"
        className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#1a1a1a] p-5 shadow-2xl sm:p-8"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id="chat-share-title" className="text-xl font-bold">Share this chat</h2>
          <button
            type="button"
            onClick={close}
            className="shrink-0 text-white/40 transition-colors hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {view === "loading" && <p className="text-sm text-white/60">Loading…</p>}
        {view === "error" && <p role="alert" className="text-sm text-red-400">Something went wrong. Please try again.</p>}
        {view === "already-shared" && (
          <p className="text-sm leading-relaxed text-white/70">
            This chat already has a link. It can&apos;t be shown again.
          </p>
        )}
        {view === "create" && (
          <div className="space-y-5">
            <p className="text-sm leading-relaxed text-white/70">
              Anyone at NavGurukul with this link can view this chat. It is read only.
            </p>
            <button
              type="button"
              onClick={createLink}
              disabled={isCreating}
              className="w-full rounded-xl bg-blue-600 px-4 py-3 font-medium transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {isCreating ? "Creating link…" : "Create link"}
            </button>
          </div>
        )}
        {view === "link" && token && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-white/70">
              This link is shown only once. Copy it now.
            </p>
            <input
              aria-label="Share link"
              readOnly
              value={`${window.location.origin}/shared/${token}`}
              className="w-full min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white/80 outline-none"
            />
          </div>
        )}
      </section>
    </div>
  );
}
