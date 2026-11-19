window.__ModuleLoader__.load({
  id: "@local/dsh-tts-archive",
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
      cursor: "pointer",
    };
    const WRAP_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      marginTop: "2px",
    };
    const HINT_STYLE = {
      color: "var(--dsw-alias-label-caption, #888)",
      fontSize: "11px",
      lineHeight: "20px",
    };

    // One <audio> element shared by every turn button, so starting a second
    // narration stops the first rather than mixing two tracks.
    let active = null;
    const listeners = new Set();

    const emit = () => {
      for (const listener of [...listeners]) listener();
    };

    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };

    const isActive = (key) => active !== null && active.key === key;

    const stop = () => {
      const current = active;
      active = null;
      if (current !== null) {
        current.audio.pause();
        current.audio.removeAttribute("src");
        try {
          current.audio.load();
        } catch {
          /* the element is already detached */
        }
      }
      emit();
    };

    const play = (key, url, onError) => {
      if (isActive(key)) {
        stop();
        return;
      }
      stop();
      const audio = new Audio(url);
      const entry = { key, audio };
      const fail = () => {
        if (active !== entry) return;
        active = null;
        emit();
        onError?.();
      };
      audio.addEventListener("ended", () => {
        if (active === entry) stop();
      });
      audio.addEventListener("error", fail);
      active = entry;
      emit();
      audio.play().catch(fail);
    };

    /**
     * Play/Stop control rendered in the completed-turn footer.
     * @param {{turn: number, sessionId: string}} props - slot props and injected session.
     * @returns {object} the control.
     */
    function TtsPlayback({ turn, sessionId }) {
      const key = `${String(sessionId)}:${String(turn)}`;
      const playing = React.useSyncExternalStore(subscribe, () => isActive(key));
      const [error, setError] = React.useState(null);

      const onClick = React.useCallback(() => {
        setError(null);
        if (isActive(key)) {
          stop();
          return;
        }
        const url = `/dsh-tts-archive/audio?session=${encodeURIComponent(String(sessionId))}&turn=${encodeURIComponent(String(turn))}`;
        play(key, url, () => setError("No audio"));
      }, [key, sessionId, turn]);

      return React.createElement(
        "span",
        { style: WRAP_STYLE, "data-tts-archive": key },
        React.createElement(
          "button",
          {
            type: "button",
            onClick,
            style: BUTTON_STYLE,
            title: playing ? "Stop narration" : "Play narration",
            "aria-label": playing ? "Stop narration" : "Play narration",
            "aria-pressed": playing,
          },
          playing ? "Stop" : "Play",
        ),
        error !== null && React.createElement("span", { style: HINT_STYLE }, error),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "tts-archive",
        order: 40,
        inject: (sessionId) => ({ sessionId }),
      }, TtsPlayback));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
