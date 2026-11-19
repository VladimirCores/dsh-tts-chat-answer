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
     * Play control rendered in the completed-turn footer.
     * @param {{turn: number|{turn: number}, sessionId: string}} props - slot props and injected session.
     * @returns {object} the control.
     */
    function TtsPlayback({ turn, sessionId }) {
      // The turnTail slot exposes the whole Turn owner object, while older
      // slots passed the bare number. Accept both and key everything by number.
      const turnNumber = typeof turn === "number" ? turn : turn?.turn;
      const [status, setStatus] = useAudioStatus(sessionId, turnNumber);
      const [opening, setOpening] = React.useState(false);
      const ready = status.state === "ready";
      const opened = status.state === "opened";
      const busy = status.state === "loading" || status.state === "queued" || status.state === "processing";

      const onClick = React.useCallback(async () => {
        if (!ready || opening) return;
        setOpening(true);
        try {
          const response = await fetch("/dsh-tts-chat-answer/open", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: sessionId, turn: turnNumber }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? `HTTP ${response.status}`);
          }
          setStatus({ state: "opened" });
          setTimeout(() => setStatus({ state: "ready" }), 2500);
        } catch (error) {
          setStatus({ state: "error", error: error?.message ?? "Could not open audio" });
        } finally {
          setOpening(false);
        }
      }, [ready, opening, sessionId, turnNumber, setStatus]);

      const label = opening
        ? "Opening…"
        : ready
          ? "Play"
          : opened
            ? "Opened"
            : busy
              ? "Generating…"
              : status.state === "error"
                ? "Audio error"
                : "No audio";
      const hint = status.state === "error"
        ? status.error
        : opened
          ? "Opened in the system player"
          : busy
            ? "Preparing audio…"
            : null;

      return React.createElement(
        "span",
        { style: WRAP_STYLE, "data-tts-chat-answer": `${String(sessionId)}:${String(turnNumber)}` },
        React.createElement(
          "button",
          {
            type: "button",
            onClick,
            disabled: !ready || opening,
            style: {
              ...BUTTON_STYLE,
              opacity: ready ? 1 : 0.55,
              cursor: ready ? "pointer" : "default",
            },
            title: ready ? "Play in the default system player" : "Audio is not ready",
            "aria-label": ready ? "Play narration in the default system player" : label,
            "aria-busy": busy,
            "data-state": status.state,
          },
          label,
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
    return module.exports;
  },
});
