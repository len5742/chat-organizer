# Validation

This package is derived from a locally used organizer and is being prepared for public distribution. Validation should distinguish the portable package from source-account integration.

## Local verification

Version 0.2.5 passed 314 automated tests on Windows with Node.js 24. New regression checks cover current-cache selection, failure reporting without stale fallback, deferring unnamed cloud records, retaining saved names when sources return previews, and exception naming. The package is rebuilt from the reviewed public source. The interface changes are limited to the version marker and a deferred-record count. The browser checks described below were performed for 0.2.4.

The extracted 0.2.5 archive passed a separate service check from a directory containing spaces. Its bundled importer imported one fictional active chat and skipped one archived chat. The packaged service selected the current cache over a conflicting legacy cache, deferred an unnamed durable record, returned the expected saved catalog, and served all three current, previous, and stable interface resource addresses. An attempted isolated CLI installation could register the marketplace, but cache activation was denied by the execution environment's filesystem permissions. Full CLI installation was not reverified for 0.2.5.

Version 0.2.4 passed 306 automated tests on Windows with Node.js 24. The dependency lockfile is retained from the verified frozen installation. Tests cover the permanent Trash category, protection from renaming and deletion, reordering, preservation of an existing Trash category and its assigned items, and upgrades with a pending category-deletion Undo. Archive-batch tests cover exact approved scope, project members and aliases, new or changed membership, organizer-only project removal, source failures, uncertain results, concurrent requests, interruption recovery, controlled stopping, and preservation of unrelated catalog data.

A temporary Codex profile was used to register and install `chat-organizer@chat-organizer-community` from a directory containing spaces. Its installed service, interface, and complete maintenance workflow were verified against the build. The service and workflow use the `chat_organizer` namespace.

The 0.2.4 packaged Trash workflow was retrieved from that isolated installation and executed against a fictional project and chat with a simulated native archive acknowledgment. Exactly one archive request was issued, the saved batch completed, and both the archived chat and completed organizer project entry disappeared from the visible catalog. A second fictional project with two chats tested stopping during an archive request: exactly one chat was archived, the batch stopped, and the remaining chat and project entry stayed visible. No real source chat was used in these packaging checks.

The bundled export importer was exercised with fictional records. It imported one active chat into Uncategorized and skipped one explicit archive. The installed plugin read back the imported record. The test suite verifies refusal of a repeat import into a populated catalog, validation failures, duplicate IDs, numbered files, source-content exclusion, and competing catalog changes.

An isolated Chrome check used fictional chat titles at 1850 and 390 pixel widths. Search controls measured 640 pixels on the wide screen and 343 pixels on the narrow screen. The cap held while scrolling and with the header collapsed during an active search; Previous, Next, and Clear worked. Trash had no rename/delete menu, and reordering it through the interface saved the new position while preserving all synthetic items. There was no horizontal overflow or browser error. The README screenshot comes from this fictional fixture. Earlier browser checks also verified a fresh empty catalog, category moves with database readback, and the portable update request.

The illustrated guide was checked separately at 1470 and 390 pixel widths. All eight author-supplied screenshots loaded, the section links and full-size image viewer worked, and the document had no horizontal overflow, browser errors, or network requests. Its single-file HTML copy embeds the screenshots; its Markdown copy uses the same images as repository assets.

The Empty trash interface was checked separately in both the personal and public builds at desktop and mobile widths using synthetic data. The preview, project results, and Stop after current chat flows passed, including stopping before work starts and during an in-flight archive request. The two controls share an outlined group, and the inactive stop button remains visible in gray. No browser errors were observed.

`pnpm test` exercises synthetic export and source data, catalog mutations, identity reconciliation, archive and missing-item handling, revision checks, maintenance leases, activity refresh, and MCP protocol behavior. Tests create temporary or in-memory catalogs.

`pnpm build` creates the distributable marketplace. The built plugin should be verified from an extracted directory, including a path with spaces, using a temporary Codex home and a temporary organizer data directory. This tests installation and packaged resources without changing an existing installation.

The UI can be tested against synthetic catalog data in a local MCP Apps host. Useful flows include opening a menu, moving an item, flame/ Priority behavior, nested categories, search reveal and navigation, narrow layouts, reload, and named update exceptions.

## Source-account integration

A new user's initial export import and first real update still require verification in a compatible desktop account. Review the export import counts and any skipped-record reasons. Confirm that the installed plugin is available, its panel opens, and imported visible records appear in Uncategorized. Check that the hosting assistant has the required native chat tools. Run Update now and review its coverage, source errors, and imported titles.

Export formats, local metadata schemas, and host tool availability can vary by client release. Only Windows desktop source integration has been exercised during the organizer's development. The export importer covers supported readable records in the supplied export. Ongoing updates use recent and locally available metadata, so account coverage can remain partial.

Treat passing catalog, protocol, packaging, and synthetic UI tests as evidence for those layers. Record real-account onboarding separately when a fresh-account test has been completed.
