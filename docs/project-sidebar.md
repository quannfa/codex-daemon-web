# Project sidebar

Project conversations are grouped by the exact \`thread.cwd\` value. Explicit
desktop projectless membership takes priority over cwd, while explicit project
assignments preserve project grouping. Without membership hints, generated
\`Documents/Codex/YYYY-MM-DD/...\` directories (Linux or Windows), home directories,
and generic temporary roots are collected under **No project**. Only grouping
changes: the original conversation cwd is preserved.

Membership hints are read from desktop state through the authenticated status
response; the full desktop state is never returned. Missing or invalid state
falls back to path detection. Each heading shows
the directory name, full path, and number of currently loaded conversations.
Different paths with the same directory name remain separate; missing paths
appear under **No project**.

Use **Recent activity** or **Project name** to sort projects. Conversations
within each project use newest activity first (updated time in the archive).
Both the selected sort and each project's expanded/collapsed state are stored
in this browser under \`codex-web.project-sidebar.v1\`. If browser storage is
unavailable, grouping remains usable without persistence.

Search retains the existing title, preview, and path matching. Matching groups
expand temporarily during a search; clearing the search restores saved states.
The existing **Load more** button appends daemon pages and merges their
conversations into projects. Counts and sorting apply to loaded results, not
to conversations that have not been fetched yet.

Conversation selection, new-conversation navigation, rename, archive/restore,
context menus, and scheduled tasks retain their original handlers.

## Verification

- \`pnpm exec tsx --test tests/*.test.ts\`
- \`pnpm check\`
- \`pnpm build\`

The regression tests cover exact paths and same-name directories, missing
paths, Windows paths, project and conversation ordering, archive ordering,
timestamp units, source immutability, malformed preferences and blocked storage.

Remote browser verification additionally covered collapse/reload persistence,
sort persistence, search and empty results, pagination, selection, rename,
archive, new-conversation navigation, and mobile rendering with fixture RPC
responses, without modifying real conversations. Live verification after
restarting only the WebUI confirmed that the saved login session remained
valid, daemon connectivity was available, and existing daemon PIDs and start
times were unchanged.
