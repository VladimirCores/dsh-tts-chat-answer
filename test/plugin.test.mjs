import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    "/dsh-tts-archive/audio",
    "/dsh-tts-archive/open",
    "/dsh-tts-archive/status",
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
  const target = `${origin}/dsh-tts-archive/audio?session=session-1&turn=1`;

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

  assert.equal((await fetch(`${origin}/dsh-tts-archive/audio?session=session-1&turn=2`)).status, 404);

  const status = await fetch(`${origin}/dsh-tts-archive/status?session=session-1&turn=1`).then((response) => response.json());
  assert.deepEqual(status, { state: "ready", bytes: bytes.length });
  const missing = await fetch(`${origin}/dsh-tts-archive/status?session=session-1&turn=2`).then((response) => response.json());
  assert.equal(missing.state, "missing");

  const opened = await fetch(`${origin}/dsh-tts-archive/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1 }),
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true });

  webCtx.connection.requestRejection = () => 401;
  assert.equal((await fetch(target)).status, 401);
  assert.equal((await fetch(`${origin}/dsh-tts-archive/status?session=session-1&turn=1`)).status, 401);
  assert.equal((await fetch(`${origin}/dsh-tts-archive/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "session-1", turn: 1 }),
  })).status, 401);
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
    voice: "en-US-AndrewNeural",
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
    voice: "en-US-AndrewNeural",
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
      voice: "en-US-AndrewNeural",
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
  assert.equal(registrations[0].registration.options.id, "tts-archive");
  assert.equal(registrations[0].registration.options.name, "conversation.chat.turnTail");
  assert.equal(typeof registrations[0].registration.component, "function");
});
