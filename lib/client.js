window.__ModuleLoader__.load({
  id: "@local/dsh-tts-chat-answer",
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
      display: "inline-flex",
      alignItems: "center",
      gap: "7px",
      marginTop: "2px",
      minWidth: "0",
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
     * @returns {[object, Function]} state and setter.
     */
    function useAudioStatus(sessionId, turn) {
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
      }, [sessionId, turn]);

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
     * Play/Pause and Stop controls rendered in the completed-turn footer.
     * @param {{turn: number|{turn: number}, sessionId: string}} props - slot props and injected session.
     * @returns {object} the control.
     */
    function TtsPlayback({ turn, sessionId }) {
      // The turnTail slot exposes the whole Turn owner object, while older
      // slots passed the bare number. Accept both and key everything by number.
      const turnNumber = typeof turn === "number" ? turn : turn?.turn;
      const [status, setStatus] = useAudioStatus(sessionId, turnNumber);
      const inlineState = useInlineState();
      const [fallbackInline, setFallbackInline] = React.useState(false);
      const [busyAction, setBusyAction] = React.useState(false);

      const mode = status.playMode === "native" ? "native" : "inline";
      const usingInline = mode === "inline" || fallbackInline;
      const key = `${String(sessionId)}:${String(turnNumber)}`;
      const ready = status.state === "ready";
      const busy = status.state === "loading" || status.state === "queued" || status.state === "processing";
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

      const label = busyAction
        ? "Opening…"
        : inlineActive && inlineState.state === "loading"
          ? "Starting…"
          : active
            ? playing
              ? "Pause"
              : "Resume"
            : busy
              ? "Generating…"
              : playbackError !== null
                ? "Audio error"
                : status.state === "error"
                  ? "Audio error"
                  : "Play";
      const hint = status.state === "error"
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

      return React.createElement(
        "span",
        { style: WRAP_STYLE, "data-tts-chat-answer": key },
        React.createElement(
          "button",
          {
            type: "button",
            onClick: onPrimary,
            disabled: !ready || busyAction,
            style: {
              ...BUTTON_STYLE,
              opacity: ready ? 1 : 0.55,
              cursor: ready ? "pointer" : "default",
            },
            title: active ? (playing ? "Pause narration" : "Resume narration") : "Play narration",
            "aria-label": active
              ? (playing ? "Pause narration" : "Resume narration")
              : "Play narration",
            "aria-busy": busy,
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
    };
    return module.exports;
  },
});
