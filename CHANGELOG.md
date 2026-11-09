# Changelog

All notable changes to Cursor Spending are documented here.

## [0.2.1]

- Decrypt Cursor 3.x encrypted sign-in tokens on Windows.
- Green spend text; yellow/red budget warnings at 85%/100%.
- Trimble Cloud Ops link for limit-increase requests.
- Optional team spend tooltip (`showTeamSpend`); remove code-fence progress bars.
- Debug fake limit setting for testing warning colours.

## [1.0.5]

- Mirror Cursor dashboard wording in tooltips: Auto and Composer models vs other models, API quota for overage, and plan API usage when the API returns it.

## [1.0.4]

- Add preview screenshot to README.

## [1.0.3]

- Use Cursor icon instead of run icon for Auto usage in the status bar.
- Increase max refresh interval to 1 day (1440 minutes).
- Add "Refresh now" link in the usage tooltip.
- Show "Refreshing..." in the status bar while fetching, then update with the result.
- Change default refresh interval to 20 minutes.

## [1.0.2]

- Add CHANGELOG for the Open VSX extension page.

## [1.0.1]

- Added extension icon (spend_icon.png).

## [1.0.0]

- Initial release.
- Status bar: Auto and API usage percentages.
- Rich tooltip with progress bars and spend summary.
- Token setup panel when session token is missing.
- Periodic refresh (default 10 minutes) and manual refresh command.
