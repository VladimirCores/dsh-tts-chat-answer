/**
 * dsh-tts-chat-answer — narrate every completed assistant answer and save it locally.
 *
 * The plugin listens to the Harness session event stream, waits for a turn to
 * finish, takes the final text-only assistant message of that turn, converts
 * it to a speech-friendly script, and synthesizes an MP3 with Edge TTS.
 *
 * Design constraints:
 *  - Never block or fail the agent loop. All work is detached and queued.
 *  - One job at a time, so a burst of answers cannot spawn an unbounded number
 *    of TTS processes.
 *  - Long answers are split into sentence-sized chunks and synthesized in
 *    parallel; ffmpeg joins the chunks.
 *  - Every output is self-describing: .mp3, .txt transcript, .json metadata,
 *    plus an index.jsonl line.
 *  - `engine: "espeak"` is fully local. `engine: "edge"` sends the script to
 *    Microsoft's Edge TTS service; enable it only when that is acceptable.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import Schema from "@deepseek-ai/schemastery";

const execFileAsync = promisify(execFile);
const VERSION = 1;
const PLUGIN = "dsh-tts-chat-answer";

export const name = "dsh-tts-chat-answer";

const DEFAULTS = Object.freeze({
  enabled: false,
  outputDir: "~/.local/share/dsh-tts-chat-answer",
  groupByWorkspace: true,
  engine: "edge",
  playMode: "inline",
  voice: "en-US-AriaNeural",
  fallbackVoice: "en-US-GuyNeural",
  rate: "+10%",
  volume: "+0%",
  pitch: "+0Hz",
  minChars: 40,
  maxChars: 12000,
  chunkChars: 1200,
  concurrency: 2,
  timeoutMs: 600000,
  maxQueue: 20,
  includeSubagents: false,
  includeIncomplete: false,
  keepTranscript: true,
  redactSecrets: true,
  espeakCommand: "espeak-ng",
  espeakVoice: "en-us",
  espeakRate: 165,
  ffmpegCommand: "ffmpeg",
  edgeTtsCommand: "edge-tts",
  openCommand: "",
});

/**
 * Cordis configuration contract. Defaults match DEFAULTS; invalid values fail
 * the plugin load instead of being silently coerced.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  outputDir: Schema.string().pattern(/\S/u).default(DEFAULTS.outputDir),
  groupByWorkspace: Schema.boolean().default(DEFAULTS.groupByWorkspace),
  engine: Schema.union(["edge", "espeak"]).default(DEFAULTS.engine),
  playMode: Schema.union(["inline", "native"]).default(DEFAULTS.playMode),
  voice: Schema.string().pattern(/\S/u).default(DEFAULTS.voice).description(
    "Edge voice id. Built-in setup choices include ru-RU-SvetlanaNeural (Russian, female) " +
    "and ru-RU-DmitryNeural (Russian, male); any Edge voice id is accepted.",
  ),
  fallbackVoice: Schema.string().default(DEFAULTS.fallbackVoice).description(
    "Voice retried when the primary voice returns no audio; the setup pairs Russian voices " +
    "with each other.",
  ),
  rate: Schema.string().pattern(/^[+-]\d+%$/u).default(DEFAULTS.rate),
  volume: Schema.string().pattern(/^[+-]\d+%$/u).default(DEFAULTS.volume),
  pitch: Schema.string().pattern(/^[+-]\d+Hz$/u).default(DEFAULTS.pitch),
  minChars: Schema.natural().min(1).max(10000).default(DEFAULTS.minChars),
  maxChars: Schema.natural().min(100).max(200000).default(DEFAULTS.maxChars),
  chunkChars: Schema.natural().min(200).max(8000).default(DEFAULTS.chunkChars),
  concurrency: Schema.natural().min(1).max(8).default(DEFAULTS.concurrency),
  timeoutMs: Schema.natural().min(10000).max(3600000).default(DEFAULTS.timeoutMs),
  maxQueue: Schema.natural().min(1).max(1000).default(DEFAULTS.maxQueue),
  includeSubagents: Schema.boolean().default(DEFAULTS.includeSubagents),
  includeIncomplete: Schema.boolean().default(DEFAULTS.includeIncomplete),
  keepTranscript: Schema.boolean().default(DEFAULTS.keepTranscript),
  redactSecrets: Schema.boolean().default(DEFAULTS.redactSecrets),
  espeakCommand: Schema.string().pattern(/\S/u).default(DEFAULTS.espeakCommand),
  espeakVoice: Schema.string().pattern(/\S/u).default(DEFAULTS.espeakVoice),
  espeakRate: Schema.natural().min(80).max(450).default(DEFAULTS.espeakRate),
  ffmpegCommand: Schema.string().pattern(/\S/u).default(DEFAULTS.ffmpegCommand),
  edgeTtsCommand: Schema.string().pattern(/\S/u).default(DEFAULTS.edgeTtsCommand),
  openCommand: Schema.string().default(DEFAULTS.openCommand),
});

/**
 * Register the TTS chat-answer plugin.
 *
 * Returning `{ whenIdle }` is convenient for tests and harmless for the
 * loader, which ignores the plugin return value.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - bundle config from cordis.patch.yml.
 * @returns {{ whenIdle: () => Promise<void> }}
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const log = makeLogger(ctx);
  const state = {
    disposed: false,
    seen: new Set(),
    queue: [],
    jobs: new Map(),
    running: false,
    active: new Set(),
    idleWaiters: [],
    native: undefined,
    nativeQueue: Promise.resolve(),
  };

  /** Resolve every waiter when the queue becomes idle. */
  const notifyIdle = () => {
    if (state.queue.length > 0 || state.running) return;
    for (const resolveWaiter of state.idleWaiters.splice(0)) resolveWaiter();
  };

  /** Resolves when nothing is queued or running. */
  const whenIdle = () => {
    if (state.queue.length === 0 && !state.running) return Promise.resolve();
    return new Promise((resolveWaiter) => state.idleWaiters.push(resolveWaiter));
  };

  const disposeListener = typeof ctx.on === "function"
    ? ctx.on("session/event", (session, event) => {
        if (state.disposed || !cfg.enabled) return;
        if (event?.type !== "turn/end") return;
        try {
          scheduleTurn(session, event);
        } catch (error) {
          log.warn(`could not schedule turn: ${error?.message ?? String(error)}`);
        }
      })
    : () => {};

  if (typeof ctx.effect === "function") {
    ctx.effect(() => async () => {
      state.disposed = true;
      disposeListener();
      state.queue.length = 0;
      state.jobs.clear();
      for (const child of state.active) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      state.active.clear();
      void closeNative();
      notifyIdle();
    }, "tts-chat-answer: queue");
  }

  log.info(
    `enabled=${cfg.enabled} engine=${cfg.engine} output=${cfg.outputDir} ` +
    `voice=${cfg.voice} playMode=${cfg.playMode} chunkChars=${cfg.chunkChars}`,
  );
  void writeReadyMarker();

  // Web profile: expose readiness and hand the saved MP3 to the system player.
  // `inject` keeps non-web profiles working: without these services the
  // callback never runs, but generation and the ready marker still load.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer", "connection", "sessions"], (webCtx) => {
      registerAudioRoute(webCtx);
    });
  }

  return { whenIdle };

  /** Serialize native-player operations so two Play clicks cannot race. */
  function enqueueNative(task) {
    const run = state.nativeQueue.then(task, task);
    state.nativeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Close the one native player this plugin opened, if any. */
  async function doCloseNative() {
    const current = state.native;
    state.native = undefined;
    if (current === undefined) return;
    await mprisCall(current.player, "Player", "Stop");
    await mprisCall(current.player, "Root", "Quit");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!(await listMprisPlayers()).includes(current.player)) return;
      await sleep(100);
    }
  }

  /** Queue a native-player close. */
  function closeNative() {
    return enqueueNative(() => doCloseNative());
  }

  /**
   * Launch the default app, find its MPRIS player, and start playback.
   * The caller gets `fallback: "inline"` when the app cannot be controlled.
   *
   * @param {{path: string, size: number}} found - indexed audio file.
   * @param {string} sessionId - owning session id.
   * @param {number} turn - owning turn.
   * @returns {Promise<object>} route payload.
   */
  async function openNative(found, sessionId, turn) {
    return enqueueNative(async () => {
      await doCloseNative();
      const before = new Set(await listMprisPlayers());
      try {
        await openWithSystemApp(found.path, cfg);
      } catch (error) {
        return {
          ok: false,
          mode: "native",
          fallback: "inline",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      let match;
      for (let attempt = 0; attempt < 14 && match === undefined; attempt += 1) {
        await sleep(250);
        match = await findMprisForFile(found.path);
      }
      if (match === undefined) {
        // Do not leave a just-started, uncontrollable player behind.
        for (const player of await listMprisPlayers()) {
          if (!before.has(player)) await quitMprisPlayer(player);
        }
        return {
          ok: false,
          mode: "native",
          fallback: "inline",
          error: "native player did not expose MPRIS control",
        };
      }

      state.native = {
        player: match.player,
        sessionId,
        turn,
        filePath: found.path,
        durationMs: match.durationMs,
        startedAt: Date.now(),
        status: undefined,
        positionMs: 0,
      };
      await mprisCall(match.player, "Player", "Play");
      await sleep(150);
      const playback = await snapshotNative();
      if (playback === undefined) {
        await doCloseNative();
        return { ok: false, mode: "native", fallback: "inline", error: "native playback did not start" };
      }
      return { ok: true, mode: "native", playback };
    });
  }

  /**
   * Read the current native state for one turn without starting anything.
   *
   * @param {string} [sessionId] - filter by session.
   * @param {number} [turn] - filter by turn.
   * @returns {Promise<object|undefined>} playback snapshot.
   */
  async function snapshotNative(sessionId, turn) {
    const current = state.native;
    if (current === undefined) return undefined;
    if (sessionId !== undefined && (current.sessionId !== sessionId || current.turn !== turn)) {
      return undefined;
    }
    const status = await mprisStatus(current.player);
    if (status === undefined) {
      state.native = undefined;
      return undefined;
    }
    const positionUs = await mprisPosition(current.player);
    const positionMs = Math.max(0, Math.round((positionUs ?? 0) / 1000));
    // Decibels reports "Paused" at position 0 when a track ends instead of
    // "Stopped". Treat the Playing -> Paused-at-zero transition, or a paused
    // zero position after the known duration elapsed, as completion.
    const ended = status === "Stopped"
      || (status === "Paused"
        && positionMs <= 100
        && (current.status === "Playing" && current.positionMs > 0
          || Date.now() - current.startedAt >= (current.durationMs ?? 0) + 1000));
    if (ended) {
      await doCloseNative();
      return undefined;
    }
    current.status = status;
    current.positionMs = positionMs;
    return {
      mode: "native",
      status: status.toLowerCase(),
      positionMs,
      durationMs: current.durationMs,
    };
  }

  /** Queue a native-state refresh. */
  function refreshNative(sessionId, turn) {
    return enqueueNative(() => snapshotNative(sessionId, turn));
  }

  /**
   * Apply play/pause/stop to the active native player.
   *
   * @param {string} sessionId - owning session id.
   * @param {number} turn - owning turn.
   * @param {string} action - play, pause, toggle, or stop.
   * @returns {Promise<object>} action result.
   */
  function nativeAction(sessionId, turn, action) {
    return enqueueNative(async () => {
      const current = state.native;
      if (current === undefined || current.sessionId !== sessionId || current.turn !== turn) {
        return { ok: false, error: "not playing" };
      }
      if (action === "stop") {
        await doCloseNative();
        return { ok: true };
      }
      const method = action === "play" ? "Play" : action === "pause" ? "Pause" : "PlayPause";
      if ((await mprisCall(current.player, "Player", method)) === undefined) {
        return { ok: false, error: "native player did not accept the command" };
      }
      return { ok: true, playback: await snapshotNative() };
    });
  }

  /**
   * Register the authenticated audio, status, and system-open routes.
   * @param {object} webCtx - context carrying webServer and connection.
   */
  function registerAudioRoute(webCtx) {
    const sendJson = (res, status, payload) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(payload));
    };
    const authorize = (req, res) => {
      const connection = Reflect.get(webCtx, "connection");
      const rejection = connection?.requestRejection?.(req);
      if (rejection === undefined) return true;
      res.statusCode = rejection;
      res.end();
      return false;
    };
    const targetFromUrl = (url) => {
      const sessionId = url.searchParams.get("session") ?? "";
      const turn = Number(url.searchParams.get("turn"));
      if (sessionId.length === 0 || !Number.isInteger(turn) || turn < 0) return undefined;
      return { sessionId, turn };
    };

    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({
          kind: "exact",
          path: "/dsh-tts-chat-answer/audio",
          handler: async (req, res) => {
            if (!authorize(req, res)) return;
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.statusCode = 405;
              res.setHeader("allow", "GET, HEAD");
              res.end();
              return;
            }
            const target = targetFromUrl(new URL(req.url ?? "/", "http://localhost"));
            if (target === undefined) {
              res.statusCode = 400;
              res.end("session and non-negative integer turn are required\n");
              return;
            }
            const found = await findAudio(cfg.outputDir, target.sessionId, target.turn);
            if (found === undefined) {
              res.statusCode = 404;
              res.end("no narration for this turn\n");
              return;
            }
            const range = parseByteRange(req.headers.range, found.size);
            if (req.headers.range !== undefined && range === null) {
              res.statusCode = 416;
              res.setHeader("content-range", `bytes */${String(found.size)}`);
              res.end();
              return;
            }
            const start = range?.start ?? 0;
            const end = range?.end ?? found.size - 1;
            res.statusCode = range === null ? 200 : 206;
            res.setHeader("content-type", "audio/mpeg");
            res.setHeader("accept-ranges", "bytes");
            res.setHeader("content-length", String(end - start + 1));
            res.setHeader("cache-control", "private, max-age=3600");
            if (range !== null) {
              res.setHeader("content-range", `bytes ${String(start)}-${String(end)}/${String(found.size)}`);
            }
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            const stream = createReadStream(found.path, { start, end });
            stream.on("error", () => {
              if (!res.headersSent) res.statusCode = 500;
              res.end();
            });
            res.on("close", () => stream.destroy());
            stream.pipe(res);
          },
        }),
        webCtx.webServer.register({
          kind: "exact",
          path: "/dsh-tts-chat-answer/status",
          handler: async (req, res) => {
            if (!authorize(req, res)) return;
            if (req.method !== "GET") {
              res.statusCode = 405;
              res.setHeader("allow", "GET");
              res.end();
              return;
            }
            const target = targetFromUrl(new URL(req.url ?? "/", "http://localhost"));
            if (target === undefined) {
              sendJson(res, 400, { error: "session and non-negative integer turn are required" });
              return;
            }
            const base = await findStatus(cfg.outputDir, target.sessionId, target.turn, state.jobs);
            const payload = { ...base, playMode: cfg.playMode };
            if (cfg.playMode === "native" && base.state === "ready") {
              const playback = await refreshNative(target.sessionId, target.turn);
              if (playback !== undefined) payload.playback = playback;
            }
            sendJson(res, 200, payload);
          },
        }),
        webCtx.webServer.register({
          kind: "exact",
          path: "/dsh-tts-chat-answer/generate",
          handler: async (req, res) => {
            if (!authorize(req, res)) return;
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.setHeader("allow", "POST");
              res.end();
              return;
            }
            const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
            if (contentType !== "application/json") {
              sendJson(res, 415, { error: "content-type must be application/json" });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req, 4096);
            } catch {
              sendJson(res, 400, { error: "request body is not valid JSON" });
              return;
            }
            const sessionId = typeof body?.session === "string" ? body.session : "";
            const turn = Number(body?.turn);
            if (sessionId.length === 0 || !Number.isInteger(turn) || turn < 0) {
              sendJson(res, 400, { error: "session and non-negative integer turn are required" });
              return;
            }
            const existing = await findAudio(cfg.outputDir, sessionId, turn);
            if (existing !== undefined) {
              sendJson(res, 200, { ok: true, state: "ready" });
              return;
            }
            const running = state.jobs.get(`${sessionId}:${turn}`);
            if (running !== undefined) {
              sendJson(res, 200, {
                ok: true,
                state: running.status === "processing" ? "processing" : "queued",
              });
              return;
            }
            const sessions = Reflect.get(webCtx, "sessions");
            const session = sessions?.get?.(sessionId);
            if (session === undefined) {
              sendJson(res, 404, { error: "session is not loaded; open the conversation first" });
              return;
            }
            const picked = pickAssistantText(session, turn);
            if (picked === undefined) {
              sendJson(res, 422, { error: "no assistant answer for this turn" });
              return;
            }
            const speech = prepareSpeech(picked.text, cfg);
            if (speech.length < cfg.minChars) {
              sendJson(res, 422, { error: "answer is too short to narrate" });
              return;
            }
            if (state.queue.length >= cfg.maxQueue) {
              sendJson(res, 429, { error: "narration queue is full" });
              return;
            }
            const job = buildJob(session, turn, picked, speech, undefined);
            state.seen.add(job.key);
            state.jobs.set(job.key, { status: "queued", createdAt: job.createdAt });
            state.queue.push(job);
            log.info(`generate ${job.key} workspace=${job.workspaceKey} (${speech.length} speakable)`);
            void drain();
            sendJson(res, 200, { ok: true, state: "queued" });
          },
        }),
        webCtx.webServer.register({
          kind: "exact",
          path: "/dsh-tts-chat-answer/open",
          handler: async (req, res) => {
            if (!authorize(req, res)) return;
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.setHeader("allow", "POST");
              res.end();
              return;
            }
            const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
            if (contentType !== "application/json") {
              sendJson(res, 415, { error: "content-type must be application/json" });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req, 4096);
            } catch {
              sendJson(res, 400, { error: "request body is not valid JSON" });
              return;
            }
            const sessionId = typeof body?.session === "string" ? body.session : "";
            const turn = Number(body?.turn);
            if (sessionId.length === 0 || !Number.isInteger(turn) || turn < 0) {
              sendJson(res, 400, { error: "session and non-negative integer turn are required" });
              return;
            }
            const found = await findAudio(cfg.outputDir, sessionId, turn);
            if (found === undefined) {
              sendJson(res, 404, { error: "no narration for this turn" });
              return;
            }
            if (cfg.playMode !== "native") {
              sendJson(res, 200, { ok: true, mode: "inline" });
              return;
            }
            try {
              const result = await openNative(found, sessionId, turn);
              sendJson(res, 200, result);
            } catch (error) {
              sendJson(res, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
        webCtx.webServer.register({
          kind: "exact",
          path: "/dsh-tts-chat-answer/playback",
          handler: async (req, res) => {
            if (!authorize(req, res)) return;
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.setHeader("allow", "POST");
              res.end();
              return;
            }
            const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
            if (contentType !== "application/json") {
              sendJson(res, 415, { error: "content-type must be application/json" });
              return;
            }
            let body;
            try {
              body = await readJsonBody(req, 4096);
            } catch {
              sendJson(res, 400, { error: "request body is not valid JSON" });
              return;
            }
            const sessionId = typeof body?.session === "string" ? body.session : "";
            const turn = Number(body?.turn);
            const action = typeof body?.action === "string" ? body.action : "";
            if (sessionId.length === 0 || !Number.isInteger(turn) || turn < 0) {
              sendJson(res, 400, { error: "session and non-negative integer turn are required" });
              return;
            }
            if (!["play", "pause", "toggle", "stop"].includes(action)) {
              sendJson(res, 400, { error: "action must be play, pause, toggle, or stop" });
              return;
            }
            const result = await nativeAction(sessionId, turn, action);
            sendJson(res, result.ok === true ? 200 : 404, result);
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "tts-chat-answer: web routes");
  }

  /** Create the output root and a marker proving this profile loaded the plugin. */
  async function writeReadyMarker() {
    try {
      await mkdir(cfg.outputDir, { recursive: true });
      await writeFile(
        join(cfg.outputDir, ".ready"),
        `${JSON.stringify({
          plugin: PLUGIN,
          version: VERSION,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          engine: cfg.engine,
          playMode: cfg.playMode,
          voice: cfg.engine === "edge" ? cfg.voice : cfg.espeakVoice,
          chunkChars: cfg.chunkChars,
          concurrency: cfg.concurrency,
        }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      log.warn(`could not write ready marker: ${error?.message ?? String(error)}`);
    }
  }

  /**
   * Decide whether this turn is narratable and enqueue it.
   * @param {object} session - Session that emitted the event.
   * @param {object} event - `turn/end` event.
   */
  function scheduleTurn(session, event) {
    if (!cfg.includeSubagents && session?.header?.parentSession !== undefined) return;

    const reason = event?.data?.reason?.kind;
    if (reason === "error" || reason === "aborted") return;
    if (reason !== "completed" && !cfg.includeIncomplete) return;

    const turn = event?.data?.turn;
    if (!Number.isInteger(turn) || turn < 0) return;

    const sessionId = String(session?.id ?? session?.header?.id ?? "unknown");
    const key = `${sessionId}:${turn}`;
    if (state.seen.has(key)) return;

    const picked = pickAssistantText(session, turn);
    if (picked === undefined) {
      state.seen.add(key);
      return;
    }

    const speech = prepareSpeech(picked.text, cfg);
    if (speech.length < cfg.minChars) {
      state.seen.add(key);
      log.info(`skip ${key}: only ${speech.length} speakable characters`);
      return;
    }

    if (state.queue.length >= cfg.maxQueue) {
      log.warn(`queue full (${state.queue.length}); skipping ${key}`);
      state.seen.add(key);
      return;
    }

    state.seen.add(key);
    const job = buildJob(session, turn, picked, speech, event?.seq);
    state.jobs.set(job.key, { status: "queued", createdAt: job.createdAt });
    state.queue.push(job);
    log.info(
      `queued ${job.key} workspace=${job.workspaceKey} ` +
      `(${picked.text.length} chars, ${speech.length} speakable)`,
    );
    void drain();
  }

  /**
   * Describe one synthesis job: output paths, text, and workspace.
   * Automatic turn/end narration and on-demand generation share this shape.
   *
   * @param {object} session - Session that owns the turn.
   * @param {number} turn - turn number.
   * @param {{text: string}} picked - assistant answer chosen for narration.
   * @param {string} speech - speech-ready text.
   * @param {number|undefined} eventSeq - originating event sequence, when any.
   * @returns {object} job.
   */
  function buildJob(session, turn, picked, speech, eventSeq) {
    const sessionId = String(session?.id ?? session?.header?.id ?? "unknown");
    const workspace = workspaceInfo(session?.header?.cwd, cfg.groupByWorkspace);
    const dir = join(cfg.outputDir, ...workspace.dirParts, dayStamp());
    const base = baseName(sessionId, turn);
    return {
      key: `${sessionId}:${turn}`,
      sessionId,
      turn,
      workspaceKey: workspace.key,
      workspacePath: workspace.path,
      eventSeq,
      createdAt: new Date().toISOString(),
      text: picked.text,
      speech,
      paths: {
        dir,
        mp3: join(dir, `${base}.mp3`),
        txt: join(dir, `${base}.txt`),
        json: join(dir, `${base}.json`),
      },
    };
  }

  /** Process queued jobs one at a time. */
  async function drain() {
    if (state.running) return;
    state.running = true;
    try {
      while (state.queue.length > 0 && !state.disposed) {
        const job = state.queue.shift();
        state.jobs.set(job.key, { status: "processing", startedAt: new Date().toISOString() });
        try {
          await processJob(job);
          state.jobs.delete(job.key);
        } catch (error) {
          await recordFailure(job, error);
          state.jobs.delete(job.key);
          log.warn(`failed ${job.key}: ${error?.message ?? String(error)}`);
        }
      }
    } finally {
      state.running = false;
      notifyIdle();
    }
  }

  /**
   * Synthesize and persist one job.
   * @param {object} job - queued job.
   */
  async function processJob(job) {
    await mkdir(job.paths.dir, { recursive: true });

    // A previous process (or a resumed session) may have produced this turn
    // already. Filenames embed session + turn, so existence is the dedupe.
    if (await fileExists(job.paths.mp3)) {
      log.info(`already narrated: ${job.paths.mp3}`);
      return;
    }

    if (cfg.keepTranscript) {
      await writeFile(job.paths.txt, `${job.text}\n`, "utf8");
    }

    const work = await mkdtemp(join(job.paths.dir, ".tts-work-"));
    let result;
    try {
      result = await synthesize(job.speech, job.paths.mp3, work);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }

    const metadata = {
      version: VERSION,
      plugin: PLUGIN,
      status: "done",
      sessionId: job.sessionId,
      turn: job.turn,
      eventSeq: job.eventSeq,
      workspace: {
        key: job.workspaceKey,
        path: job.workspacePath,
      },
      createdAt: job.createdAt,
      finishedAt: new Date().toISOString(),
      engine: cfg.engine,
      voice: result.voice ?? (cfg.engine === "edge" ? cfg.voice : cfg.espeakVoice),
      rate: cfg.engine === "edge" ? cfg.rate : `${cfg.espeakRate} wpm`,
      sourceChars: job.text.length,
      speechChars: job.speech.length,
      chunks: result.chunks,
      bytes: result.bytes,
      audio: job.paths.mp3,
      transcript: cfg.keepTranscript ? job.paths.txt : null,
      error: null,
    };
    await writeFile(job.paths.json, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await appendIndex(metadata);
    log.info(`saved ${job.paths.mp3} (${result.chunks} chunk(s), ${formatBytes(result.bytes)})`);
  }

  /**
   * Write a failure record next to the would-be audio.
   * @param {object} job - failed job.
   * @param {unknown} error - thrown error.
   */
  async function recordFailure(job, error) {
    const message = error?.stack ?? error?.message ?? String(error);
    try {
      await mkdir(job.paths.dir, { recursive: true });
      await writeFile(
        job.paths.json,
        `${JSON.stringify({
          version: VERSION,
          plugin: PLUGIN,
          status: "error",
          sessionId: job.sessionId,
          turn: job.turn,
          eventSeq: job.eventSeq,
          workspace: {
            key: job.workspaceKey,
            path: job.workspacePath,
          },
          createdAt: job.createdAt,
          finishedAt: new Date().toISOString(),
          engine: cfg.engine,
          audio: job.paths.mp3,
          transcript: cfg.keepTranscript ? job.paths.txt : null,
          error: message,
        }, null, 2)}\n`,
        "utf8",
      );
      await appendIndex({
        status: "error",
        sessionId: job.sessionId,
        turn: job.turn,
        workspace: {
          key: job.workspaceKey,
          path: job.workspacePath,
        },
        createdAt: job.createdAt,
        finishedAt: new Date().toISOString(),
        error: String(error?.message ?? error),
      });
    } catch (writeError) {
      log.warn(`could not write failure record: ${writeError?.message ?? String(writeError)}`);
    }
  }

  /**
   * Append one line to the output index. Index failures never fail a job.
   * @param {object} record - metadata or failure record.
   */
  async function appendIndex(record) {
    try {
      await appendFile(join(cfg.outputDir, "index.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      log.warn(`could not append index: ${error?.message ?? String(error)}`);
    }
  }

  /**
   * Convert one speech script into an MP3.
   * @param {string} text - speech-ready text.
   * @param {string} outMp3 - destination path.
   * @param {string} work - temporary directory.
   * @returns {Promise<{chunks: number, bytes: number, voice: string}>}
   */
  async function synthesize(text, outMp3, work) {
    if (cfg.engine === "espeak") {
      await synthesizeEspeak(text, outMp3, work);
      return { chunks: 1, bytes: (await stat(outMp3)).size, voice: cfg.espeakVoice };
    }

    const chunks = splitForSpeech(text, cfg.chunkChars);
    if (chunks.length <= 1) {
      const input = join(work, "speech.txt");
      await writeFile(input, text, "utf8");
      const voice = await runEdgeWithFallback(input, outMp3);
      return { chunks: 1, bytes: (await stat(outMp3)).size, voice };
    }

    const files = new Array(chunks.length);
    const voices = new Array(chunks.length);
    await mapLimit(chunks, cfg.concurrency, async (chunk, index) => {
      const padded = String(index).padStart(3, "0");
      const input = join(work, `chunk-${padded}.txt`);
      const output = join(work, `chunk-${padded}.mp3`);
      await writeFile(input, chunk, "utf8");
      voices[index] = await runEdgeWithFallback(input, output);
      files[index] = output;
    });

    try {
      await concatMp3(files, outMp3, work);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // No ffmpeg: fall back to one request for the whole script.
      log.warn("ffmpeg missing; falling back to a single Edge TTS request");
      const input = join(work, "speech.txt");
      await writeFile(input, text, "utf8");
      const voice = await runEdgeWithFallback(input, outMp3);
      return { chunks: 1, bytes: (await stat(outMp3)).size, voice };
    }
    return {
      chunks: chunks.length,
      bytes: (await stat(outMp3)).size,
      voice: voices.find((voice) => typeof voice === "string") ?? cfg.voice,
    };
  }

  /**
   * Local espeak-ng path. Produces a 64 kbps mono MP3.
   * @param {string} text - speech-ready text.
   * @param {string} outMp3 - destination path.
   * @param {string} work - temporary directory.
   */
  async function synthesizeEspeak(text, outMp3, work) {
    const input = join(work, "speech.txt");
    const wav = join(work, "speech.wav");
    await writeFile(input, text, "utf8");
    await runProcess(cfg.espeakCommand, [
      "-f", input, "-w", wav, "-s", String(cfg.espeakRate), "-v", cfg.espeakVoice,
    ], cfg.timeoutMs);
    await runProcess(cfg.ffmpegCommand, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", wav, "-codec:a", "libmp3lame", "-b:a", "64k", outMp3,
    ], cfg.timeoutMs);
  }

  /**
   * Run edge-tts with the configured voice, then the fallback voice if the
   * service returns no audio (a known intermittent failure on some voices).
   * @param {string} input - text file path.
   * @param {string} output - MP3 path.
   * @returns {Promise<string>} the voice that produced audio.
   */
  async function runEdgeWithFallback(input, output) {
    try {
      await runEdge(input, output, cfg.voice);
      return cfg.voice;
    } catch (error) {
      if (cfg.fallbackVoice.length === 0 || cfg.fallbackVoice === cfg.voice) throw error;
      log.warn(`Edge voice ${cfg.voice} failed; retrying with ${cfg.fallbackVoice}`);
      await runEdge(input, output, cfg.fallbackVoice);
      return cfg.fallbackVoice;
    }
  }

  /**
   * Run edge-tts for one text file, trying PATH first and the usual
   * `~/.local/bin` install second.
   * @param {string} input - text file path.
   * @param {string} output - MP3 path.
   * @param {string} voice - Edge voice.
   */
  async function runEdge(input, output, voice) {
    const candidates = [cfg.edgeTtsCommand];
    if (cfg.edgeTtsCommand === "edge-tts") {
      candidates.push(join(homedir(), ".local", "bin", "edge-tts"));
    }
    let lastError;
    for (const command of candidates) {
      try {
        await runProcess(command, [
          "-f", input,
          "-v", voice,
          "--rate", cfg.rate,
          "--volume", cfg.volume,
          "--pitch", cfg.pitch,
          "--write-media", output,
          "--no-progress",
        ], cfg.timeoutMs);
        return;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    throw lastError;
  }

  /**
   * Join chunk MP3s with the concat demuxer.
   * @param {string[]} files - ordered chunk paths.
   * @param {string} output - destination MP3.
   * @param {string} work - temporary directory.
   */
  async function concatMp3(files, output, work) {
    const list = join(work, "concat.txt");
    const lines = files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
    await writeFile(list, `${lines}\n`, "utf8");
    try {
      await runProcess(cfg.ffmpegCommand, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", list,
        "-c", "copy", output,
      ], cfg.timeoutMs);
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      // Different bitrates or headers: re-encode rather than fail the job.
      await runProcess(cfg.ffmpegCommand, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", list,
        "-c:a", "libmp3lame", "-b:a", "48k", output,
      ], cfg.timeoutMs);
    }
  }

  /**
   * Spawn a child with a timeout and bounded stderr capture.
   * @param {string} command - executable.
   * @param {string[]} args - arguments.
   * @param {number} timeoutMs - hard deadline.
   * @returns {Promise<{stderr: string}>}
   */
  function runProcess(command, args, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      state.active.add(child);

      let stderr = "";
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.active.delete(child);
        fn(value);
      };
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        const error = new Error(`${command} timed out after ${timeoutMs} ms`);
        error.code = "ETIMEDOUT";
        finish(rejectPromise, error);
      }, timeoutMs);

      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 16384) stderr += chunk.toString();
      });
      child.on("error", (error) => finish(rejectPromise, error));
      child.on("close", (code) => {
        if (code === 0) {
          finish(resolvePromise, { stderr });
          return;
        }
        const detail = stderr.trim().slice(-2000);
        const error = new Error(
          `${command} exited with code ${code}${detail ? `: ${detail}` : ""}`,
        );
        error.code = "EPROCESS";
        error.exitCode = code;
        error.stderr = stderr;
        finish(rejectPromise, error);
      });
    });
  }
}

/**
 * Validate and normalize bundle config.
 * @param {object} raw - untrusted config.
 * @returns {object} immutable config.
 */
function normalizeConfig(raw) {
  const value = Config(raw && typeof raw === "object" ? raw : {});
  return Object.freeze({
    ...value,
    outputDir: resolve(expandHome(value.outputDir)),
  });
}

/**
 * Choose the final spoken assistant message for a turn.
 *
 * The last assistant message without tool calls is the final answer. If the
 * turn ended while a tool-call message was still last, fall back to the last
 * assistant message that carried any text.
 *
 * @param {object} session - session with a `log` array.
 * @param {number} turn - turn number.
 * @returns {{text: string, event: object}|undefined}
 */
function pickAssistantText(session, turn) {
  const events = Array.isArray(session?.log) ? session.log : [];
  let textOnly;
  let anyText;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    if (event.data?.turn !== turn) continue;
    if (event.data?.interrupted === true) continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length === 0) continue;
    const hasToolCall = content.some((block) => block?.type === "tool-call");
    if (!hasToolCall) textOnly = { text, event };
    anyText = { text, event };
  }
  return textOnly ?? anyText;
}

/**
 * Turn Markdown output into something worth listening to.
 * @param {string} input - assistant Markdown.
 * @param {object} cfg - normalized config.
 * @returns {string} speech script.
 */
function prepareSpeech(input, cfg) {
  let text = String(input ?? "");
  if (cfg.redactSecrets) text = redactSecrets(text);
  text = toSpeechText(text);
  text = truncateAtSentence(text, cfg.maxChars);
  return text.trim();
}

/**
 * Strip Markdown, tables, links, code blocks, and control characters.
 * Code blocks become a short spoken note rather than being read aloud.
 * @param {string} input - Markdown text.
 * @returns {string} plain speech text.
 */
function toSpeechText(input) {
  let text = String(input ?? "");
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, "\nCode block omitted.\n");
  text = text.replace(/~~~[\s\S]*?~~~/g, "\nCode block omitted.\n");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>]+>/g, "a link");
  text = text.replace(/https?:\/\/[^\s)]+/g, "a link");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[*_~`]{1,3}/g, "");
  text = text.replace(/<[^>]*>/g, "");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Replace obvious credentials before text leaves the machine.
 * This is a safety net, not a guarantee; it does not parse code.
 * @param {string} text - input text.
 * @returns {string} redacted text.
 */
function redactSecrets(text) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:xoxb|xoxp|glpat)-[A-Za-z0-9_-]{10,}\b/g,
  ];
  let output = text;
  for (const pattern of patterns) output = output.replace(pattern, "[redacted secret]");
  return output;
}

/**
 * Split text into sentence-aligned chunks below a character budget.
 * @param {string} text - speech text.
 * @param {number} maxChars - per-chunk budget.
 * @returns {string[]} chunks.
 */
function splitForSpeech(text, maxChars) {
  const normalized = String(text ?? "").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  const sentences = normalized.match(/[^.!?…]+[.!?…]+(?:["')\]]+)?|\S[^.!?…]*$/gu) ?? [normalized];
  const chunks = [];
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value.length > 0) chunks.push(value);
    current = "";
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (sentence.length > maxChars) {
      flush();
      for (const piece of hardWrap(sentence, maxChars)) chunks.push(piece);
      continue;
    }
    const nextLength = (current.length === 0 ? 0 : current.length + 1) + sentence.length;
    if (nextLength > maxChars) flush();
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
  }
  flush();
  return chunks.length > 0 ? chunks : [normalized];
}

/**
 * Hard-wrap one oversized sentence by words.
 * @param {string} sentence - input.
 * @param {number} maxChars - budget.
 * @returns {string[]} pieces.
 */
function hardWrap(sentence, maxChars) {
  const pieces = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (word.length > maxChars) {
      if (current.length > 0) {
        pieces.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += maxChars) {
        pieces.push(word.slice(index, index + maxChars));
      }
      continue;
    }
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > maxChars) {
      pieces.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/**
 * Keep the first sentences under a budget and say the rest was omitted.
 * @param {string} text - speech text.
 * @param {number} maxChars - budget.
 * @returns {string} truncated text.
 */
function truncateAtSentence(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("\n\n"),
  );
  const body = cut > maxChars * 0.5 ? slice.slice(0, cut + 1) : slice;
  return `${body.trim()}\n\nThe rest of the response was omitted from this audio.`;
}

/**
 * Run async work with a fixed concurrency limit.
 * @template T, R
 * @param {T[]} items - work items.
 * @param {number} limit - max parallel calls.
 * @param {(item: T, index: number) => Promise<R>} worker - worker.
 * @returns {Promise<R[]>} results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Expand the supported `~` prefixes. */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Return a non-empty trimmed string or a fallback. */
/** YYYY-MM-DD subdirectory. */
function dayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derive the per-workspace folder.
 *
 * The display name comes from the workspace basename; a short hash of the
 * absolute path keeps two workspaces with the same name separate. Sessions
 * without a recorded cwd get an explicit `_unknown-workspace` bucket.
 *
 * @param {string|undefined} cwd - session header cwd.
 * @param {boolean} groupByWorkspace - whether to group at all.
 * @returns {{key: string, path: string|null, dirParts: string[]}}
 */
function workspaceInfo(cwd, groupByWorkspace) {
  const path = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : "";
  if (!groupByWorkspace) {
    return { key: "all", path: path.length > 0 ? path : null, dirParts: [] };
  }
  if (path.length === 0) {
    return { key: "unknown", path: null, dirParts: ["_unknown-workspace"] };
  }
  const name = sanitizeWorkspaceName(basename(path)) || "workspace";
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 8);
  const key = `${name}-${hash}`;
  return { key, path, dirParts: [key] };
}

/** Keep a workspace folder readable and portable. */
function sanitizeWorkspaceName(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Filesystem-safe, sortable file stem. */
function baseName(sessionId, turn) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const id = String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  return `${stamp}_${id}_t${turn}`;
}

/**
 * Resolve the newest saved MP3 for one Session turn from the output index.
 *
 * The index is append-only and may contain failures, so scan newest-first and
 * return only a done record whose audio path stays under `outputDir`.
 *
 * @param {string} outputDir - narration root.
 * @param {string} sessionId - Session id from the chat slot.
 * @param {number} turn - turn number.
 * @returns {Promise<{path: string, size: number}|undefined>}
 */
async function findAudio(outputDir, sessionId, turn) {
  let text;
  try {
    text = await readFile(join(outputDir, "index.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const root = `${resolve(outputDir)}${sep}`;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.status !== "done") continue;
    if (row.sessionId !== sessionId) continue;
    if (Number(row.turn) !== turn) continue;
    if (typeof row.audio !== "string") continue;
    const candidate = resolve(outputDir, row.audio);
    if (!candidate.startsWith(root)) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > 0) return { path: candidate, size: info.size };
    } catch {
      // Keep scanning: a later successful record may exist.
    }
  }
  return undefined;
}

/**
 * Resolve the UI state for one turn: ready, queued/processing, error, or
 * missing. In-memory job state covers the current queue; the append-only index
 * covers completed and failed historical turns.
 * @param {string} outputDir - narration root.
 * @param {string} sessionId - Session id.
 * @param {number} turn - turn number.
 * @param {Map<string, {status: string}>} jobs - live job states.
 * @returns {Promise<{state: string, bytes?: number, error?: string}>}
 */
async function findStatus(outputDir, sessionId, turn, jobs) {
  const audio = await findAudio(outputDir, sessionId, turn);
  if (audio !== undefined) return { state: "ready", bytes: audio.size };

  const job = jobs?.get(`${sessionId}:${turn}`);
  if (job !== undefined) {
    return { state: job.status === "processing" ? "processing" : "queued" };
  }

  let text;
  try {
    text = await readFile(join(outputDir, "index.jsonl"), "utf8");
  } catch {
    return { state: "missing" };
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.sessionId !== sessionId || Number(row.turn) !== turn) continue;
    if (row.status === "error") {
      return { state: "error", error: String(row.error ?? "narration failed") };
    }
    break;
  }
  return { state: "missing" };
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import("node:http").IncomingMessage} req - request.
 * @param {number} limit - maximum body bytes.
 * @returns {Promise<unknown>} parsed JSON.
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Hand an audio file to the platform's default handler and wait for the
 * launcher to exit. A non-zero exit is a real "no opener" result; a long-lived
 * configured command is intentionally rejected by the timeout.
 *
 * @param {string} filePath - absolute MP3 path.
 * @param {object} cfg - normalized plugin config.
 * @returns {Promise<void>}
 */
async function openWithSystemApp(filePath, cfg) {
  const configured = typeof cfg.openCommand === "string" ? cfg.openCommand.trim() : "";
  const command = configured.length > 0
    ? configured
    : process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = configured.length > 0
    ? [filePath]
    : process.platform === "win32"
      ? ["/c", "start", "", filePath]
      : [filePath];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(new Error("native opener did not exit"));
    }, 5000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`native opener exited with ${code ?? signal}`));
    });
  });
}

const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";

/** Run `busctl --user` and return stdout, or undefined on any failure. */
async function busctl(args) {
  try {
    const { stdout } = await execFileAsync("busctl", ["--user", ...args], {
      timeout: 2500,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** List MPRIS bus names currently on the session bus. */
async function listMprisPlayers() {
  const out = await busctl(["list", "--no-pager", "--no-legend"]);
  if (out === undefined) return [];
  return out.split("\n")
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter((name) => name !== undefined && name.startsWith(MPRIS_PREFIX));
}

/** Decode one GVariant string body. */
function decodeMprisString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

/** Read a `s "value"` busctl property response. */
function parseMprisString(output) {
  if (typeof output !== "string") return undefined;
  const match = /^s\s+"((?:\\.|[^"\\])*)"\s*$/u.exec(output.trim());
  return match === null ? undefined : decodeMprisString(match[1]);
}

/** Read an `x 123` busctl property response. */
function parseMprisLong(output) {
  if (typeof output !== "string") return undefined;
  const match = /^x\s+(-?\d+)\s*$/u.exec(output.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Extract title, URL, and length from an MPRIS Metadata property. */
function parseMprisMetadata(output) {
  if (typeof output !== "string") return undefined;
  const title = /"xesam:title"\s+s\s+"((?:\\.|[^"\\])*)"/u.exec(output);
  const url = /"xesam:url"\s+s\s+"((?:\\.|[^"\\])*)"/u.exec(output);
  const length = /"mpris:length"\s+x\s+(-?\d+)/u.exec(output);
  if (title === null && url === null && length === null) return undefined;
  return {
    title: title === null ? undefined : decodeMprisString(title[1]),
    url: url === null ? undefined : decodeMprisString(url[1]),
    durationMs: length === null ? undefined : Math.max(0, Math.round(Number(length[1]) / 1000)),
  };
}

/** Read and parse one player's MPRIS metadata. */
async function mprisMetadata(player) {
  return parseMprisMetadata(await busctl([
    "get-property", player, MPRIS_PATH, "org.mpris.MediaPlayer2.Player", "Metadata",
  ]));
}

/** Read one player's PlaybackStatus, or undefined when it is gone. */
async function mprisStatus(player) {
  return parseMprisString(await busctl([
    "get-property", player, MPRIS_PATH, "org.mpris.MediaPlayer2.Player", "PlaybackStatus",
  ]));
}

/** Read one player's position in microseconds. */
async function mprisPosition(player) {
  return parseMprisLong(await busctl([
    "get-property", player, MPRIS_PATH, "org.mpris.MediaPlayer2.Player", "Position",
  ]));
}

/** Invoke one MPRIS method; undefined means the player rejected it. */
async function mprisCall(player, iface, method) {
  const interfaceName = iface === "Root"
    ? "org.mpris.MediaPlayer2"
    : `org.mpris.MediaPlayer2.${iface}`;
  return busctl(["call", player, MPRIS_PATH, interfaceName, method]);
}

/** Best-effort Quit for a player that we just started but cannot match. */
async function quitMprisPlayer(player) {
  await mprisCall(player, "Root", "Quit");
}

/** Find the MPRIS player that currently holds `filePath`. */
async function findMprisForFile(filePath) {
  const base = basename(filePath);
  const bare = base.replace(/\.[^.]+$/u, "");
  for (const player of await listMprisPlayers()) {
    const metadata = await mprisMetadata(player);
    if (metadata === undefined) continue;
    let matches = metadata.title === base || metadata.title === bare;
    if (!matches && typeof metadata.url === "string") {
      try {
        const url = new URL(metadata.url);
        matches = decodeURIComponent(url.pathname) === filePath;
      } catch {
        // A malformed xesam:url is not a match.
      }
    }
    if (matches) return { player, durationMs: metadata.durationMs };
  }
  return undefined;
}

/** Small delay used by native open/close orchestration. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse one RFC 7233 `bytes` range. Multiple ranges are refused.
 * @param {string|undefined} header - Range header value.
 * @param {number} size - file size in bytes.
 * @returns {{start: number, end: number}|null} range, or null for absent/invalid.
 */
function parseByteRange(header, size) {
  if (typeof header !== "string" || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart.length === 0 && rawEnd.length === 0) return null;
  let start;
  let end;
  if (rawStart.length === 0) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start >= size) return null;
    end = rawEnd.length === 0 ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** Does a file exist? */
async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable file size for logs. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bind ctx.logger when available, otherwise use console. */
function makeLogger(ctx) {
  const base = ctx?.logger;
  const emit = (level, message) => {
    const line = `[tts-chat-answer] ${message}`;
    const fn = base && typeof base[level] === "function"
      ? base[level].bind(base)
      : (level === "error" ? console.error : level === "warn" ? console.warn : console.info);
    try { fn(line); } catch { /* logging must never break the turn */ }
  };
  return {
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

/** Internals exposed for offline tests; not part of the plugin contract. */
export const __test = {
  normalizeConfig,
  pickAssistantText,
  prepareSpeech,
  splitForSpeech,
  toSpeechText,
  redactSecrets,
  truncateAtSentence,
  workspaceInfo,
  findAudio,
  findStatus,
  openWithSystemApp,
  parseByteRange,
  parseMprisMetadata,
  parseMprisString,
  parseMprisLong,
  listMprisPlayers,
  findMprisForFile,
};
