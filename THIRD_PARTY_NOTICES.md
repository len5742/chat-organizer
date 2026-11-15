# Third-party dependencies

Chat Organizer uses the packages pinned by `pnpm-lock.yaml`.

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | MCP server and client protocol |
| zod | 4.6.7 | MIT | Input and output validation |
| esbuild | 0.28.2 | MIT | Development build tool |

The build produces `THIRD_PARTY_NOTICES.txt` beside the bundled server. It includes the full license files for every third-party package represented in the bundle, including transitive dependencies. Retain that file when redistributing the built plugin. The dependency packages installed for development also contain their own license files.

The project's MIT license covers the original Chat Organizer source. The dependency licenses apply to their respective code.
