import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, __test } from "../lib/index.js";

const EDGE_TTS = process.env.EDGE_TTS ?? "/home/cores/.local/bin/edge-tts";
const FFMPEG = process.env.FFMPEG ?? "/usr/bin/ffmpeg";

test("toSpeechText removes code, links, tables, and markdown noise", () => {
  const input = [
    "# Heading",
    "",
    "A paragraph with **bold** and `inline code`.",
    "",
    "```bash",
    "rm -rf /",
    "```",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "See [the docs](https://example.com/secret) and https://example.com/raw.",
  ].join("\n");
  const output = __test.toSpeechText(input);
  assert.match(output, /Heading/);
  assert.match(output, /bold/);
  assert.match(output, /Code block omitted/);
  assert.doesNotMatch(output, /rm -rf/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.doesNotMatch(output, /---/);
  assert.match(output, /the docs/);
});

test("splitForSpeech respects the chunk budget", () => {
  const text = Array.from({ length: 40 }, (_, index) =>
    `Sentence number ${index + 1} explains one detail of the architecture.`
  ).join(" ");
  const chunks = __test.splitForSpeech(text, 240);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 240, `chunk too long: ${chunk.length}`);
  }
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
});

test("pickAssistantText prefers the final text-only answer", () => {
  const session = {
    log: [
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: "text", text: "I will inspect the repository first." },
              { type: "tool-call", id: "call-1", name: "bash", arguments: "{}" },
            ],
          },
        },
      },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          step: 2,
          message: {
            content: [{ type: "text", text: "The final answer is this sentence." }],
          },
        },
      },
    ],
  };
  assert.equal(__test.pickAssistantText(session, 1).text, "The final answer is this sentence.");
});

test("workspace folders are name plus a short path hash", () => {
  const a = __test.workspaceInfo("/home/me/Projects/HPDC", true);
  const b = __test.workspaceInfo("/home/me/Other/HPDC", true);
  assert.match(a.key, /^HPDC-[0-9a-f]{8}$/);
  assert.match(b.key, /^HPDC-[0-9a-f]{8}$/);
  assert.notEqual(a.key, b.key);
  assert.deepEqual(a.dirParts, [a.key]);
  assert.equal(__test.workspaceInfo("/home/me/Projects/HPDC", false).dirParts.length, 0);
  assert.equal(__test.workspaceInfo(undefined, true).key, "unknown");
});

test("parseByteRange accepts closed, open, and suffix ranges", () => {
  assert.deepEqual(__test.parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(__test.parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(__test.parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(__test.parseByteRange("bytes=1000-", 1000), null);
  assert.equal(__test.parseByteRange("bytes=9-3", 1000), null);
  assert.equal(__test.parseByteRange("bytes=0-1,4-5", 1000), null);
  assert.equal(__test.parseByteRange(undefined, 1000), null);
});

test("findAudio resolves the newest matching turn inside the output root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-tts-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audio = join(root, "HPDC-12345678", "2026-11-19", "answer.mp3");
  await mkdir(join(root, "HPDC-12345678", "2026-11-19"), { recursive: true });
  await writeFile(audio, "fake mp3 bytes");
  await writeFile(join(root, "index.jsonl"), `${[
    JSON.stringify({ status: "error", sessionId: "s1", turn: 1, audio: "/missing.mp3" }),
    JSON.stringify({ status: "done", sessionId: "s1", turn: 1, audio }),
    JSON.stringify({ status: "done", sessionId: "s2", turn: 1, audio }),
  ].join("\n")}\n`);

  const found = await __test.findAudio(root, "s1", 1);
  assert.equal(found.path, audio);
  assert.equal(found.size, (await stat(audio)).size);
  assert.equal(await __test.findAudio(root, "s1", 2), undefined);

  await writeFile(join(root, "index.jsonl"), `${JSON.stringify({
    status: "done",
    sessionId: "s1",
    turn: 1,
    audio: "/etc/passwd",
  })}\n`);
  assert.equal(await __test.findAudio(root, "s1", 1), undefined);
});

test("MPRIS parser reads status, position, and metadata", () => {
  assert.equal(__test.parseMprisString('s "Playing"'), "Playing");
  assert.equal(__test.parseMprisLong("x 1174879"), 1174879);
  assert.deepEqual(
    __test.parseMprisMetadata('a{sv} 3 "mpris:trackid" o "/org/mpris/MediaPlayer2/TrackList/NoTrack" "mpris:length" x 66192000 "xesam:title" s "answer.mp3"'),
    { title: "answer.mp3", url: undefined, durationMs: 66192 },
  );
});

test("host route serves, ranges, authenticates, and reports missing audio", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-tts-route-"));
  const audio = join(root, "workspace", "2026-11-19", "answer.mp3");
  await mkdir(join(root, "workspace", "2026-11-19"), { recursive: true });
  const bytes = "fake mp3 bytes";
  await writeFile(audio, bytes);
  await writeFile(join(root, "index.jsonl"), `${JSON.stringify({
    status: "done",
    sessionId: "session-1",
    turn: 1,
    audio,
  })}\n`);

  const routes = new Map();
  const webCtx = {
    effect(factory) {
      factory();
      return () => {};
    },
    webServer: {
      register(candidate) {
        routes.set(candidate.path, candidate);
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
  };
  const ctx = {
    on() {
      return () => {};
    },
    effect(factory) {
      factory();
      return () => {};
    },
    inject(_deps, callback) {
      callback(webCtx);
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
  };

  apply(ctx, { outputDir: root, openCommand: "/bin/true" });
  assert.deepEqual([...routes.keys()].sort(), [
    "/dsh-tts-chat-answer/audio",
    "/dsh-tts-chat-answer/open",
    "/dsh-tts-chat-answer/playback",
    "/dsh-tts-chat-answer/status",
  ]);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes.get(path);
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${String(server.address().port)}`;
  const target = `${origin}/dsh-tts-chat-answer/audio?session=session-1&turn=1`;

  const full = await fetch(target);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await full.arrayBuffer()).toString(), bytes);

  const head = await fetch(target, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));

  const ranged = await fetch(target, { headers: { range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "fake");

  assert.equal((await fetch(`${origin}/dsh-tts-chat-answer/audio?session=session-1&turn=2`)).status, 404);

  const status = await fetch(`${origin}/dsh-tts-chat-answer/status?session=session-1&turn=1`).then((response) => response.json());
  assert.deepEqual(status, { state: "ready", bytes: bytes.length, playMode: "inline" });
  const missing = await fetch(`${origin}/dsh-tts-chat-answer/status?session=session-1&turn=2`).then((response) => response.json());
  assert.equal(missing.state, "missing");

  const opened = await fetch(`${origin}/dsh-tts-chat-answer/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1 }),
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true, mode: "inline" });

  webCtx.connection.requestRejection = () => 401;
  assert.equal((await fetch(target)).status, 401);
  assert.equal((await fetch(`${origin}/dsh-tts-chat-answer/status?session=session-1&turn=1`)).status, 401);
  assert.equal((await fetch(`${origin}/dsh-tts-chat-answer/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1 }),
  })).status, 401);
});

test("native playback matches one MPRIS player and stops it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-tts-native-"));
  const audio = join(root, "workspace", "2026-11-19", "answer.mp3");
  await mkdir(join(root, "workspace", "2026-11-19"), { recursive: true });
  await writeFile(audio, "fake mp3 bytes");
  await writeFile(join(root, "index.jsonl"), `${JSON.stringify({
    status: "done",
    sessionId: "session-1",
    turn: 1,
    audio,
  })}\n`);

  const bin = await mkdtemp(join(tmpdir(), "dsh-tts-busctl-"));
  const log = join(bin, "calls.log");
  await writeFile(join(bin, "busctl"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_MPRIS_LOG, args.join(" ") + "\\n");
const prop = args.at(-1);
if (args.includes("list")) {
  console.log("org.mpris.MediaPlayer2.test 1234 test user :1.1 user@1000.service -");
  process.exit(0);
}
if (args.includes("get-property")) {
  if (prop === "PlaybackStatus") console.log('s "Playing"');
  else if (prop === "Metadata") console.log('a{sv} 3 "mpris:length" x 1000000 "xesam:title" s "answer.mp3"');
  else if (prop === "Position") console.log("x 250000");
  else process.exit(1);
  process.exit(0);
}
if (args.includes("call")) process.exit(0);
process.exit(1);
`, { mode: 0o755 });
  await chmod(join(bin, "busctl"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_MPRIS_LOG = log;
  t.after(async () => {
    process.env.PATH = previousPath;
    delete process.env.FAKE_MPRIS_LOG;
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  const routes = new Map();
  const webCtx = {
    effect(factory) { factory(); return () => {}; },
    webServer: {
      register(candidate) { routes.set(candidate.path, candidate); return () => {}; },
    },
    connection: { requestRejection() { return undefined; } },
  };
  const ctx = {
    on() { return () => {}; },
    effect(factory) { factory(); return () => {}; },
    inject(_deps, callback) { callback(webCtx); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, { outputDir: root, playMode: "native", openCommand: "/bin/true" });

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes.get(path);
    if (route === undefined) { res.statusCode = 404; res.end(); return; }
    void route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${String(server.address().port)}`;

  const opened = await fetch(`${origin}/dsh-tts-chat-answer/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1 }),
  });
  assert.equal(opened.status, 200);
  const body = await opened.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "native");
  assert.equal(body.playback.status, "playing");
  assert.equal(body.playback.positionMs, 250);
  assert.equal(body.playback.durationMs, 1000);

  const status = await fetch(`${origin}/dsh-tts-chat-answer/status?session=session-1&turn=1`).then((r) => r.json());
  assert.equal(status.playMode, "native");
  assert.equal(status.playback.status, "playing");

  const stopped = await fetch(`${origin}/dsh-tts-chat-answer/playback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1, action: "stop" }),
  });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { ok: true });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /Player Stop/);
  assert.match(calls, /MediaPlayer2 Quit/);
});


function mockCtx() {
  const listeners = new Map();
  const cleanups = [];
  return {
    listeners,
    cleanups,
    on(name, listener) {
      const queue = listeners.get(name) ?? [];
      queue.push(listener);
      listeners.set(name, queue);
      return () => {
        const index = queue.indexOf(listener);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    effect(factory) {
      cleanups.push(factory());
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

function emit(ctx, session, event) {
  for (const listener of ctx.listeners.get("session/event") ?? []) {
    listener(session, event);
  }
}

function makeSession({ id = "test-session", parentSession, cwd, answers }) {
  return {
    id,
    header: {
      id,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
    log: answers.map((text, index) => ({
      type: "assistant/message",
      seq: index + 1,
      data: {
        turn: 1,
        step: index + 1,
        message: { content: [{ type: "text", text }] },
      },
    })),
  };
}

async function listFiles(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(root);
  return found;
}

test("integration: completed turn produces audio, transcript, metadata, and index", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-tts-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ctx = mockCtx();
  const plugin = apply(ctx, {
    outputDir: dir,
    engine: "edge",
    edgeTtsCommand: EDGE_TTS,
    ffmpegCommand: FFMPEG,
    voice: "en-US-AriaNeural",
    rate: "+10%",
    chunkChars: 240,
    concurrency: 2,
    minChars: 1,
    timeoutMs: 180000,
  });

  const session = makeSession({
    cwd: "/home/cores/Documents/Projects/Study/HPDC",
    answers: [
      "I will inspect the repository before answering. " +
      "The project is a detailed planning package. " +
      "It has an architecture spine, a product requirements document, " +
      "epics with acceptance criteria, and several review reports. " +
      "However, it does not yet contain the components, clusters, " +
      "bootkit, backend, or tests that those documents describe. " +
      "So the strongest conclusion is that the design is mature " +
      "but the implementation has not started.",
    ],
  });

  emit(ctx, session, {
    type: "turn/end",
    seq: 2,
    data: { turn: 1, reason: { kind: "completed" } },
  });

  await plugin.whenIdle();

  const files = await listFiles(dir);
  const audio = files.find((file) => file.endsWith(".mp3"));
  const transcript = files.find((file) => file.endsWith(".txt"));
  const metadata = files.find((file) => file.endsWith(".json"));
  assert.ok(audio, "expected an MP3");
  assert.ok(transcript, "expected a transcript");
  assert.ok(metadata, "expected metadata");
  assert.match(audio, /[\\/]HPDC-[0-9a-f]{8}[\\/]\d{4}-\d{2}-\d{2}[\\/]/);
  assert.ok((await stat(audio)).size > 1000, "MP3 should not be empty");

  const meta = JSON.parse(await readFile(metadata, "utf8"));
  assert.equal(meta.status, "done");
  assert.equal(meta.sessionId, "test-session");
  assert.equal(meta.turn, 1);
  assert.equal(meta.workspace.path, "/home/cores/Documents/Projects/Study/HPDC");
  assert.match(meta.workspace.key, /^HPDC-[0-9a-f]{8}$/);
  assert.ok(meta.chunks >= 2, `expected chunked synthesis, got ${meta.chunks}`);
  assert.match(await readFile(transcript, "utf8"), /planning package/);

  const index = await readFile(join(dir, "index.jsonl"), "utf8");
  assert.match(index, /"status":"done"/);
  assert.match(index, /"workspace":/);
});

test("dedupe: the same session/turn is only narrated once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-tts-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ctx = mockCtx();
  const plugin = apply(ctx, {
    outputDir: dir,
    engine: "edge",
    edgeTtsCommand: EDGE_TTS,
    ffmpegCommand: FFMPEG,
    voice: "en-US-AriaNeural",
    rate: "+10%",
    chunkChars: 1200,
    concurrency: 1,
    minChars: 1,
    timeoutMs: 180000,
  });

  const session = makeSession({ answers: ["This is a short answer that should only be narrated once."] });
  const end = { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } };
  emit(ctx, session, end);
  emit(ctx, session, end);
  await plugin.whenIdle();

  const files = await listFiles(dir);
  assert.equal(files.filter((file) => file.endsWith(".mp3")).length, 1);
});

test("subagent turns are skipped unless explicitly enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-tts-test-"));
  try {
    const ctx = mockCtx();
    const plugin = apply(ctx, {
      outputDir: dir,
      engine: "edge",
      edgeTtsCommand: EDGE_TTS,
      ffmpegCommand: FFMPEG,
      voice: "en-US-AriaNeural",
      rate: "+10%",
      chunkChars: 1200,
      minChars: 1,
      includeSubagents: false,
      timeoutMs: 60000,
    });

    const session = makeSession({
      parentSession: "parent-session",
      answers: ["This subagent answer must not produce audio."],
    });
    emit(ctx, session, {
      type: "turn/end",
      seq: 2,
      data: { turn: 1, reason: { kind: "completed" } },
    });
    await plugin.whenIdle();

    assert.equal((await listFiles(dir)).filter((file) => file.endsWith(".mp3")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client bundle registers the turn-tail Play control", async () => {
  const reactMock = {
    createElement() {},
    useCallback: (callback) => callback,
    useState: () => [null, () => {}],
    useSyncExternalStore: () => false,
  };
  const previousWindow = globalThis.window;
  let exported;
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(registration) {
          exported = registration.factory((specifier) => {
            if (specifier === "react") return reactMock;
            throw new Error(`unexpected client module: ${specifier}`);
          });
        },
      },
    };
    await import("../lib/client.js");
  } finally {
    globalThis.window = previousWindow;
  }

  assert.ok(exported, "client bundle did not register a module");
  assert.deepEqual(exported.inject, ["slots"]);

  const registrations = [];
  exported.apply({
    slots: {
      inject(name, callback) {
        registrations.push({ name, registration: callback() });
      },
      register(options, component) {
        return { options, component };
      },
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "conversation.chat.turnTail");
  assert.equal(registrations[0].registration.options.id, "tts-chat-answer");
  assert.equal(registrations[0].registration.options.name, "conversation.chat.turnTail");
  assert.equal(typeof registrations[0].registration.component, "function");
});

test("client inline player shares one audio element and resets on stop", async () => {
  class FakeAudio {
    constructor() {
      this.listeners = new Map();
      this.attrs = {};
      this.currentTime = 0;
      this.duration = 12;
      this.paused = true;
    }
    addEventListener(type, listener) {
      const queue = this.listeners.get(type) ?? [];
      queue.push(listener);
      this.listeners.set(type, queue);
    }
    removeAttribute(name) { delete this.attrs[name]; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    set src(value) { this.attrs.src = value; this.emit("loadedmetadata"); }
    get src() { return this.attrs.src; }
    load() {}
    play() {
      this.paused = false;
      this.emit("play");
      this.emit("playing");
      return Promise.resolve();
    }
    pause() {
      if (!this.paused) {
        this.paused = true;
        this.emit("pause");
      }
    }
    emit(type) {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  }

  const previousWindow = globalThis.window;
  const previousAudio = globalThis.Audio;
  let exported;
  try {
    globalThis.Audio = FakeAudio;
    globalThis.window = {
      __ModuleLoader__: {
        load(registration) {
          exported = registration.factory((specifier) => {
            if (specifier === "react") {
              return {
                createElement() {},
                useCallback: (callback) => callback,
                useState: () => [null, () => {}],
                useEffect() {},
                useSyncExternalStore: () => false,
              };
            }
            throw new Error(`unexpected client module: ${specifier}`);
          });
        },
      },
    };
    await import("../lib/client.js?inline-player=1");
  } finally {
    globalThis.window = previousWindow;
  }

  globalThis.Audio = FakeAudio;
  try {
    assert.ok(exported?.__test, "inline player test API missing");
    const api = exported.__test;
    api.inlinePlay("s1:1", "/audio?1");
    assert.equal(api.getInlineSnapshot().key, "s1:1");
    assert.equal(api.getInlineSnapshot().state, "playing");
    const audio = api.ensureInlineAudio();
    audio.currentTime = 2;
    audio.emit("timeupdate");
    assert.equal(api.getInlineSnapshot().positionMs, 2000);
    api.inlinePause();
    assert.equal(api.getInlineSnapshot().state, "paused");
    api.inlinePlay("s1:1", "/audio?1");
    assert.equal(api.getInlineSnapshot().state, "playing");
    api.inlinePlay("s1:2", "/audio?2");
    assert.equal(api.getInlineSnapshot().key, "s1:2");
    audio.currentTime = 12;
    audio.emit("ended");
    assert.equal(api.getInlineSnapshot().state, "idle");
    assert.equal(api.getInlineSnapshot().key, null);
    api.inlinePlay("s1:2", "/audio?2");
    api.inlineStop();
    assert.equal(api.getInlineSnapshot().state, "idle");
  } finally {
    globalThis.Audio = previousAudio;
  }
});
