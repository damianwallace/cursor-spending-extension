I am trying to get familar with ARC with a simple project to solve an issue my team has.   I'm  building a Cursor status-bar extension that shows each user their own Cursor spend by calling the Cursor Insights skill (skl_84c336946a) through the Arc API with the user's own User API key.

The task fails with credential_required. GET /skills/skl_84c336946a/tokens for my key returns CURSOR_API_KEY: is_provided=false and CURSOR_ORG_API_KEY: is_provided=false. The skill is visible to my key and the tool calls run although it being rate limited; only the credentials are missing.

Questions:

Can the Cursor Insights credentials be provided at the platform or skill level, so any user entitled to the skill can run it without holding the Cursor Admin keys?
Can CURSOR_ORG_API_KEY be optional? We only use get_team_spend and get_filtered_usage_events.
If the credentials are shared, can the skill limit non-admin users to their own email, so nobody can look up other people's spend?  This is not intended to be  team reporting tool, just for the indiviudal user.   If not I will build in some guardrails
For rollout I foresee users refreshing hourly by default: can Arc cache Cursor Insights results or offer a structured "my spend" endpoint? The Cursor Admin API allows about 20 requests per minute and I often run into the rate linit.

This not intened to replace the skill but rather expose a part of the data within cursor for the cursor users

