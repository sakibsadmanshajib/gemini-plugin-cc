# Installing gemini-plugin-cc

This is a **dual-host plugin** — the same source tree installs into both Claude Code and Codex CLI. Each host has its own plugin manager and its own marketplace descriptor:

| Host | Marketplace descriptor (in this repo) | Personal marketplace location | Plugin manager command |
|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json` | (uses repo's marketplace.json directly) | `/plugin marketplace add` |
| Codex CLI | `.agents/plugins/marketplace.json` (canonical Codex path per official docs) | `~/.agents/plugins/marketplace.json` | `codex plugin marketplace add` + `/plugins` |

Both managers copy `plugins/gemini/` into their respective caches:
- Claude Code → `~/.claude/plugins/cache/<MARKETPLACE>/<PLUGIN>/<VERSION>/`
- Codex CLI → `~/.codex/plugins/cache/<MARKETPLACE>/<PLUGIN>/<VERSION>/`

Plugins install their own skills, commands, hooks, and MCP servers automatically — you do NOT manually symlink anything into `~/.agents/skills/` (that pattern is for standalone skills, not for plugins).

## Prerequisites

- One of: Claude Code (`claude --version`) or Codex CLI (`codex --version`)
- `git`
- `gemini` CLI on `$PATH` — install via `npm install -g @google/gemini-cli`

## Claude Code install

1. **Add this repo's marketplace** to Claude Code:
   ```bash
   /plugin marketplace add file:///path/to/gemini-plugin-cc
   ```
   Or, if you've cloned upstream:
   ```bash
   /plugin marketplace add sakibsadmanshajib/gemini-plugin-cc
   ```

2. **Install the plugin**:
   ```bash
   /plugin install gemini@google-gemini
   ```

3. **Verify**:
   ```bash
   ls ~/.claude/plugins/cache/google-gemini/gemini/
   ```
   You should see a versioned directory (e.g. `1.0.1/`) containing the plugin tree.

4. **Use it**: Claude Code auto-registers the plugin's slash commands as `/gemini:setup`, `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`.

## Codex CLI install

Codex's documented personal-marketplace path is `~/.agents/plugins/marketplace.json` (per the official OpenAI docs at https://developers.openai.com/codex/plugins/build).

1. **Clone the plugin** somewhere stable:
   ```bash
   git clone https://github.com/sakibsadmanshajib/gemini-plugin-cc.git ~/code/gemini-plugin-cc
   ```

2. **Add it to your personal marketplace** at `~/.agents/plugins/marketplace.json`. If the file does not exist, create it. If it does, add the entry to the existing `plugins[]` array.
   ```json
   {
     "name": "personal",
     "interface": { "displayName": "Personal plugins" },
     "plugins": [
       {
         "name": "gemini",
         "source": {
           "source": "local",
           "path": "~/code/gemini-plugin-cc/plugins/gemini"
         },
         "policy": {
           "installation": "AVAILABLE",
           "authentication": "ON_INSTALL"
         },
         "category": "Productivity",
         "interface": { "displayName": "Gemini Integration" }
       }
     ]
   }
   ```

3. **Install via Codex**:
   ```bash
   codex
   ```
   Inside Codex, run `/plugins`, switch to the "personal" tab, select "gemini", and choose "Install plugin". Codex copies the plugin into its cache and registers the plugin's skills, commands, hooks, and MCP servers automatically.

4. **Verify the install landed**:
   ```bash
   ls ~/.codex/plugins/cache/personal/gemini/local/
   ```
   You should see the plugin tree (`.codex-plugin/`, `scripts/`, `commands/`, etc.). Codex installs use `<VERSION>=local` for local marketplace sources.

5. **Use it**: invoke implicitly with `$gemini <task>` (Codex's auto-invocation reads `agents/openai.yaml` at the plugin source root).

## Updating

```bash
cd ~/code/gemini-plugin-cc && git pull
```

Then in your host, reinstall the plugin to pick up changes — both Claude Code and Codex cache by `version` in `plugin.json`, so bumping the version invalidates the cache automatically.

- **Claude Code**: `/plugin uninstall gemini@google-gemini && /plugin install gemini@google-gemini`
- **Codex**: `/plugins` → select "gemini" → "Reinstall" (or uninstall + install)

## Uninstalling

- **Claude Code**: `/plugin uninstall gemini@google-gemini`
- **Codex**: `/plugins`, select the plugin, choose "Uninstall"

## Notes

- The plugin ships **two parallel manifest dirs**:
  - `.codex-plugin/plugin.json` (canonical Codex manifest path per the official spec)
  - `.claude-plugin/plugin.json` (Claude Code manifest path)
  Both files are byte-identical and there is a CI gate (`tests/install.test.mjs`) enforcing parity.
- Each host has its own marketplace descriptor:
  - `.agents/plugins/marketplace.json` — canonical Codex path per the official OpenAI docs (Codex shape: structured `source: { source: "local", path: ... }` with `policy` and `interface.displayName`)
  - `.claude-plugin/marketplace.json` — Claude Code's path (string-form `source: "./plugins/gemini"`, no `policy` block)
- The runtime detects which host is running it via `CLAUDE_ENV_FILE` (set only by Claude Code's session lifecycle hook AND must point at a real session.env file). Codex sessions never set this var and use a separate state directory under `$TMPDIR/gemini-companion/` to keep job state from colliding with any Claude Code state tree.
- Codex does not have a SessionEnd hook, so the plugin reaps stale `gemini --acp` broker processes (older than 1 hour AND not accepting connections) on each new invocation. Healthy long-running brokers are preserved.
