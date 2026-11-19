#!/usr/bin/env node
/**
 * Interactive setup for the dsh-tts-archive profile bundle.
 *
 * It does not install the package; it writes a managed `tts-archive` config
 * row into a DSH profile's `cordis.patch.yml`. The row overrides the bundle
 * defaults, so the settings survive plugin updates.
 *
 * Usage:
 *   node setup.mjs
 *   node setup.mjs --profile web
 *   node setup.mjs --profile web --yes
 *   node setup.mjs --dry-run
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "@local/dsh-tts-archive";
const ROOT = dirname(fileURLToPath(import.meta.url));
const MARK_START = "# >>> dsh-tts-archive setup >>>";
const MARK_END = "# <<< dsh-tts-archive setup <<<";

const DEFAULTS = Object.freeze({
  enabled: true,
  outputDir: "~/.local/share/minke/tts",
  groupByWorkspace: true,
  engine: "edge",
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
});

function usage() {
  stdout.write(`Usage: node setup.mjs [options]

Options:
  --profile <name>  DSH profile to configure (default: prompt, then "web")
  --yes             Accept all defaults without prompting
  --dry-run         Print the generated patch block; write nothing
  -h, --help        Show this help

Examples:
  node setup.mjs
  node setup.mjs --profile web
  node setup.mjs --profile web --yes
  node setup.mjs --dry-run
`);
}

function parseArgs(argv) {
  const args = { profile: undefined, yes: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--profile":
        args.profile = argv[++index];
        if (args.profile === undefined) throw new Error("--profile requires a name");
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

class Prompter {
  constructor(rl, yes) {
    this.rl = rl;
    this.yes = yes;
  }

  async text(question, fallback, validate) {
    if (this.yes) {
      assertValid(validate, fallback, question);
      return fallback;
    }
    while (true) {
      const suffix = fallback !== undefined && String(fallback).length > 0 ? ` [${fallback}]` : "";
      const answer = (await this.rl.question(`${question}${suffix}: `)).trim();
      const value = answer.length > 0 ? answer : fallback;
      const problem = validate?.(value);
      if (problem === undefined || problem === null) return value;
      stdout.write(`  ! ${problem}\n`);
    }
  }

  async bool(question, fallback) {
    if (this.yes) return fallback;
    while (true) {
      const hint = fallback ? "Y/n" : "y/N";
      const answer = (await this.rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (answer.length === 0) return fallback;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      stdout.write("  ! enter y or n\n");
    }
  }

  async choice(question, options, fallback) {
    if (this.yes) return fallback;
    while (true) {
      const answer = (await this.rl.question(`${question} (${options.join("/")}) [${fallback}]: `))
        .trim().toLowerCase();
      const value = answer.length > 0 ? answer : fallback;
      if (options.includes(value)) return value;
      stdout.write(`  ! choose one of: ${options.join(", ")}\n`);
    }
  }

  async integer(question, fallback, min, max) {
    return Number(await this.text(question, String(fallback), (value) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) {
        return `enter an integer between ${min} and ${max}`;
      }
      return undefined;
    }));
  }
}

function assertValid(validate, value, question) {
  const problem = validate?.(value);
  if (problem !== undefined && problem !== null) {
    throw new Error(`${question}: ${problem}`);
  }
}

function signedPercent(value, label) {
  const normalized = /^[+-]/.test(String(value)) ? String(value) : `+${String(value)}`;
  if (!/^[+-]\d+%$/.test(normalized)) return `${label} must look like +10% or -5%`;
  return undefined;
}

function signedHz(value) {
  const normalized = /^[+-]/.test(String(value)) ? String(value) : `+${String(value)}`;
  if (!/^[+-]\d+Hz$/.test(normalized)) return "pitch must look like +0Hz or -20Hz";
  return undefined;
}

function normalizeSigned(value) {
  return /^[+-]/.test(String(value)) ? String(value) : `+${String(value)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const rl = args.yes ? undefined : createInterface({ input: stdin, output: stdout });
  if (rl !== undefined) {
    rl.on("SIGINT", () => {
      rl.close();
      stdout.write("\nsetup cancelled.\n");
      process.exitCode = 130;
    });
  }

  try {
    const prompt = new Prompter(rl, args.yes);
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
      ? process.env.DSH_HOME.trim()
      : join(homedir(), ".dsh");

    const profile = args.profile
      ?? await prompt.text("DSH profile", "web", (value) =>
        /^[a-zA-Z0-9._-]+$/.test(value) ? undefined : "use letters, digits, dot, dash or underscore");

    const profileDir = join(dshHome, "profiles", profile);
    const patchPath = join(profileDir, "cordis.patch.yml");
    const profilePackagePath = join(profileDir, "package.json");

    try {
      await access(profileDir);
    } catch {
      const profiles = await listProfiles(dshHome);
      throw new Error(
        `profile "${profile}" does not exist under ${join(dshHome, "profiles")}` +
        (profiles.length > 0 ? `; available: ${profiles.join(", ")}` : ""),
      );
    }

    const selected = await profileHasBundle(profilePackagePath, PLUGIN);
    if (!selected) {
      stdout.write(
        `\nWarning: ${profilePackagePath} does not list ${PLUGIN} in dsh.profile.bundles.\n` +
        `Install it first:\n  dsh plugin --profile ${profile} add ${ROOT}\n\n`,
      );
    }

    stdout.write("\nInteractive settings (press Enter for the default).\n");
    const enabled = await prompt.bool("Enable the TTS archive?", DEFAULTS.enabled);
    const outputDir = await prompt.text(
      "Output directory",
      DEFAULTS.outputDir,
      (value) => value.length > 0 ? undefined : "output directory cannot be empty",
    );
    const groupByWorkspace = await prompt.bool(
      "Group audio by workspace?",
      DEFAULTS.groupByWorkspace,
    );
    const engine = await prompt.choice("TTS engine", ["edge", "espeak"], DEFAULTS.engine);

    let voice = DEFAULTS.voice;
    let rate = DEFAULTS.rate;
    let volume = DEFAULTS.volume;
    let pitch = DEFAULTS.pitch;
    let espeakVoice = DEFAULTS.espeakVoice;
    let espeakRate = DEFAULTS.espeakRate;

    if (engine === "edge") {
      voice = await prompt.text(
        "Edge voice",
        DEFAULTS.voice,
        (value) => value.length > 0 ? undefined : "voice cannot be empty",
      );
      rate = normalizeSigned(await prompt.text("Speech rate", DEFAULTS.rate, (value) => signedPercent(value, "rate")));
    } else {
      espeakVoice = await prompt.text(
        "espeak voice",
        DEFAULTS.espeakVoice,
        (value) => value.length > 0 ? undefined : "voice cannot be empty",
      );
      espeakRate = await prompt.integer("espeak words per minute", DEFAULTS.espeakRate, 80, 450);
    }

    const includeSubagents = await prompt.bool(
      "Narrate subagent answers too?",
      DEFAULTS.includeSubagents,
    );
    const keepTranscript = await prompt.bool(
      "Keep a raw text transcript next to each MP3?",
      DEFAULTS.keepTranscript,
    );
    const advanced = await prompt.bool("Configure advanced options?", false);

    let minChars = DEFAULTS.minChars;
    let maxChars = DEFAULTS.maxChars;
    let chunkChars = DEFAULTS.chunkChars;
    let concurrency = DEFAULTS.concurrency;
    let timeoutMs = DEFAULTS.timeoutMs;
    let maxQueue = DEFAULTS.maxQueue;
    let includeIncomplete = DEFAULTS.includeIncomplete;
    let redactSecrets = DEFAULTS.redactSecrets;

    if (advanced) {
      if (engine === "edge") {
        volume = normalizeSigned(await prompt.text("Volume", DEFAULTS.volume, (value) => signedPercent(value, "volume")));
        pitch = normalizeSigned(await prompt.text("Pitch", DEFAULTS.pitch, (value) => signedHz(value)));
      }
      minChars = await prompt.integer("Minimum speakable characters", DEFAULTS.minChars, 1, 10000);
      maxChars = await prompt.integer("Maximum characters per answer", DEFAULTS.maxChars, 100, 200000);
      chunkChars = await prompt.integer("Characters per TTS request", DEFAULTS.chunkChars, 200, 8000);
      concurrency = await prompt.integer("Parallel TTS requests", DEFAULTS.concurrency, 1, 8);
      timeoutMs = await prompt.integer("Per-process timeout (ms)", DEFAULTS.timeoutMs, 10000, 3600000);
      maxQueue = await prompt.integer("Maximum queued answers", DEFAULTS.maxQueue, 1, 1000);
      includeIncomplete = await prompt.bool(
        "Narrate max-token turns as well as completed turns?",
        DEFAULTS.includeIncomplete,
      );
      redactSecrets = await prompt.bool(
        "Redact obvious secrets before TTS?",
        DEFAULTS.redactSecrets,
      );
    }

    const settings = {
      enabled,
      outputDir,
      groupByWorkspace,
      engine,
      voice,
      fallbackVoice: DEFAULTS.fallbackVoice,
      rate,
      volume,
      pitch,
      minChars,
      maxChars,
      chunkChars,
      concurrency,
      timeoutMs,
      maxQueue,
      includeSubagents,
      includeIncomplete,
      keepTranscript,
      redactSecrets,
      espeakCommand: DEFAULTS.espeakCommand,
      espeakVoice,
      espeakRate,
      ffmpegCommand: DEFAULTS.ffmpegCommand,
      edgeTtsCommand: DEFAULTS.edgeTtsCommand,
    };

    const block = renderBlock(settings);
    if (args.dryRun) {
      stdout.write(`\n--- ${patchPath} (dry run) ---\n${block}\n`);
      return 0;
    }

    const existing = await readText(patchPath, "");
    const updated = replaceManagedBlock(existing, block);
    await mkdir(profileDir, { recursive: true });
    if (existing.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      await copyFile(patchPath, `${patchPath}.bak-setup-${stamp}`);
    }
    await writeFile(patchPath, updated, "utf8");

    stdout.write(`\nWrote ${patchPath}\n`);
    stdout.write(`Profile: ${profile}\n`);
    stdout.write(`Output:  ${settings.outputDir}\n`);
    stdout.write(`Engine:  ${settings.engine}${settings.engine === "edge" ? ` (${settings.voice}, ${settings.rate})` : ` (${settings.espeakVoice}, ${settings.espeakRate} wpm)`}\n`);
    stdout.write("\nRestart Minke/DSH once, then check:\n");
    stdout.write(`  cat ${join(settings.outputDir.replace(/^~(?=$|\/)/, homedir()), ".ready")}\n`);
    return 0;
  } finally {
    rl?.close();
  }
}

function renderBlock(settings) {
  const lines = [
    MARK_START,
    "- id: tts-archive",
    `  name: '${PLUGIN}'`,
    "  config:",
    `    enabled: ${settings.enabled}`,
    `    outputDir: ${yamlString(settings.outputDir)}`,
    `    groupByWorkspace: ${settings.groupByWorkspace}`,
    `    engine: ${yamlString(settings.engine)}`,
    `    voice: ${yamlString(settings.voice)}`,
    `    fallbackVoice: ${yamlString(settings.fallbackVoice)}`,
    `    rate: ${yamlString(settings.rate)}`,
    `    volume: ${yamlString(settings.volume)}`,
    `    pitch: ${yamlString(settings.pitch)}`,
    `    minChars: ${settings.minChars}`,
    `    maxChars: ${settings.maxChars}`,
    `    chunkChars: ${settings.chunkChars}`,
    `    concurrency: ${settings.concurrency}`,
    `    timeoutMs: ${settings.timeoutMs}`,
    `    maxQueue: ${settings.maxQueue}`,
    `    includeSubagents: ${settings.includeSubagents}`,
    `    includeIncomplete: ${settings.includeIncomplete}`,
    `    keepTranscript: ${settings.keepTranscript}`,
    `    redactSecrets: ${settings.redactSecrets}`,
    `    espeakCommand: ${yamlString(settings.espeakCommand)}`,
    `    espeakVoice: ${yamlString(settings.espeakVoice)}`,
    `    espeakRate: ${settings.espeakRate}`,
    `    ffmpegCommand: ${yamlString(settings.ffmpegCommand)}`,
    `    edgeTtsCommand: ${yamlString(settings.edgeTtsCommand)}`,
    MARK_END,
  ];
  return `${lines.join("\n")}\n`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function replaceManagedBlock(text, block) {
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start !== -1 && end > start) {
    return `${text.slice(0, start)}${block}${text.slice(end + MARK_END.length).replace(/^\s*\n?/, "\n")}`;
  }
  const trimmed = text.trimEnd();
  return `${trimmed.length > 0 ? `${trimmed}\n\n` : ""}${block}`;
}

async function readText(path, fallback) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function profileHasBundle(profilePackagePath, packageName) {
  try {
    const manifest = JSON.parse(await readFile(profilePackagePath, "utf8"));
    return manifest?.dsh?.profile?.bundles?.includes(packageName) === true;
  } catch {
    return false;
  }
}

async function listProfiles(dshHome) {
  try {
    return (await readdir(join(dshHome, "profiles"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

main().catch((error) => {
  stdout.write(`\nsetup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
