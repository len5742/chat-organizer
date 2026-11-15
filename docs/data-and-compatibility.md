# Data and compatibility

Chat Organizer stores its own catalog and obtains source information through a combination of host tools and local app metadata. This package requires a compatible Windows Codex desktop host. It does not run in ChatGPT on the web or on mobile.

## Private catalog

The default database filename is `catalog.sqlite` inside a platform-specific catalog directory.

| Platform | Default directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ChatOrganizer\catalog` |
| macOS | `~/Library/Application Support/ChatOrganizer/catalog` |
| Linux | `$XDG_DATA_HOME/chat-organizer/catalog`, or `~/.local/share/chat-organizer/catalog` |

Windows falls back to `~/AppData/Local` when `LOCALAPPDATA` is absent. The portable directory rules allow the core server to choose a private location, while source integration on macOS and Linux remains unverified.

`CHAT_ORGANIZER_DATA_DIR` overrides the catalog directory and must be an absolute path. The organizer process must have write access to that directory, including SQLite journal files. Set the variable in the plugin's process environment before launch. Changing it selects a different catalog location. Existing files need to be copied separately with the organizer closed.

The catalog contains source IDs, chat and project titles, original links, category hierarchy and ordering, focus marks, timestamps, archive/missing states, and maintenance diagnostics. The GitHub distribution contains synthetic test fixtures and author-supplied screenshots for the illustrated guide. It contains no populated catalog. Source account data is created locally during use.

## Export import

The initial importer reads an extracted ChatGPT export from a local directory or conversation JSON file. It stores titles, stable IDs, links, and activity dates, assigning every imported chat to Uncategorized with no flame. It skips explicitly archived records and reports their count. Update now later establishes current project membership using the app's source metadata.

The export ZIP and JSON can contain full messages and other account data. Keep them in a private directory outside the repository. The catalog stores the selected metadata fields used by the organizer. The importer requires a fresh catalog, validates the complete supported input before importing, and reports archived exclusions, duplicate counts, and metadata warnings. See [First import](first-import.md).

## Source access

Maintenance uses native host tools for current projects, recent chats, archive listings, and bounded reads of particular chats. Exact tool availability depends on the host and account.

Local source discovery reads these files below `CODEX_HOME`, or the current user's `~/.codex` directory when that variable is absent:

- `state_5.sqlite` for interactive local chat metadata.
- `.codex-global-state.json` for explicit local project assignments and aliases.
- `sqlite/codex-dev.db` for recent cached ChatGPT metadata.

These are app-managed implementation details that can change between host releases. Unknown schemas, ambiguous membership, multiple cache account partitions, and unreadable sources are reported as coverage exceptions. The source readers open SQLite metadata with read-only connections. Organizer updates write to the private organizer catalog through its service.

Refresh activity starts the locally installed Codex app-server and requests metadata for existing local chats. Its automatic executable discovery currently follows the Windows installation layout.

Chat opening follows the saved source identity and the available host route:

| Chat type | Destination |
| --- | --- |
| Ordinary ChatGPT conversation, including one originally created on the web | Desktop app, through the hosting assistant's conversation navigation |
| Local Codex / desktop Work chat | Desktop app |
| Positively identified web Work conversation with a verified web link | Browser, using that web Work link |
| Remote Work record without a verified web mapping | Supported native app route, when its source host is available |

A ChatGPT or Codex label alone does not establish web Work identity. The organizer needs a verified mapping to choose the browser route. An accepted opening request confirms that the host received it; host availability or permissions can still prevent the destination from opening.

## Web support and a shared catalog

The current plugin starts a local Node.js service, reads local app metadata, and relies on desktop tools for some updates and navigation. OpenAI classifies plugins requiring local execution as desktop-only. Installing such a package on the web does not move its local programs or database to a web server. [Desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only), [plugin architecture](https://developers.openai.com/plugins/concepts/plugins)

A web edition is technically feasible as a separate development project. The existing interface uses MCP Apps, which supports a server-backed UI inside ChatGPT. A remotely reachable MCP service can supply that interface and its tools. [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)

For a shared catalog, the proposed design is one authenticated service that owns the database and handles updates from both desktop and web. It could run on the user's computer behind a secure connection, in which case the computer must remain available, or on a hosted server. The clients would call the same service; they would not independently edit copies of a SQLite file. A desktop component would still be needed for local-only metadata and local Codex navigation. A hosted catalog would also require access controls, private storage, backups, and a defined synchronization process with that component.

This is an architectural assessment, not a supported configuration. The package's optional HTTP transport is restricted to the local computer and provides no remote authentication layer. Web chat-opening routes and access to source history would need separate implementation and testing; desktop-only chats may still need the desktop app to open.

## Update coverage and deletion review

An Update now run combines a recent sidebar request, current local index records, explicit archive lists, and a 30-day ChatGPT cache window. It also attempts up to eight eligible saved-chat verifications. The initial ChatGPT export supplies the historical records beyond that recent discovery window.

The report's **source checks** count can include repeated observations of one item and archived or hidden records. **Visible saved items** counts the entries available in the organizer after filtering and linked-identity handling.

An absent ID in a partial list does not establish deletion. Explicit archive evidence hides the corresponding entry. Conclusive missing-item responses can update its status. Ambiguous host failures remain unresolved. Three eligible unresolved checks, separated by at least six hours, can place a chat in Potentially deleted for the user to review. Rate limits, authentication failures, and access-denied responses follow separate handling.

The workflow includes bounded full-audit support for explicitly requested maintenance. This distribution configures no audit schedule, and the Update now button requests recent-only maintenance.

## Sharing diagnostics

When reporting a problem, include the organizer software version, desktop platform, action taken, expected behavior, and the visible error. Review screenshots and logs for chat titles, source IDs, personal directory paths, and account information before sharing them. Avoid attaching the catalog or app source databases to a public issue.

The UI and service run locally. Metadata reads and update reports pass through the assistant host and its existing account permissions. The organizer provides no independent authentication or cloud storage account.
