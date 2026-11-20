window.__ModuleLoader__.load({
  id: "dsh-tts-chat-answer",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const BUTTON_STYLE = {
      appearance: "none",
      border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))",
      borderRadius: "999px",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary, #666)",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "20px",
      padding: "0 10px",
    };
    const STOP_STYLE = {
      ...BUTTON_STYLE,
      padding: "0 8px",
      color: "var(--dsw-alias-label-secondary, #666)",
      cursor: "pointer",
    };
    const WRAP_STYLE = {
      display: "flex",
      alignItems: "center",
      gap: "7px",
      marginTop: "2px",
      minWidth: "0",
      width: "100%",
    };
    const ACTION_STYLE = {
      ...BUTTON_STYLE,
      padding: "0 8px",
      fontVariantNumeric: "tabular-nums",
      cursor: "pointer",
    };
    const RIGHT_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "7px",
      marginLeft: "auto",
      flexShrink: 0,
    };
    const HINT_STYLE = {
      color: "var(--dsw-alias-label-caption, #888)",
      fontSize: "11px",
      lineHeight: "20px",
      maxWidth: "280px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    };

    /**
     * One shared HTMLAudioElement for every turn. Keeping it module-global
     * guarantees that pressing Play on another answer stops the current one.
     */
    const inline = {
      audio: null,
      key: null,
      state: "idle",
      positionMs: 0,
      durationMs: 0,
      error: null,
      snapshot: Object.freeze({ key: null, state: "idle", positionMs: 0, durationMs: 0, error: null }),
      listeners: new Set(),
    };

    function publishInline(patch) {
      Object.assign(inline, patch);
      inline.snapshot = Object.freeze({
        key: inline.key,
        state: inline.state,
        positionMs: inline.positionMs,
        durationMs: inline.durationMs,
        error: inline.error,
      });
      for (const listener of inline.listeners) {
        try { listener(); } catch { /* listeners must not break playback */ }
      }
    }

    function subscribeInline(listener) {
      inline.listeners.add(listener);
      return () => inline.listeners.delete(listener);
    }

    function getInlineSnapshot() {
      return inline.snapshot;
    }

    function useInlineState() {
      return React.useSyncExternalStore(subscribeInline, getInlineSnapshot);
    }

    function ensureInlineAudio() {
      if (inline.audio !== null) return inline.audio;
      if (typeof Audio !== "function") throw new Error("Audio is unavailable in this browser");
      const audio = new Audio();
      audio.preload = "none";
      audio.addEventListener("playing", () => {
        if (inline.key !== null) publishInline({ state: "playing", error: null });
      });
      audio.addEventListener("play", () => {
        if (inline.key !== null) publishInline({ state: "playing", error: null });
      });
      audio.addEventListener("pause", () => {
        if (inline.key !== null && inline.state !== "idle") publishInline({ state: "paused" });
      });
      audio.addEventListener("waiting", () => {
        if (inline.key !== null) publishInline({ state: "loading" });
      });
      audio.addEventListener("timeupdate", () => {
        if (inline.key === null) return;
        publishInline({ positionMs: Math.round(audio.currentTime * 1000) });
      });
      audio.addEventListener("loadedmetadata", () => {
        if (inline.key === null) return;
        publishInline({
          durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
        });
      });
      audio.addEventListener("ended", () => {
        audio.removeAttribute("src");
        audio.load();
        publishInline({
          key: null,
          state: "idle",
          positionMs: 0,
          durationMs: 0,
          error: null,
        });
      });
      audio.addEventListener("error", () => {
        if (inline.key === null) return;
        publishInline({ state: "error", error: "Could not play the saved audio" });
      });
      inline.audio = audio;
      return audio;
    }

    function inlinePlay(key, source) {
      let audio;
      try {
        audio = ensureInlineAudio();
      } catch (error) {
        publishInline({ key, state: "error", error: error?.message ?? "Audio is unavailable" });
        return;
      }
      if (inline.key !== key || audio.getAttribute("src") !== source) {
        try { audio.pause(); } catch { /* not playing */ }
        audio.src = source;
        inline.key = key;
        inline.positionMs = 0;
        inline.durationMs = 0;
        inline.error = null;
        publishInline({ state: "loading" });
      } else {
        inline.key = key;
        inline.error = null;
        publishInline({ state: "loading" });
      }
      const started = audio.play();
      if (started !== undefined && typeof started.catch === "function") {
        started.catch((error) => {
          if (inline.key !== key) return;
          publishInline({
            state: "error",
            error: error?.message ?? "Could not play the saved audio",
          });
        });
      }
    }

    function inlinePause() {
      if (inline.audio === null || inline.key === null) return;
      inline.audio.pause();
      publishInline({ state: "paused" });
    }

    function inlineStop() {
      if (inline.audio !== null) {
        try { inline.audio.pause(); } catch { /* not playing */ }
        inline.audio.removeAttribute("src");
        inline.audio.load();
      }
      publishInline({
        key: null,
        state: "idle",
        positionMs: 0,
        durationMs: 0,
        error: null,
      });
    }

    function formatTime(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0:00";
      const total = Math.round(milliseconds / 1000);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    }

    /**
     * Poll the host for this turn's narration state.
     * @param {string} sessionId - slot-injected session id.
     * @param {number} turn - turn number.
     * @param {number} revision - bump to restart polling after a generation request.
     * @returns {[object, Function]} state and setter.
     */
    function useAudioStatus(sessionId, turn, revision) {
      const [status, setStatus] = React.useState({ state: "loading", error: null });

      React.useEffect(() => {
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          setStatus({ state: "error", error: "No session" });
          return undefined;
        }
        if (!Number.isInteger(turn) || turn < 0) {
          setStatus({ state: "error", error: "No turn" });
          return undefined;
        }
        let cancelled = false;
        let timer;
        let attempts = 0;
        const controller = new AbortController();
        const url = `/dsh-tts-chat-answer/status?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(String(turn))}`;

        const check = async () => {
          attempts += 1;
          try {
            const response = await fetch(url, {
              credentials: "same-origin",
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) {
              if (!cancelled) setStatus({ state: "error", error: `HTTP ${response.status}` });
              return;
            }
            const next = await response.json();
            if (cancelled) return;
            setStatus(next);
            if (next.state === "queued" || next.state === "processing") {
              if (attempts < 60) timer = setTimeout(check, 1500);
              else setStatus({ state: "error", error: "Audio is taking too long" });
            } else if (next.state === "missing" && attempts < 4) {
              // turn/end and the first client render race each other; give the
              // host a few seconds to enqueue the job before declaring missing.
              timer = setTimeout(check, 1000);
            }
          } catch (error) {
            if (cancelled || error?.name === "AbortError") return;
            setStatus({ state: "error", error: "Status unavailable" });
          }
        };

        void check();
        return () => {
          cancelled = true;
          controller.abort();
          if (timer !== undefined) clearTimeout(timer);
        };
      }, [sessionId, turn, revision]);

      return [status, setStatus];
    }

    /**
     * Keep host-side native playback state fresh while it is active.
     * The status hook stops once narration is ready; native playback starts
     * afterwards, so it needs its own short poll loop.
     *
     * @param {boolean} enabled - active native playback.
     * @param {string} sessionId - owning session.
     * @param {number} turn - owning turn.
     * @param {Function} setStatus - host status setter.
     */
    function useNativePolling(enabled, sessionId, turn, setStatus) {
      React.useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const url = `/dsh-tts-chat-answer/status?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(String(turn))}`;
        const timer = setInterval(async () => {
          try {
            const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
            if (!response.ok || cancelled) return;
            const next = await response.json();
            if (!cancelled) setStatus(next);
          } catch {
            // A transient status failure must not stop the UI.
          }
        }, 1000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [enabled, sessionId, turn, setStatus]);
    }

    /**
     * Pick the footer button caption for the current narration state.
     * A turn without audio offers Generate; a failed one offers Retry.
     *
     * @param {{state: string, error?: string|null}} status - host status.
     * @param {{active: boolean, playing: boolean, inlineLoading: boolean,
     *   busyAction: boolean, generating: boolean, playbackError: string|null}} view
     *   - local control state.
     * @returns {string} button caption.
     */
    function controlLabel(status, view) {
      if (view.generating) return "Generating…";
      if (view.busyAction) return "Opening…";
      if (view.inlineLoading) return "Starting…";
      if (view.active) return view.playing ? "Pause" : "Resume";
      if (status.state === "missing") return "Generate";
      if (status.state === "error") return "Retry";
      if (status.state === "loading" || status.state === "queued" || status.state === "processing") {
        return "Generating…";
      }
      if (view.playbackError !== null) return "Audio error";
      return "Play";
    }

    /**
     * Pick the footer tooltip for the current narration state.
     * A turn that is still being synthesized must not offer Play.
     *
     * @param {{state: string}} status - host status.
     * @param {{active: boolean, playing: boolean, generating: boolean,
     *   canGenerate: boolean}} view - local control state.
     * @returns {string} button tooltip and accessible label.
     */
    /**
     * Pick the Delete button caption for its confirmation step.
     * @param {boolean} confirmDelete - waiting for the second click.
     * @param {boolean} deleting - deletion request in flight.
     * @returns {string} button caption.
     */
    function deleteLabel(confirmDelete, deleting, seconds = 0) {
      if (deleting) return "Deleting…";
      if (!confirmDelete) return "Delete";
      return seconds > 0 ? `Confirm ${String(seconds)}s` : "Confirm";
    }

    function controlTitle(status, view) {
      if (view.generating) return "Generating narration";
      if (view.canGenerate) {
        return status.state === "error" ? "Retry narration" : "Generate narration";
      }
      if (view.active) return view.playing ? "Pause narration" : "Resume narration";
      if (status.state === "loading") return "Preparing narration";
      if (status.state === "queued") return "Queued for narration";
      if (status.state === "processing") return "Generating narration";
      return "Play narration";
    }

    /**
     * Play/Pause and Stop controls rendered in the completed-turn footer.
     * @param {{turn: number|{turn: number}, sessionId: string}} props - slot props and injected session.
     * @returns {object} the control.
     */
    function TtsPlayback({ turn, sessionId }) {
      // The turnTail slot exposes the whole Turn owner object, while older
      // slots passed the bare number. Accept both and key everything by number.
      const turnNumber = typeof turn === "number" ? turn : turn?.turn;
      const [revision, setRevision] = React.useState(0);
      const [generating, setGenerating] = React.useState(false);
      const [status, setStatus] = useAudioStatus(sessionId, turnNumber, revision);
      const inlineState = useInlineState();
      const [fallbackInline, setFallbackInline] = React.useState(false);
      const [busyAction, setBusyAction] = React.useState(false);
      const [folderBusy, setFolderBusy] = React.useState(false);
      const [deleting, setDeleting] = React.useState(false);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [confirmLeft, setConfirmLeft] = React.useState(0);
      const confirmDeadline = React.useRef(0);
      const [actionError, setActionError] = React.useState(null);

      React.useEffect(() => {
        if (!confirmDelete) return undefined;
        confirmDeadline.current = Date.now() + 5000;
        setConfirmLeft(5);
        const timer = setInterval(() => {
          const left = Math.max(0, Math.ceil((confirmDeadline.current - Date.now()) / 1000));
          setConfirmLeft(left);
          if (left === 0) setConfirmDelete(false);
        }, 250);
        return () => clearInterval(timer);
      }, [confirmDelete]);

      const mode = status.playMode === "native" ? "native" : "inline";
      const usingInline = mode === "inline" || fallbackInline;
      const key = `${String(sessionId)}:${String(turnNumber)}`;
      const ready = status.state === "ready";
      const busy = status.state === "loading" || status.state === "queued" || status.state === "processing";
      const canGenerate = status.state === "missing" || status.state === "error";
      const inlineActive = inlineState.key === key
        && (inlineState.state === "playing" || inlineState.state === "paused" || inlineState.state === "loading");
      const nativePlayback = usingInline ? undefined : status.playback;
      const nativeActive = nativePlayback !== undefined && nativePlayback.status !== "stopped";
      const inlinePlaying = inlineActive && inlineState.state === "playing";
      const nativePlaying = nativePlayback?.status === "playing";
      const active = inlineActive || nativeActive;
      const playing = inlineActive ? inlinePlaying : nativePlaying;
      const positionMs = inlineActive ? inlineState.positionMs : nativePlayback?.positionMs ?? 0;
      const durationMs = inlineActive ? inlineState.durationMs : nativePlayback?.durationMs ?? 0;
      const playbackError = inlineState.key === key ? inlineState.error : null;
      const hasAudio = ready || active;
      const audioUrl = `/dsh-tts-chat-answer/audio?session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(String(turnNumber))}`;

      useNativePolling(
        !usingInline && nativeActive && (nativePlayback?.status === "playing" || nativePlayback?.status === "paused"),
        sessionId,
        turnNumber,
        setStatus,
      );

      const onStop = React.useCallback(async () => {
        if (inlineActive) {
          inlineStop();
        }
        if (!usingInline && nativeActive) {
          setBusyAction(true);
          try {
            await fetch("/dsh-tts-chat-answer/playback", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: sessionId, turn: turnNumber, action: "stop" }),
            });
          } catch {
            // The player may already be gone; local state still resets.
          } finally {
            setBusyAction(false);
            setStatus({ ...status, playback: undefined });
          }
        }
      }, [inlineActive, usingInline, nativeActive, sessionId, turnNumber, setStatus, status]);

      const onPrimary = React.useCallback(async () => {
        if (!ready || busyAction) return;
        if (inlineActive) {
          if (inlineState.state === "playing") inlinePause();
          else if (inlineState.state === "paused") inlinePlay(key, audioUrl);
          return;
        }
        if (usingInline) {
          inlinePlay(key, audioUrl);
          return;
        }

        setBusyAction(true);
        try {
          if (nativeActive) {
            const action = nativePlaying ? "pause" : "play";
            const response = await fetch("/dsh-tts-chat-answer/playback", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: sessionId, turn: turnNumber, action }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
            setStatus({ ...status, playback: body.playback });
            return;
          }

          const response = await fetch("/dsh-tts-chat-answer/open", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, turn: turnNumber }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
          if (body.fallback === "inline" || body.mode === "inline" || body.ok === false) {
            setFallbackInline(true);
            inlinePlay(key, audioUrl);
            return;
          }
          setStatus({ ...status, playback: body.playback, playMode: "native" });
        } catch (error) {
          if (nativeActive) {
            setStatus({
              ...status,
              state: "error",
              error: error?.message ?? "Could not control playback",
            });
          } else {
            // The native app could not be launched or controlled; play here.
            setFallbackInline(true);
            inlinePlay(key, audioUrl);
          }
        } finally {
          setBusyAction(false);
        }
      }, [
        ready, busyAction, inlineActive, inlineState.state, usingInline, nativeActive,
        nativePlaying, sessionId, turnNumber, key, audioUrl, status, setStatus,
      ]);

      const onGenerate = React.useCallback(async () => {
        if (!canGenerate || generating) return;
        setGenerating(true);
        try {
          const response = await fetch("/dsh-tts-chat-answer/generate", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, turn: turnNumber }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
          setStatus({
            state: body.state === "ready" ? "ready" : "queued",
            playMode: status.playMode,
            error: null,
          });
          // Re-run the status hook so it polls until the queue produces audio.
          setRevision((value) => value + 1);
        } catch (error) {
          setStatus({ state: "error", error: error?.message ?? "Could not generate audio" });
        } finally {
          setGenerating(false);
        }
      }, [canGenerate, generating, sessionId, turnNumber, status.playMode, setStatus]);

      const onOpenFolder = React.useCallback(async () => {
        if (!hasAudio || folderBusy) return;
        setFolderBusy(true);
        setActionError(null);
        try {
          const response = await fetch("/dsh-tts-chat-answer/folder", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, turn: turnNumber }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        } catch (error) {
          setActionError(error?.message ?? "Could not open the audio folder");
        } finally {
          setFolderBusy(false);
        }
      }, [hasAudio, folderBusy, sessionId, turnNumber]);

      const onDelete = React.useCallback(async () => {
        if (!hasAudio || deleting) return;
        if (!confirmDelete) {
          setConfirmDelete(true);
          setActionError(null);
          return;
        }
        setConfirmDelete(false);
        setDeleting(true);
        setActionError(null);
        try {
          if (inlineActive) inlineStop();
          if (!usingInline && nativeActive) {
            await fetch("/dsh-tts-chat-answer/playback", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: sessionId, turn: turnNumber, action: "stop" }),
            }).catch(() => {});
          }
          const response = await fetch("/dsh-tts-chat-answer/delete", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, turn: turnNumber }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
          setStatus({ state: "missing", playMode: status.playMode, error: null });
          setRevision((value) => value + 1);
        } catch (error) {
          setActionError(error?.message ?? "Could not delete the narration");
        } finally {
          setDeleting(false);
        }
      }, [
        hasAudio, deleting, confirmDelete, inlineActive, usingInline, nativeActive,
        sessionId, turnNumber, status.playMode, setStatus,
      ]);

      const label = controlLabel(status, {
        active,
        playing,
        inlineLoading: inlineActive && inlineState.state === "loading",
        busyAction,
        generating,
        playbackError,
      });
      const hint = confirmDelete
        ? "Click Confirm again to delete the audio"
        : actionError !== null
          ? actionError
          : generating
            ? "Generating audio…"
            : canGenerate
              ? status.state === "error"
                ? status.error
                : "No audio for this message yet — generate it"
              : status.state === "error"
                ? status.error
                : playbackError !== null
                  ? playbackError
                  : active
                    ? `${playing ? "Playing" : "Paused"} ${formatTime(positionMs)}${durationMs > 0 ? ` / ${formatTime(durationMs)}` : ""}`
                    : busy
                      ? "Preparing audio…"
                      : busyAction
                        ? "Opening in the system player…"
                        : null;
      const actionTitle = controlTitle(status, { active, playing, generating, canGenerate });

      return React.createElement(
        "span",
        { style: WRAP_STYLE, "data-tts-chat-answer": key },
        React.createElement(
          "button",
          {
            type: "button",
            onClick: canGenerate ? onGenerate : onPrimary,
            disabled: busyAction || generating || (!ready && !canGenerate),
            style: {
              ...BUTTON_STYLE,
              opacity: ready || canGenerate ? 1 : 0.55,
              cursor: ready || canGenerate ? "pointer" : "default",
            },
            title: actionTitle,
            "aria-label": actionTitle,
            "aria-busy": busy || generating,
            "data-state": active ? (playing ? "playing" : "paused") : status.state,
          },
          label,
        ),
        active && React.createElement(
          "button",
          {
            type: "button",
            onClick: onStop,
            disabled: busyAction,
            style: {
              ...STOP_STYLE,
              opacity: busyAction ? 0.55 : 1,
              cursor: busyAction ? "default" : "pointer",
            },
            title: usingInline ? "Stop and reset playback" : "Stop and close the system player",
            "aria-label": "Stop narration",
          },
          "Stop",
        ),
        hint !== null && React.createElement("span", { style: HINT_STYLE }, hint),
        React.createElement(
          "span",
          { style: RIGHT_STYLE },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: onOpenFolder,
              disabled: !hasAudio || folderBusy,
              style: {
                ...ACTION_STYLE,
                opacity: hasAudio && !folderBusy ? 1 : 0.55,
                cursor: hasAudio && !folderBusy ? "pointer" : "default",
              },
              title: hasAudio ? "Open audio folder" : "No audio yet",
              "aria-label": "Open audio folder",
              "data-action": "open-folder",
            },
            "Open",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: onDelete,
              disabled: !hasAudio || deleting,
              style: {
                ...ACTION_STYLE,
                ...(confirmDelete ? { color: "var(--dsw-alias-state-error-primary, #b3261e)" } : {}),
                opacity: hasAudio && !deleting ? 1 : 0.55,
                cursor: hasAudio && !deleting ? "pointer" : "default",
              },
              title: confirmDelete
                ? "Confirm deletion"
                : hasAudio
                  ? "Delete the audio, transcript, and metadata"
                  : "No audio to delete",
              "aria-label": confirmDelete ? "Confirm deletion" : "Delete narration",
              "data-action": "delete-audio",
            },
            deleteLabel(confirmDelete, deleting, confirmLeft),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "tts-chat-answer",
        order: 40,
        inject: (sessionId) => ({ sessionId }),
      }, TtsPlayback));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.__test = {
      inlinePlay,
      inlinePause,
      inlineStop,
      ensureInlineAudio,
      getInlineSnapshot,
      controlLabel,
      controlTitle,
      deleteLabel,
    };
    return module.exports;
  },
});
