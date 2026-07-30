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

## Herdr subagent panes

This fork launches Pi, Claude Code, and Codex subagents as real interactive agents in visible [Herdr](https://herdr.dev/) panes whenever the parent Pi session is running inside Herdr. Outside Herdr, the original headless subagent backends remain available.

Install Herdr, then install its native session integrations:

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

The subagent manager, `/subagents` dashboard, wait/check/cancel tools, skills, and automatic result delivery continue to work. Herdr additionally exposes each child as an auditable native terminal. The generated `extensions/herdr-agent-state.ts` file is intentionally ignored; `herdr integration install pi` recreates the version matching the installed Herdr binary.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
