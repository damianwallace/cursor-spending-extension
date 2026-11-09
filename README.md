# Cursor Spending (Alpha)

View your Cursor spend in the status bar: month-to-date spend against your limit, and today's spend.

> **Alpha build.** Expect rough edges.

![Screenshot](images/cursor-usage-preview.png)

## Install (alpha testers)

1. If you have the original **Cursor Spending** extension (publisher `drash-course`) installed, uninstall it first. Both register the same commands.
2. In Cursor: **Extensions** view → **…** menu → **Install from VSIX…** → pick the `.vsix` file you were sent. Or from a terminal:

   ```
   cursor --install-extension cursor-spending-0.2.0.vsix
   ```

3. Reload the window. There is nothing to set up: if you're signed in to Cursor, spend appears in the status bar within a few seconds.

## How it gets your spend

| Source | When |
|--------|------|
| **Cursor sign-in** | Default. The extension reads your Cursor sign-in token from Cursor's local settings and asks cursor.com for your own usage. |
| **Pasted session cookie** | Only if the sign-in can't be used (signed out, expired, or rejected) and you've pasted a cookie. |
| **Arc (Cursor Insights)** | Optional. Only if you set up an Arc **User** key. When Arc fails, the extension pauses Arc for 24 hours and uses your Cursor sign-in. |

Hover over the status bar item to see the source, your limit, and why Arc wasn't used. Colour is reserved for budget warnings and errors — not for which data source was used.

## Features

- **Status bar** – cycles between **month-to-date spend vs limit** and **today's spend**.
- **Budget warning** – at 85% of limit (configurable), cycles in a yellow warning; at 100%+ uses the error colour. Click opens the increase-limit link.
- **Refresh** – every 60 minutes by default, plus **Cursor Spending: Refresh usage** for an immediate update.

## Optional setup

- **Arc User key** – sign in at [arc.trimble.com](https://arc.trimble.com) → profile → **Settings** → **API Keys** → create a key of type **User** (Application keys are rejected). Run **Cursor Spending: Set up Arc API key** and enter the key and your full Cursor email. Each Arc refresh runs one Arc task and can take about 30 seconds.
- **Pasted cookie** – run **Cursor Spending: Configure session token (fallback)** and paste `WorkosCursorSessionToken` from browser DevTools → Cookies → cursor.com.

## Extension Settings

| Setting | Description | Default |
|--------|-------------|---------|
| `cursorSpending.refreshInterval` | How often to fetch usage, in minutes (15 minimum). | `60` |
| `cursorSpending.statusBarCycleSeconds` | Seconds between spend/limit and today views. | `5` |
| `cursorSpending.useCursorSignIn` | Use your local Cursor sign-in to read usage from cursor.com. Turn off to rely on Arc or a pasted cookie only. | `true` |
| `cursorSpending.lookupEmail` | Arc only: your full Cursor account email. | `""` |
| `cursorSpending.arcBaseUrl` | Arc Agent API base URL. | `https://arc.trimble.com/api/v1` |
| `cursorSpending.arcSkillId` | Cursor Insights skill ID override (auto-discovered when empty). | `""` |
| `cursorSpending.warnPercent` | Show budget warning at this percent of the limit. | `85` |
| `cursorSpending.increaseLimitUrl` | Link opened from the budget warning. Empty uses the Cursor usage dashboard. | `""` |

## Commands

| Command | Description |
|--------|-------------|
| **Cursor Spending: Refresh usage** | Fetches current usage and updates the status bar. |
| **Cursor Spending: Show log** | Opens the Output channel. Include this when reporting a problem. |
| **Cursor Spending: Set up Arc API key** | Optional Arc User key + email. |
| **Cursor Spending: Resume Arc** | Retry Arc now instead of waiting out a 24-hour pause. |
| **Cursor Spending: Remove Arc API key** | Delete the stored Arc key. |
| **Cursor Spending: Configure session token (fallback)** | Paste a session cookie. |

## Reporting problems

Send the extension owner:

- What the status bar showed (text and colour) and the tooltip.
- The output of **Cursor Spending: Show log**. It contains no keys or tokens, but it does include your email if you set one for Arc.
- Whether the numbers match [cursor.com/dashboard](https://cursor.com/dashboard?tab=usage).

## Security and Privacy

- Your Cursor sign-in token is read on your machine and sent only to cursor.com, the same service Cursor itself uses. It is never stored by the extension, logged, or sent anywhere else.
- Arc keys and pasted cookies are stored in the editor's **secret storage** (Windows Credential Manager on Windows). No shared or admin credentials are used.
- Only your own usage is requested.
- Figures are Cursor Dashboard Cost and may differ slightly from invoices.
- Month-to-date assumes the billing cycle starts on the 1st of the month.

## Development

- `npm install`, `npm run compile`, then **F5** for an Extension Development Host.
- `npm run package` builds the VSIX.

## License

MIT. Based on [drash-course/cursor-spending-extension](https://github.com/drash-course/cursor-spending-extension).
