# opencode-claude-auth

OpenCode plugin that uses your existing Claude Code credentials — no separate login needed.

## How it works

Claude Code stores OAuth tokens in the macOS Keychain (or `~/.claude/.credentials.json` on other platforms). This plugin reads those tokens and provides them to OpenCode via its auth hook, so you don't need to log in twice. When a token is about to expire, it re-reads credentials automatically. If they're still stale, it runs the Claude CLI to trigger a refresh. For OpenCode > 1.2.27, it also injects the Anthropic session prompt via the `experimental.chat.system.transform` hook.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

One command — install and configure:

```bash
npm install opencode-claude-auth && node -e "
const fs = require('fs'), p = require('path').join(require('os').homedir(), '.config/opencode/opencode.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.plugin = [...new Set([...(Array.isArray(c.plugin) ? c.plugin : []), 'opencode-claude-auth'])];
fs.mkdirSync(require('path').dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added opencode-claude-auth to', p);
"
```

Or manually:

```bash
npm install opencode-claude-auth
```

Then add to your `opencode.json`:

```json
{
  "plugin": ["opencode-claude-auth"]
}
```

### Install with AI

Paste this into your AI agent (Claude Code, Cursor, Copilot, etc.):

```
Fetch https://raw.githubusercontent.com/gmartin/opencode-claude-auth/main/installation.md and follow every step exactly as written.
```

## Usage

Just run OpenCode. The plugin reads your Claude Code credentials automatically and handles token refresh in the background.

## Credential sources

The plugin checks these in order:

1. macOS Keychain ("Claude Code-credentials" entry)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Credentials not found" | Run `claude` to authenticate with Claude Code first |
| "Keychain is locked" | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
| "Token expired and refresh failed" | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude` |
| Not working on Linux/Windows | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it |
| Keychain access denied | Grant access when macOS prompts you |
| Keychain read timed out | Restart Keychain Access (can happen on macOS Tahoe) |

## How it works (technical)

- Registers an OpenCode auth hook for the `anthropic` provider
- Overrides the built-in `opencode-anthropic-auth` plugin
- Returns a custom `fetch` wrapper that injects `Authorization: Bearer` headers
- When a token is within 60 seconds of expiry, re-reads credentials from Keychain or file
- If still expired, runs `claude -p . --model claude-haiku-4-5-20250514` to trigger a refresh
- For OpenCode > 1.2.27, injects the Anthropic session prompt via `experimental.chat.system.transform`

## License

MIT
