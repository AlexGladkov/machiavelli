# Machiavelli

<p align="center">
  <img src="assets/machiavelli.png" alt="Machiavelli" width="640">
</p>

Portable corporate ontology and strategic advisor. Models the people, relationships, and power dynamics in your organization as an ego-centric knowledge base, then generates advice from your perspective — with an ethical guardrail built in.

## Install

| Channel | Command |
|---------|---------|
| **Claude plugin** | `claude plugin marketplace add AlexGladkov/machiavelli` then `claude plugin install machiavelli@machiavelli` |
| **curl** | `curl -fsSL https://raw.githubusercontent.com/AlexGladkov/machiavelli/main/install.sh \| bash` |
| **brew** | `brew install AlexGladkov/tap/machiavelli` |
| **Codex** | `bash install.sh --host codex` — auto-wires `~/.codex/AGENTS.md` + `hooks.json` |
| **pi / OpenCode** | `pi install git:github.com/AlexGladkov/machiavelli` |

Then set your key: `export MACH_LLM_KEY=sk-ant-...` — or point `MACH_LLM_URL` at any OpenAI-compatible / local model (Ollama, Z.AI, OpenRouter).

## Commands

CLI form below. In Claude Code / pi the same commands are `/mach-init`, `/mach-advice`, … Every command accepts `--json` for machine output.

**Setup**

```bash
machiavelli init --ego-name "You" --company "Acme"    # create your ego-center (run once)
machiavelli person "Артём, CTO, formally my manager"  # add a person + suggested relations
machiavelli status                                    # health: node, driver, keys, counts
machiavelli doctor                                    # + live LLM ping
```

**Record facts** (immutable, append-only — the ground truth)

```bash
machiavelli fact <person> "avoids conflict publicly, fixes position over email"
```

**Profiles** (regenerable interpretations, kept separate from facts)

```bash
machiavelli profile <person> --lens leverage,disc,bigfive   # generate / refresh
machiavelli profile <person> --lens leverage --regen        # force regenerate
machiavelli profile <person> --lens leverage --dry          # show the prompt, no LLM call
```

**Advice** (from your ego perspective, through the ethical guard)

```bash
machiavelli advice "Should I ask for a promotion now?"
machiavelli advice "How do I strengthen my position?" --as <person>  # from someone else's view
machiavelli daily                                                    # digest: who to talk to, what to prep
```

**Graph**

```bash
machiavelli graph                       # all relations (facts + pending suggestions)
machiavelli graph --person <person>     # relations for one person
machiavelli relation list               # list edges
machiavelli relation confirm <edge_id>  # promote a pending LLM-suggested edge to a fact
```

**Keys & maintenance**

```bash
machiavelli key export --kind data              # print the key — back it up
machiavelli key import --kind data --value <hex>
machiavelli rekey --kind data --confirm         # re-encrypt everything with a new key
machiavelli ingest profile <person> --lens leverage --body "<text>"  # store an externally generated profile
machiavelli version
```

Adapters for other hosts: `bash install.sh --host codex|opencode|all`. Remove a wired host: `bash install.sh --host codex --uninstall`.
