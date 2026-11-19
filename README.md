# dsh-tts-chat-answer

Narrate every completed assistant answer from DeepSeek Harness and save the
audio locally. Each turn becomes:

```
~/.local/share/dsh-tts-chat-answer/
├── .ready                          # written when the plugin mounts
├── index.jsonl                     # global one-line-per-job index (includes workspace)
└── HPDC-7c1e9a02/                  # workspace basename + short cwd hash
    └── 2026-11-19/
        ├── 2026-11-19_14-05-33_<session>_t3.mp3
        ├── 2026-11-19_14-05-33_<session>_t3.txt   # transcript of the answer
        └── 2026-11-19_14-05-33_<session>_t3.json  # metadata
```

Each workspace gets its own folder, derived from the session's recorded
`cwd` (`basename` plus an 8-character SHA-1 prefix of the absolute path). Two
different projects named `HPDC` therefore do not collide. Sessions without a
recorded workspace land in `_unknown-workspace/`. Set
`groupByWorkspace: false` to write a flat `<date>/` tree instead.

The MP3 contains the final text-only assistant message of the turn. Markdown,
tables, links and code fences are converted to spoken prose; code blocks are
replaced with “Code block omitted” rather than read aloud. Intermediate
tool-call preambles are skipped.

## Playback

Each completed turn gets a small control in the completed-turn footer, next to
the message actions. It checks the authenticated readiness route:

```text
GET /dsh-tts-chat-answer/status?session=<session-id>&turn=<turn>
```

While the MP3 is being generated it shows `Generating…`; once ready it shows
`Play`. The host reports `playMode` in the same response.

`playMode: "inline"` (the default) plays in the Web UI through one shared
`HTMLAudioElement`. The control becomes `Pause` while playing and `Resume`
while paused; a `Stop` button resets it. Pressing Play on another answer stops
the current one, so only one answer ever plays. No external application is
opened.

`playMode: "native"` asks the Host to hand the MP3 to the platform's default
audio application (`xdg-open` on Linux, `open` on macOS, `start` on Windows)
and reports state through MPRIS:

```text
POST /dsh-tts-chat-answer/open
{"session":"<session-id>","turn":<turn>}

POST /dsh-tts-chat-answer/playback
{"session":"<session-id>","turn":<turn>,"action":"play|pause|stop"}
```

On Linux the Host matches the player by `xesam:title` / `xesam:url`, then uses
the standard MPRIS `Play`, `Pause`, `Stop`, and `Quit` methods. The UI follows
`PlaybackStatus`; pressing `Stop`, reaching the end, or starting another answer
stops and closes the player. Only one native player opened by this plugin is
tracked at a time. If no controllable MPRIS player appears, the client falls
back to the in-page player for that turn.

MPRIS control is Linux-only. On macOS and Windows native mode still opens the
default app, but cannot reflect or close it from the chat; choose `inline`
there. Both playback modes use the same browser auth as the rest of the Web app;
the audio files are not public static directories. Set `openCommand` if the
platform opener is not on `PATH` or needs a custom command.

This package has a Web client half (`lib/client.js`, declared under
`dsh.client`). Restart Minke/DSH after installing or updating it so the client
boot manifest includes the bundle; client-plugin HMR only applies while
`pnpm run dev:web` is running.

## Voice choices

The interactive setup shows a numbered voice menu. The built-in choices are:

| Voice | Accent / tone |
|---|---|
| `en-US-AriaNeural` | US English, female, warm (default) |
| `en-US-JennyNeural` | US English, female, friendly |
| `en-US-GuyNeural` | US English, male, calm |
| `en-US-DavisNeural` | US English, male, deep |
| `en-GB-SoniaNeural` | British English, female |
| `en-GB-RyanNeural` | British English, male |
| `en-AU-NatashaNeural` | Australian English, female |
| `en-CA-ClaraNeural` | Canadian English, female |
| `en-IN-NeerjaNeural` | Indian English, female |
| `de-DE-KatjaNeural` | German, female |
| `fr-FR-DeniseNeural` | French, female |
| `es-ES-ElviraNeural` | Spanish, female |

Choose the last menu row to enter any other Edge voice id. The setup derives
`fallbackVoice` from the primary voice (Aria and Guy swap); the advanced
section lets you override it. The fallback is only used when Edge returns no
audio for the primary voice.

## Install into a profile

The package is a profile **bundle**. Install it from the checkout:

```bash
dsh plugin --profile web add /absolute/path/to/plugins/dsh-tts-chat-answer
```

`dsh plugin add` installs the dependency and normally selects the bundle in
`~/.dsh/profiles/web/package.json`. If it is installed but not selected, add it
to `dsh.profile.bundles`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-tts-chat-answer"
      ]
    }
  }
}
```

Alternatively, insert it directly in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: tts-chat-answer
      name: 'dsh-tts-chat-answer'
      config:
        enabled: true
        outputDir: '~/.local/share/dsh-tts-chat-answer'
        engine: 'edge'
        playMode: 'inline'
        voice: 'en-US-AriaNeural'
        rate: '+10%'
```

Restart the DSH Host once after the first installation. A running profile does
not always hot-add a new module row; restarting is deterministic. After restart,
this file proves the plugin mounted:

```bash
cat ~/.local/share/dsh-tts-chat-answer/.ready
```

Remove the bundle from `dsh.profile.bundles` (or set `enabled: false`) to
disable it.

## Interactive setup

`setup.mjs` prompts for the narration settings and writes a managed
`tts-chat-answer` override into a profile's `cordis.patch.yml`. The voice
prompt is a numbered selector; pick a listed voice or choose the custom row
to type any Edge voice id. The playback prompt offers `inline` (in-page audio)
or `native` (system app with in-page fallback):

```bash
node setup.mjs                 # prompt, profile defaults to web
node setup.mjs --profile web   # skip the profile prompt
node setup.mjs --profile web --yes
node setup.mjs --dry-run       # print the generated YAML, write nothing
```

The block is delimited by `# >>> dsh-tts-chat-answer setup >>>` /
`# <<< dsh-tts-chat-answer setup <<<`, so re-running the script updates it in
place instead of appending duplicates. A timestamped backup of the previous
patch file is created before each write. The script does not install the
package; install it first with `dsh plugin add`, then run setup and restart the
Host.

## Plugin market

The package declares `dsh.bundle`, an `engines.dsh` range, an icon, an English
locale, and its repository/author metadata, so it can be listed by a DSH plugin
index. Publish the GitHub repository, tag the release (`v0.1.0`), then either
publish to npm or feed the Git URL to the reference index generator:

```bash
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "Chat Answer TTS"
```

Serve `site/index.json` and `site/icons/` over HTTPS and add the index URL under
**Plugins → Discover**. See the
[plugin index guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market).

## Requirements

- `edge-tts` for the default engine. It is installed at
  `~/.local/bin/edge-tts` on this machine; the plugin also tries `edge-tts`
  from `PATH`.
- `ffmpeg` when an answer is split into more than one chunk. Without it the
  plugin falls back to a single request.
- `espeak-ng` + `ffmpeg` for the fully local engine.
- `native` playback on Linux needs `busctl` and an MPRIS-capable audio player
  (GNOME Decibels, VLC, etc.). Without MPRIS the client falls back to the
  in-page player.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | Master switch. The shipped bundle defaults to off; enable it explicitly. |
| `outputDir` | `~/.local/share/dsh-tts-chat-answer` | Root for audio, transcripts, metadata, index. |
| `groupByWorkspace` | `true` | Put each workspace in `<basename>-<cwd-hash>/`; `false` writes `<date>/` directly. |
| `engine` | `edge` | `edge` (neural, online) or `espeak` (robotic, local). |
| `playMode` | `inline` | `inline` (in-page audio, default) or `native` (system app with MPRIS control and in-page fallback). |
| `voice` | `en-US-AriaNeural` | Edge voice; setup offers a numbered menu. |
| `fallbackVoice` | `en-US-GuyNeural` | Retry voice when Edge returns no audio for the primary voice. |
| `rate` / `volume` / `pitch` | `+10%` / `+0%` / `+0Hz` | Edge prosody. |
| `minChars` | `40` | Skip turns with almost no speakable text. |
| `maxChars` | `12000` | Truncate longer answers at a sentence boundary. |
| `chunkChars` | `1200` | Per-request chunk budget; smaller chunks synthesize faster in parallel. |
| `concurrency` | `2` | Parallel Edge TTS requests. |
| `timeoutMs` | `600000` | Per-process deadline. |
| `maxQueue` | `20` | Backpressure guard. |
| `includeSubagents` | `false` | Narrate subagent sessions too. |
| `includeIncomplete` | `false` | Narrate `max-tokens` turns as well as completed turns. |
| `keepTranscript` | `true` | Write the raw answer text next to the audio. |
| `redactSecrets` | `true` | Best-effort removal of API keys, private keys, JWTs, etc. |
| `edgeTtsCommand` | `edge-tts` | Override the executable. |
| `ffmpegCommand` | `ffmpeg` | Override ffmpeg. |
| `openCommand` | auto | Override the system opener used by `POST /dsh-tts-chat-answer/open`; the path is appended as its only argument. |
| `espeakCommand` / `espeakVoice` / `espeakRate` | `espeak-ng` / `en-us` / `165` | Local engine settings. |

## Privacy

The bundle ships disabled so installing it does not immediately send chat
answers anywhere. Enable it explicitly (the setup prompt asks) before use.

`engine: "edge"` sends the **speech script of every assistant answer** to
Microsoft's Edge TTS service. `redactSecrets` and code-block omission reduce
exposure but are not a guarantee. If responses may contain confidential data,
use `engine: "espeak"` (fully local) or disable the plugin.

## Test

```bash
npm install
npm test
```

The integration test performs a real Edge TTS synthesis (about 20 seconds).
