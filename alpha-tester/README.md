# Cursor Spending (Alpha) – Quick Install

Shows your Cursor spend in the status bar (bottom right): month-to-date spend against your limit, then today's spend. Takes about 2 minutes to install.

## 1. Remove the original extension (if you have it)

If you ever installed **Cursor Spending** by `drash-course`, uninstall it first:
**Extensions** view (`Ctrl+Shift+X`) → search `Cursor Spending` → **Uninstall**.

## 2. Install the alpha

1. Save `cursor-spending-0.2.0.vsix` somewhere on your machine.
2. In Cursor, open the **Extensions** view (`Ctrl+Shift+X`).
3. Click the **…** menu at the top of the view → **Install from VSIX…** → pick the file.

Or from a terminal:

```
cursor --install-extension cursor-spending-0.2.0.vsix
```

## 3. Reload

`Ctrl+Shift+P` → **Developer: Reload Window**.

That's it. There's nothing to configure: as long as you're signed in to Cursor, your spend appears in the status bar within a few seconds. It refreshes every hour; to update it now, run **Cursor Spending: Refresh usage** from `Ctrl+Shift+P`.

## What you should see

- Something like `$1,062 / $1,500`, alternating with today's spend.
- Default status-bar colours in normal use. A **yellow warning** appears when you reach 85% of budget; **red** for fetch errors or 100%+.
- Hover over it to see your limit and where the numbers came from.

## If something looks wrong

1. Check you're signed in to Cursor, then run **Cursor Spending: Refresh usage**.
2. Compare with [cursor.com/dashboard](https://cursor.com/dashboard?tab=usage).
3. Run **Cursor Spending: Show log**, copy the output, and send it with a screenshot of the status bar and tooltip to **[OWNER NAME / CHANNEL]**. The log doesn't contain passwords, keys, or tokens.

## Privacy

The extension reads your Cursor sign-in token on your machine and sends it only to cursor.com to fetch **your own** usage, the same way Cursor does. It doesn't store, log, or send the token anywhere else. To turn this off, set `cursorSpending.useCursorSignIn` to `false` in Settings.

## Uninstall

**Extensions** view → **Cursor Spending (Alpha)** → **Uninstall**.
