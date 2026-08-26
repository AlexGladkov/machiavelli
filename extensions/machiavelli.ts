/**
 * Machiavelli extension for pi / OpenCode coding-agent.
 *
 * Registers slash commands that shell out to the Machiavelli core CLI and
 * render the unified envelope {ok, cmd, data, error, meta} back to the user.
 *
 * Binary resolution order:
 *   1. `machiavelli` on PATH  (brew-installed global binary)
 *   2. `node <extRoot>/../core/machiavelli.cjs`  (sibling dev checkout)
 *   3. Hard error with actionable message
 *
 * Consent handling:
 *   Commands that call an external LLM (advice, daily, profile) require the
 *   user to acknowledge that personal data is forwarded to an external API.
 *   Consent is stored in ~/.pi/agent/machiavelli-settings.json.
 */

import { execFile as _execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MachSettings {
  consentGiven: boolean;
}

interface Envelope {
  ok: boolean;
  cmd: string;
  data: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
  meta: Record<string, unknown>;
}

interface AdviceData {
  advice?: string | null;
  text?: string | null;
  prompt?: string;
}

interface ProfileResult {
  lens: string;
  body?: string;
  cached?: boolean;
  error?: string;
}

interface ProfileData {
  results?: ProfileResult[];
}

interface FactData {
  created?: boolean;
  factId?: string;
  subject?: string;
  duplicateOf?: string;
}

interface PersonData {
  id?: string;
  code?: string;
  name?: string;
}

interface StatusData {
  node?: string;
  sqlite?: string;
  dbPath?: string;
  dbExists?: boolean;
  persons?: number;
  facts?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Settings persistence (safe concurrent writes via withFileMutationQueue)
// ---------------------------------------------------------------------------

const SETTINGS_PATH = join(getAgentDir(), "machiavelli-settings.json");

function loadSettings(): MachSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf8");
      return JSON.parse(raw) as MachSettings;
    }
  } catch {
    // Malformed file — treat as fresh.
  }
  return { consentGiven: false };
}

async function saveSettings(settings: MachSettings): Promise<void> {
  await withFileMutationQueue(SETTINGS_PATH, async () => {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  });
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

// ESM-compatible __dirname equivalent
const _extDir = dirname(fileURLToPath(import.meta.url));

function resolveBinary(): { bin: string; args: string[] } {
  // 1. PATH (brew or global install) — synchronous path scan, no subprocess.
  const pathEnv = process.env.PATH ?? "";
  const foundOnPath = pathEnv.split(":").some((dir) => {
    try {
      return existsSync(join(dir, "machiavelli"));
    } catch {
      return false;
    }
  });
  if (foundOnPath) {
    return { bin: "machiavelli", args: [] };
  }

  // 2. Sibling core/ directory (dev checkout)
  const coreCjs = join(_extDir, "..", "core", "machiavelli.cjs");
  if (existsSync(coreCjs)) {
    return { bin: process.execPath, args: [coreCjs] };
  }

  throw new Error(
    "Machiavelli core not found.\n" +
      "Install options:\n" +
      "  brew install machiavelli            (homebrew binary on PATH)\n" +
      "  git clone and keep core/ adjacent   (dev mode)\n" +
      "See: https://github.com/AlexGladkov/machiavelli",
  );
}

// Resolved lazily and cached for the extension lifetime.
let _resolvedBin: { bin: string; args: string[] } | null = null;

function getBin(): { bin: string; args: string[] } {
  if (!_resolvedBin) {
    _resolvedBin = resolveBinary();
  }
  return _resolvedBin;
}

// ---------------------------------------------------------------------------
// Core CLI invocation
// ---------------------------------------------------------------------------

async function runCore(
  subcommand: string,
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<Envelope> {
  const { bin, args: prefixArgs } = getBin();

  // Build argv: [prefixArgs..., subcommand, ...positionals, ...flags]
  const argv: string[] = [
    ...prefixArgs,
    subcommand,
    ...positionals,
    "--json",
  ];

  for (const [key, val] of Object.entries(flags)) {
    if (val === true) {
      argv.push(`--${key}`);
    } else if (val !== false && val !== "") {
      argv.push(`--${key}`, String(val));
    }
  }

  // execFile with array args = no shell injection, no shell:true
  const { stdout } = await execFile(bin, argv, {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  return JSON.parse(stdout.trim()) as Envelope;
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

async function ensureConsent(ctx: ExtensionCommandContext): Promise<boolean> {
  const settings = loadSettings();
  if (settings.consentGiven) return true;

  const confirmed = await ctx.ui.confirm(
    "Machiavelli — privacy consent",
    [
      "This command forwards personal data (facts, relations, pseudonyms)",
      "to an external LLM API (OpenAI/Anthropic/etc.).",
      "",
      "By continuing you acknowledge that you have the right to process",
      "this data and accept the provider's privacy policy.",
      "",
      "Grant consent? (stored in ~/.pi/agent/machiavelli-settings.json)",
    ].join("\n"),
  );

  if (!confirmed) {
    ctx.ui.notify("Consent required for LLM commands. No data was sent.", "warning");
    return false;
  }

  settings.consentGiven = true;
  await saveSettings(settings);
  return true;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderAdvice(envelope: Envelope, daily: boolean): string {
  if (!envelope.ok) {
    const err = envelope.error;
    if (err?.code === "GUARD_UNAVAILABLE") {
      return [
        "## Machiavelli — advice blocked",
        "",
        `**Reason:** ${err.message}`,
        "",
        "The guard prevented generating advice for this query.",
      ].join("\n");
    }
    return `**Error** [${err?.code ?? "UNKNOWN"}]: ${err?.message ?? "Unknown error"}`;
  }

  const data = envelope.data as AdviceData | null;
  const text = data?.advice ?? data?.text ?? "";

  const sections = text
    .split(/\n(?=#{1,3}\s|##+\s|\d+\.\s|\*\*[A-Z])/m)
    .filter((s) => s.trim().length > 0);

  const title = daily ? "## Daily digest" : "## Strategic advice";

  const lines: string[] = [title, ""];

  if (sections.length >= 2) {
    // Already structured — pass through
    lines.push(text);
  } else {
    // Flat text — render as-is
    lines.push(text);
  }

  const meta = envelope.meta;
  if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
    const guardStatus =
      "guard" in meta
        ? String((meta as Record<string, unknown>).guard)
        : null;
    if (guardStatus) {
      lines.push("", `---`, `*Guard: ${guardStatus}*`);
    }
  }

  return lines.join("\n");
}

function renderProfile(envelope: Envelope): string {
  if (!envelope.ok) {
    const err = envelope.error;
    return `**Profile error** [${err?.code ?? "UNKNOWN"}]: ${err?.message ?? "Unknown error"}`;
  }

  const data = envelope.data as ProfileData | null;
  const results = data?.results ?? [];

  if (results.length === 0) {
    return "No profile results returned.";
  }

  const lines: string[] = ["## Psychological profile", ""];

  for (const r of results) {
    lines.push(`### Lens: ${r.lens}${r.cached ? " *(cached)*" : ""}`);
    lines.push("");
    if (r.error) {
      lines.push(`*Error: ${r.error}*`);
    } else {
      lines.push(r.body ?? "*(no content)*");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function renderFact(envelope: Envelope): string {
  if (!envelope.ok) {
    const err = envelope.error;
    return `**Fact error** [${err?.code ?? "UNKNOWN"}]: ${err?.message ?? "Unknown error"}`;
  }
  const data = envelope.data as FactData | null;
  if (!data) return "No data returned.";

  if (!data.created) {
    return `Duplicate fact — already recorded as \`${data.duplicateOf}\`.`;
  }
  return `Fact recorded: \`${data.factId}\` for subject **${data.subject}**.`;
}

function renderPerson(envelope: Envelope): string {
  if (!envelope.ok) {
    const err = envelope.error;
    return `**Person error** [${err?.code ?? "UNKNOWN"}]: ${err?.message ?? "Unknown error"}`;
  }
  const data = envelope.data as PersonData | null;
  if (!data) return "No data returned.";
  return `Person created: **${data.name}** (code: \`${data.code ?? data.id}\`)`;
}

function renderStatus(envelope: Envelope): string {
  if (!envelope.ok) {
    const err = envelope.error;
    return `**Status error** [${err?.code ?? "UNKNOWN"}]: ${err?.message ?? "Unknown error"}`;
  }
  const data = (envelope.data ?? {}) as StatusData;

  const lines: string[] = ["## Machiavelli status", ""];

  for (const [key, val] of Object.entries(data)) {
    lines.push(`- **${key}**: ${JSON.stringify(val)}`);
  }

  return lines.join("\n");
}

function notifyEnvelope(ctx: ExtensionCommandContext, envelope: Envelope): void {
  if (!envelope.ok) {
    ctx.ui.notify(
      `[machiavelli] Error: ${envelope.error?.message ?? "unknown"}`,
      "error",
    );
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function machiavelliExtension(pi: ExtensionAPI): void {
  // ----- /mach-advice <query> -----------------------------------------------
  pi.registerCommand("mach-advice", {
    description: "Get strategic advice from Machiavelli (requires LLM consent)",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /mach-advice <your strategic question>", "warning");
        return;
      }

      if (!(await ensureConsent(ctx))) return;

      ctx.ui.notify("Consulting Machiavelli...", "info");

      let envelope: Envelope;
      try {
        envelope = await runCore("advice", [query], { consent: true });
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.setEditorText(renderAdvice(envelope, false));
    },
  });

  // ----- /mach-daily ----------------------------------------------------------
  pi.registerCommand("mach-daily", {
    description: "Get daily strategic digest from Machiavelli (requires LLM consent)",
    handler: async (_args, ctx) => {
      if (!(await ensureConsent(ctx))) return;

      ctx.ui.notify("Generating daily digest...", "info");

      let envelope: Envelope;
      try {
        envelope = await runCore("daily", [], { consent: true });
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.setEditorText(renderAdvice(envelope, true));
    },
  });

  // ----- /mach-fact <person> <text> ------------------------------------------
  pi.registerCommand("mach-fact", {
    description: "Record an immutable fact about a person: /mach-fact <person> <fact text>",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      // Split: first token = personRef, rest = fact body
      const parts = args.trim().split(/\s+/);
      const personRef = parts[0];
      const body = parts.slice(1).join(" ").trim();

      if (!personRef || !body) {
        ctx.ui.notify(
          "Usage: /mach-fact <person-ref-or-code> <fact text>",
          "warning",
        );
        return;
      }

      let envelope: Envelope;
      try {
        envelope = await runCore("fact", [personRef, body], {});
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.notify(renderFact(envelope), envelope.ok ? "info" : "error");
    },
  });

  // ----- /mach-person <description> ------------------------------------------
  pi.registerCommand("mach-person", {
    description: "Add a person to the Machiavelli store: /mach-person <name or description>",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const desc = args.trim();
      if (!desc) {
        ctx.ui.notify("Usage: /mach-person <name or description>", "warning");
        return;
      }

      let envelope: Envelope;
      try {
        envelope = await runCore("person", [desc], {});
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.notify(renderPerson(envelope), envelope.ok ? "info" : "error");
    },
  });

  // ----- /mach-profile <person> [lens] ----------------------------------------
  pi.registerCommand("mach-profile", {
    description:
      "Generate a psycho-profile for a person: /mach-profile <person> [lens,lens2]",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const personRef = parts[0];
      const lens = parts[1] ?? "";

      if (!personRef) {
        ctx.ui.notify(
          "Usage: /mach-profile <person-ref-or-code> [disc|bigfive|leverage]",
          "warning",
        );
        return;
      }

      if (!(await ensureConsent(ctx))) return;

      ctx.ui.notify(`Generating profile for ${personRef}...`, "info");

      const flags: Record<string, string | boolean> = { consent: true };
      if (lens) flags["lens"] = lens;

      let envelope: Envelope;
      try {
        envelope = await runCore("profile", [personRef], flags);
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.setEditorText(renderProfile(envelope));
    },
  });

  // ----- /mach-status ---------------------------------------------------------
  pi.registerCommand("mach-status", {
    description: "Show Machiavelli runtime status",
    handler: async (_args, ctx) => {
      let envelope: Envelope;
      try {
        envelope = await runCore("status", [], {});
      } catch (err) {
        ctx.ui.notify(`Machiavelli core error: ${String(err)}`, "error");
        return;
      }

      notifyEnvelope(ctx, envelope);
      ctx.ui.setEditorText(renderStatus(envelope));
    },
  });
}
