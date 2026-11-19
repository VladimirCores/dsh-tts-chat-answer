# dsh-tts-archive

Narrate every completed assistant answer from DeepSeek Harness and save the
audio locally. Each turn becomes:

```
~/.local/share/minke/tts/
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

## Install into a profile

The package is a profile **bundle**. Install it from the checkout:

```bash
dsh plugin --profile web add /absolute/path/to/plugins/dsh-tts-archive
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
        "@local/dsh-tts-archive"
      ]
    }
  }
}
```

Alternatively, insert it directly in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: tts-archive
      name: '@local/dsh-tts-archive'
      config:
        enabled: true
        outputDir: '~/.local/share/minke/tts'
        engine: 'edge'
        voice: 'en-US-AndrewNeural'
        rate: '+10%'
```

Restart the DSH Host once after the first installation. A running profile does
not always hot-add a new module row; restarting is deterministic. After restart,
this file proves the plugin mounted:

```bash
cat ~/.local/share/minke/tts/.ready
```

Remove the bundle from `dsh.profile.bundles` (or set `enabled: false`) to
disable it.

## Interactive setup

`setup.mjs` prompts for the narration settings and writes a managed
`tts-archive` override into a profile's `cordis.patch.yml`:

```bash
node setup.mjs                 # prompt, profile defaults to web
node setup.mjs --profile web   # skip the profile prompt
node setup.mjs --profile web --yes
node setup.mjs --dry-run       # print the generated YAML, write nothing
```

The block is delimited by `# >>> dsh-tts-archive setup >>>` /
`# <<< dsh-tts-archive setup <<<`, so re-running the script updates it in
place instead of appending duplicates. A timestamped backup of the previous
patch file is created before each write. The script does not install the
package; install it first with `dsh plugin add`, then run setup and restart the
Host.

## Requirements

- `edge-tts` for the default engine. It is installed at
  `~/.local/bin/edge-tts` on this machine; the plugin also tries `edge-tts`
  from `PATH`.
- `ffmpeg` when an answer is split into more than one chunk. Without it the
  plugin falls back to a single request.
- `espeak-ng` + `ffmpeg` for the fully local engine.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `outputDir` | `~/.local/share/minke/tts` | Root for audio, transcripts, metadata, index. |
| `groupByWorkspace` | `true` | Put each workspace in `<basename>-<cwd-hash>/`; `false` writes `<date>/` directly. |
| `engine` | `edge` | `edge` (neural, online) or `espeak` (robotic, local). |
| `voice` | `en-US-AndrewNeural` | Edge voice. |
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
| `espeakCommand` / `espeakVoice` / `espeakRate` | `espeak-ng` / `en-us` / `165` | Local engine settings. |

## Privacy

`engine: "edge"` sends the **speech script of every assistant answer** to
Microsoft's Edge TTS service. `redactSecrets` and code-block omission reduce
exposure but are not a guarantee. If responses may contain confidential data,
use `engine: "espeak"` (fully local) or disable the plugin.

## Test

```bash
node plugins/dsh-tts-archive/test/plugin.test.mjs
```

The integration test performs a real Edge TTS synthesis (about 20 seconds).
