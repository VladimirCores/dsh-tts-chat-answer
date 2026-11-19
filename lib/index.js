/**
 * dsh-tts-archive — narrate every completed assistant answer and save it locally.
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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const VERSION = 1;
const PLUGIN = "@local/dsh-tts-archive";

const DEFAULTS = Object.freeze({
  enabled: true,
  outputDir: "~/.local/share/minke/tts",
  groupByWorkspace: true,
  engine: "edge",
  voice: "en-US-AndrewNeural",
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
});

/**
 * Register the TTS archiver.
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
    running: false,
    active: new Set(),
    idleWaiters: [],
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
      for (const child of state.active) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      state.active.clear();
      notifyIdle();
    }, "tts-archive: queue");
  }

  log.info(
    `enabled=${cfg.enabled} engine=${cfg.engine} output=${cfg.outputDir} ` +
    `voice=${cfg.voice} chunkChars=${cfg.chunkChars}`,
  );
  void writeReadyMarker();

  return { whenIdle };

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
    const workspace = workspaceInfo(session?.header?.cwd, cfg.groupByWorkspace);
    const dir = join(cfg.outputDir, ...workspace.dirParts, dayStamp());
    const base = baseName(sessionId, turn);
    const job = {
      key,
      sessionId,
      turn,
      workspaceKey: workspace.key,
      workspacePath: workspace.path,
      eventSeq: event?.seq,
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
    state.queue.push(job);
    log.info(
      `queued ${key} workspace=${workspace.key} ` +
      `(${picked.text.length} chars, ${speech.length} speakable)`,
    );
    void drain();
  }

  /** Process queued jobs one at a time. */
  async function drain() {
    if (state.running) return;
    state.running = true;
    try {
      while (state.queue.length > 0 && !state.disposed) {
        const job = state.queue.shift();
        try {
          await processJob(job);
        } catch (error) {
          await recordFailure(job, error);
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
      voice: cfg.engine === "edge" ? cfg.voice : cfg.espeakVoice,
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
   * @returns {Promise<{chunks: number, bytes: number}>}
   */
  async function synthesize(text, outMp3, work) {
    if (cfg.engine === "espeak") {
      await synthesizeEspeak(text, outMp3, work);
      return { chunks: 1, bytes: (await stat(outMp3)).size };
    }

    const chunks = splitForSpeech(text, cfg.chunkChars);
    if (chunks.length <= 1) {
      const input = join(work, "speech.txt");
      await writeFile(input, text, "utf8");
      await runEdge(input, outMp3);
      return { chunks: 1, bytes: (await stat(outMp3)).size };
    }

    const files = new Array(chunks.length);
    await mapLimit(chunks, cfg.concurrency, async (chunk, index) => {
      const padded = String(index).padStart(3, "0");
      const input = join(work, `chunk-${padded}.txt`);
      const output = join(work, `chunk-${padded}.mp3`);
      await writeFile(input, chunk, "utf8");
      await runEdge(input, output);
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
      await runEdge(input, outMp3);
      return { chunks: 1, bytes: (await stat(outMp3)).size };
    }
    return { chunks: chunks.length, bytes: (await stat(outMp3)).size };
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
   * Run edge-tts for one text file, trying PATH first and the usual
   * `~/.local/bin` install second.
   * @param {string} input - text file path.
   * @param {string} output - MP3 path.
   */
  async function runEdge(input, output) {
    const candidates = [cfg.edgeTtsCommand];
    if (cfg.edgeTtsCommand === "edge-tts") {
      candidates.push(join(homedir(), ".local", "bin", "edge-tts"));
    }
    let lastError;
    for (const command of candidates) {
      try {
        await runProcess(command, [
          "-f", input,
          "-v", cfg.voice,
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
  const value = raw && typeof raw === "object" ? raw : {};
  return Object.freeze({
    enabled: value.enabled !== false,
    outputDir: resolve(expandHome(text(value.outputDir, DEFAULTS.outputDir))),
    groupByWorkspace: value.groupByWorkspace !== false,
    engine: value.engine === "espeak" ? "espeak" : "edge",
    voice: text(value.voice, DEFAULTS.voice),
    rate: text(value.rate, DEFAULTS.rate),
    volume: text(value.volume, DEFAULTS.volume),
    pitch: text(value.pitch, DEFAULTS.pitch),
    minChars: integer(value.minChars, DEFAULTS.minChars, 1, 10000),
    maxChars: integer(value.maxChars, DEFAULTS.maxChars, 100, 200000),
    chunkChars: integer(value.chunkChars, DEFAULTS.chunkChars, 200, 8000),
    concurrency: integer(value.concurrency, DEFAULTS.concurrency, 1, 8),
    timeoutMs: integer(value.timeoutMs, DEFAULTS.timeoutMs, 10000, 3600000),
    maxQueue: integer(value.maxQueue, DEFAULTS.maxQueue, 1, 1000),
    includeSubagents: value.includeSubagents === true,
    includeIncomplete: value.includeIncomplete === true,
    keepTranscript: value.keepTranscript !== false,
    redactSecrets: value.redactSecrets !== false,
    espeakCommand: text(value.espeakCommand, DEFAULTS.espeakCommand),
    espeakVoice: text(value.espeakVoice, DEFAULTS.espeakVoice),
    espeakRate: integer(value.espeakRate, DEFAULTS.espeakRate, 80, 450),
    ffmpegCommand: text(value.ffmpegCommand, DEFAULTS.ffmpegCommand),
    edgeTtsCommand: text(value.edgeTtsCommand, DEFAULTS.edgeTtsCommand),
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
function text(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/** Clamp an integer config value. */
function integer(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

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
    const line = `[tts-archive] ${message}`;
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
};
