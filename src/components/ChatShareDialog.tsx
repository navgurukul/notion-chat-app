"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

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
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const [actionError, setActionError] = useState(false);
  const createControllerRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionLockRef = useRef(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setIsVisible(false);
      createControllerRef.current?.abort();
      createControllerRef.current = null;
      setToken(null);
      setCopied(false);
      setCopyFallback(false);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
      return;
    }
    const frame = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    createControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, view, isCreating]);

  useEffect(() => {
    if (!isOpen || !sessionId) {
      createControllerRef.current?.abort();
      createControllerRef.current = null;
      setToken(null);
      setCopied(false);
      setCopyFallback(false);
      setActionError(false);
      setView("loading");
      setIsCreating(false);
      return;
    }

    const controller = new AbortController();
    setToken(null);
    setCopied(false);
    setCopyFallback(false);
    setActionError(false);
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

    return () => {
      controller.abort();
      createControllerRef.current?.abort();
      createControllerRef.current = null;
      actionLockRef.current = false;
    };
  }, [isOpen, sessionId]);

  const close = () => {
    createControllerRef.current?.abort();
    createControllerRef.current = null;
    setToken(null);
    setCopied(false);
    setCopyFallback(false);
    setActionError(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
    setView("loading");
    onClose();
  };

  const createLink = async (reshare = false) => {
    if (!sessionId || actionLockRef.current) return;
    if (reshare && !window.confirm("Create a new link? The old link will stop working.")) return;
    actionLockRef.current = true;
    const controller = new AbortController();
    createControllerRef.current = controller;
    setIsCreating(true);
    try {
      const response = await fetch(`/api/chats/${sessionId}/share`, {
        method: "POST",
        ...(reshare ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reshare: true }) } : {}),
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
      setActionError(false);
      setView("link");
    } catch {
      if (!controller.signal.aborted) {
        if (reshare) setActionError(true);
        else setView("error");
      }
    } finally {
      if (createControllerRef.current === controller) createControllerRef.current = null;
      actionLockRef.current = false;
      setIsCreating(false);
    }
  };

  const stopSharing = async () => {
    if (!sessionId || actionLockRef.current) return;
    // if (!window.confirm("Stop sharing? The current link will stop working.")) return;
    actionLockRef.current = true;
    const controller = new AbortController();
    createControllerRef.current = controller;
    setIsCreating(true);
    setActionError(false);
    try {
      const response = await fetch(`/api/chats/${sessionId}/share`, { method: "DELETE", signal: controller.signal });
      if (!response.ok) throw new Error();
      setToken(null);
      setActionError(false);
      setView("create");
    } catch {
      if (!controller.signal.aborted) setActionError(true);
    } finally {
      if (createControllerRef.current === controller) createControllerRef.current = null;
      actionLockRef.current = false;
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  const copyLink = async () => {
    if (!token) return;
    const link = `${window.location.origin}/shared/${token}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyFallback(false);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      linkInputRef.current?.select();
      setCopyFallback(true);
      setCopied(false);
    }
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${isVisible ? "opacity-100" : "opacity-0"}`}>
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={close}
        aria-label="Close share dialog"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-share-title"
        ref={dialogRef}
        tabIndex={-1}
        className={`relative z-10 w-full max-w-lg rounded-2xl border border-white/10 bg-[#1a1a1a] p-5 shadow-2xl transition-all duration-200 sm:p-7 ${isVisible ? "scale-100 opacity-100" : "scale-[0.98] opacity-0"}`}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 id="chat-share-title" className="text-xl font-semibold">Share chat</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-white/55">
              Anyone at NavGurukul with the link can view this chat. It is read only.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-lg p-2 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {view === "loading" && <p className="text-sm text-white/60">Loading…</p>}
        {view === "error" && <p role="alert" className="text-sm text-red-400">Something went wrong. Please try again.</p>}
        {view === "already-shared" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-white/60">
              This chat already has a link. It can&apos;t be shown again.
            </div>
            <button
              type="button"
              onClick={() => createLink(true)}
              disabled={isCreating}
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {isCreating ? "Creating link…" : "Create new link"}
            </button>
            {actionError && <p role="alert" className="text-sm text-red-400">Something went wrong. Please try again.</p>}
            {/* <button type="button" onClick={stopSharing} disabled={isCreating} className="w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50">Stop sharing</button> */}
          </div>
        )}
        {view === "create" && (
          <div>
            <button
              type="button"
              onClick={() => createLink()}
              disabled={isCreating}
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {isCreating ? "Creating link…" : "Create share link"}
            </button>
          </div>
        )}
        {view === "link" && token && (
          <div>
            <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-2 sm:flex-row">
              <input
                ref={linkInputRef}
                aria-label="Share link"
                readOnly
                value={`${window.location.origin}/shared/${token}`}
                className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-2 text-sm text-white/75 outline-none"
              />
              <button
                type="button"
                onClick={copyLink}
                disabled={isCreating}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            {copyFallback && <p role="status" className="mt-2 text-xs text-white/60">Press Ctrl+C to copy</p>}
            {actionError && <p role="alert" className="mt-2 text-sm text-red-400">Something went wrong. Please try again.</p>}
            <p className="mt-3 text-xs text-white/45">This link is shown only once. Copy it now.</p>
            {/* <button type="button" onClick={stopSharing} disabled={isCreating} className="mt-4 w-full rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50">Stop sharing</button> */}
          </div>
        )}
      </section>
    </div>
  );
}
