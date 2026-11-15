# Validation

This package is derived from a locally used organizer and is being prepared for public distribution. Validation should distinguish the portable package from source-account integration.

## Local verification

Version 0.2.2 passed 272 automated tests on Windows with Node.js 24. The dependency lockfile is retained from the verified frozen installation. Tests cover the permanent Trash category, protection from renaming and deletion, reordering, preservation of an existing Trash category and its assigned items, and upgrades with a pending category-deletion Undo.

A temporary Codex profile was used to register and install `chat-organizer@chat-organizer-community` from a directory containing spaces. Its installed service, interface, and complete maintenance workflow were verified against the build. The service and workflow use the `chat_organizer` namespace.

The bundled export importer was exercised with fictional records. It imported one active chat into Uncategorized and skipped one explicit archive. The installed plugin read back the imported record. The test suite verifies refusal of a repeat import into a populated catalog, validation failures, duplicate IDs, numbered files, source-content exclusion, and competing catalog changes.

An isolated Chrome check used fictional chat titles at 1850 and 390 pixel widths. Search controls measured 640 pixels on the wide screen and 343 pixels on the narrow screen. The cap held while scrolling and with the header collapsed during an active search; Previous, Next, and Clear worked. Trash had no rename/delete menu, and reordering it through the interface saved the new position while preserving all synthetic items. There was no horizontal overflow or browser error. The README screenshot comes from this fictional fixture. Earlier browser checks also verified a fresh empty catalog, category moves with database readback, and the portable update request.

The illustrated guide was checked separately at 1470 and 390 pixel widths. All eight author-supplied screenshots loaded, the section links and full-size image viewer worked, and the document had no horizontal overflow, browser errors, or network requests. Its single-file HTML copy embeds the screenshots; its Markdown copy uses the same images as repository assets.

`pnpm test` exercises synthetic export and source data, catalog mutations, identity reconciliation, archive and missing-item handling, revision checks, maintenance leases, activity refresh, and MCP protocol behavior. Tests create temporary or in-memory catalogs.

`pnpm build` creates the distributable marketplace. The built plugin should be verified from an extracted directory, including a path with spaces, using a temporary Codex home and a temporary organizer data directory. This tests installation and packaged resources without changing an existing installation.

The UI can be tested against synthetic catalog data in a local MCP Apps host. Useful flows include opening a menu, moving an item, flame/ Priority behavior, nested categories, search reveal and navigation, narrow layouts, reload, and named update exceptions.

## Source-account integration

A new user's initial export import and first real update still require verification in a compatible desktop account. Review the export import counts and any skipped-record reasons. Confirm that the installed plugin is available, its panel opens, and imported visible records appear in Uncategorized. Check that the hosting assistant has the required native chat tools. Run Update now and review its coverage, source errors, and imported titles.

Export formats, local metadata schemas, and host tool availability can vary by client release. Only Windows desktop source integration has been exercised during the organizer's development. The export importer covers supported readable records in the supplied export. Ongoing updates use recent and locally available metadata, so account coverage can remain partial.

Treat passing catalog, protocol, packaging, and synthetic UI tests as evidence for those layers. Record real-account onboarding separately when a fresh-account test has been completed.
