# First import

Use a ChatGPT data export to establish the historical catalog. The organizer imports its conversation metadata, initially assigns items to Uncategorized, and lets you build your own category structure. Subsequent Update now runs add current app metadata and available local Codex chats.

## 1. Request your ChatGPT export

In ChatGPT, open your profile menu, then **Settings → Data controls → Export data**. Select Export and confirm the request. When the export is ready, download its ZIP while signed in to the account that requested it. OpenAI says delivery may take up to seven days and the download link expires after 24 hours. [Official export instructions](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)

Availability depends on the account and workspace. For organization-managed accounts, consult the workspace owner when self-service export is unavailable. The official guide covers eligibility and the Privacy Portal alternative. [Export availability](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)

## 2. Extract the ZIP locally

Extract the archive to a private directory, such as `C:\ChatGPT export`. Keep it outside this repository. The download can include complete messages, attachments, and other account information.

Locate the conversation JSON supplied by the export. The importer accepts an extracted directory or a supported conversation JSON file. It stores stable IDs, titles, links, and timestamps. The `is_archived` field determines which archived records are excluded from this initial import.

A directory can contain `conversations.json` or a contiguous numbered set such as `conversations-0.json`, `conversations-1.json`, and so on. Numbering may start at zero or one. Use the directory form for a multi-file export so that all supported parts are checked together. The supported JSON content is a conversation array, either at the top level or in a `conversations` property. The combined input is limited to 256 MiB.

## 3. Install and choose the catalog location

Follow the [installation instructions](../README.md#install-from-source). Complete the export import before pressing Update now or beginning to categorize chats.

On Windows, the default catalog is `%LOCALAPPDATA%\ChatOrganizer\catalog\catalog.sqlite`. The importer and installed service use the same directory rules. A custom `CHAT_ORGANIZER_DATA_DIR` must be an absolute directory and must be configured consistently for both processes. See [Data and compatibility](data-and-compatibility.md).

The importer requires a fresh catalog. If that location already contains imported items or user organization, it stops and reports the conflict. Review the location and existing installation before continuing. An alternate fresh directory can be selected with `--data-dir`; configure the installed plugin to use that same directory if you intend to use it. Retain an established catalog for normal ongoing use.

## 4. Import the metadata

From the source repository root, run:

```powershell
pnpm import:export -- "C:\ChatGPT export"
```

You can also name a supported conversation JSON file directly:

```powershell
pnpm import:export -- "C:\ChatGPT export\conversations.json"
```

For the built marketplace ZIP, run the bundled importer from the extracted marketplace root:

```powershell
node ./tools/import-export.mjs "C:\ChatGPT export"
```

Replace the example path with your own extracted export location. Both commands use the normal private catalog location by default. The optional `--data-dir` argument accepts an absolute path.

The importer validates the supported input before importing. Invalid IDs, malformed data, incomplete shard sequences, and conflicting duplicate records stop the import. Exact duplicate records are counted once. Missing titles or unusable dates produce metadata warnings while retaining valid records. Review the imported count, archived exclusions, duplicate count, and warnings before treating the historical catalog as complete.

Every imported chat receives the organizer category **Uncategorized**, with no flame mark. Explicitly archived export records are skipped, so the imported total can be smaller than the number of export records. Current project membership is established in the following update step.

## 5. Open the organizer and update current metadata

Fully quit and reopen Codex after installing the plugin. Select Chat Organizer in a conversation and ask it to open the organizer. Verify the imported titles under Uncategorized, then press **Update now**.

The assistant combines the current sidebar and project list, explicit archive records, local Codex metadata, and recent ChatGPT cache metadata. This adds the available local Codex conversations separately from the ChatGPT export and reconciles current source information. Review the update report's named exceptions and source coverage.

An Update now run requests at most 50 recent sidebar entries, uses a 30-day ChatGPT cache window, and performs up to eight eligible saved-chat checks. The initial export supplies historical ChatGPT records beyond those recent sources.

## 6. Organize the starting list

Add categories, then use an item's bullet to choose its destination. The two optional subcategory levels support a hierarchy such as Travel → Europe → Planning. Flame-marked chats also appear under Priority.

As the list becomes organized, use title search and Jump to to find items. Continue using Update now for new chats and metadata changes, Refresh activity for existing local chat dates and titles, and Reload saved data to display the latest saved organizer state.

The [illustrated screen guide](user-guide.md) explains the numbered controls, menus, review categories, and where each chat type opens.

The export represents the data supplied by the source account at export time. The import report and subsequent update coverage establish what entered the catalog and what still needs review.
