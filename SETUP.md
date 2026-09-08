# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## Firecrawl

The search, scrape, and crawl tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the firecrawl extension in their pi setup

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Herdr managed agents

This setup dogfoods [pi-herdr-managed-agents](https://github.com/Crush53/pi-herdr-managed-agents) from its local checkout at `~/Projects/pi-herdr-managed-agents`, so fixes can be tested before publishing another npm beta. Pi, Claude Code, and Codex run in separate full-size [Herdr](https://herdr.dev/) tabs; headless backends remain available outside Herdr.

```sh
# Install dependencies in the package checkout first, then register it:
pi install ~/Projects/pi-herdr-managed-agents
```

`settings.json` selects that checkout and disables the old local extension with `"extensions": ["-extensions/subagents/index.ts"]`. Keep that exclusion while the npm package is enabled: both register the same six tools and `/subagents`/`/btw` commands. The local source is retained for rollback, not loaded. Model defaults and the personal `skills/subagents` preferences are independent of the package.

Run `/reload` in an idle Pi session (or start a new session) to activate the change. Finish/cancel existing children first: reload disposes their manager. To roll back, remove the checkout entry from `packages` and remove the local exclusion, then reload. To switch to a published release later, replace the checkout entry with an exact `npm:pi-herdr-managed-agents@<version>` spec. Do not enable both sources: npm and local paths are different package identities. The previously installed npm beta may remain on disk without being enabled.

Install Herdr and the native agent CLIs, then install Herdr's session integrations:

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi
herdr integration install claude
herdr integration install codex
```

Start Herdr from a project, launch Pi inside its pane, and reload Pi after installing or updating the integrations:

```sh
herdr
# Inside the Herdr pane:
pi
# Then run /reload in Pi.
```

The subagent manager, `/subagents` dashboard, wait/check/send/cancel tools, skills, and automatic result delivery continue to work. The generated `extensions/herdr-agent-state.ts` file is intentionally ignored; `herdr integration install pi` recreates the version matching the installed Herdr binary.

Check `herdr status --json` before native tests. A newer CLI cannot control an older server protocol. Do not stop an active server to fix this: it terminates pane processes. Use a disposable named session for tests, or arrange a user-controlled upgrade. Record reproduction steps and exact errors in the package repository; do not patch installed `node_modules` or blindly replay an uncertain task.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
