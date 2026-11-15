import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatalogStore, CatalogError, defaultDatabasePath } from './store.mjs';
import { readLocalActivity } from './activity-refresh.mjs';
import { collectRecentSources } from './maintenance-sources.mjs';

// A new UI release needs a new URI so hosts do not reuse a cached layout.
const UI_URI = 'ui://chat-organizer/v0.2.2/index.html';
const SERVER_ICONS = [{ src: 'data:image/png;base64,' + readFileSync(new URL('./assets/icon.png', import.meta.url)).toString('base64'), mimeType: 'image/png', sizes: ['256x256'] }];
const STABLE_UI_URI = 'ui://chat-organizer/index.html';
const instanceId = randomUUID();
const startedAt = new Date().toISOString();
const appMeta = {
  ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
  'openai/outputTemplate': UI_URI,
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
};
const deletionReviewSchema = z.object({
  failureCount:z.number().int().nonnegative(),firstFailedAt:z.string().nullable(),lastFailedAt:z.string().nullable(),
  queuedAt:z.string(),reason:z.enum(['repeated_failure','owner_request']),
}).strict();
const itemOutputSchema = z.object({
  id: z.string(), source: z.enum(['chatgpt', 'codex']), sourceId: z.string(),
  title: z.string(), kind: z.enum(['chat', 'project']),
  projectId: z.string().nullable(), hostId: z.string().nullable(),
  webConversationId: z.string().uuid().nullable().optional(),
  chatgptProjectId: z.string().regex(/^g-p-[a-f0-9]{32}$/i).nullable().optional(),
  deletionReview:deletionReviewSchema.optional(),
  projectAliases: z.array(z.object({sourceId:z.string(),hostId:z.literal('local')}).strict()).optional(),
  url: z.string().nullable(), updatedAt: z.string().nullable(), effectiveUpdatedAt: z.string().nullable(), category: z.string(), focused: z.boolean(),
  availability: z.enum(['available', 'not_found', 'archived']), lastCheckedAt: z.string().nullable(), lastCheckError: z.string().nullable(),
}).strict();
const categoryOutputSchema = z.object({ id: z.string(), name: z.string(), parentId: z.string().nullable(), protected: z.boolean() }).strict();
const snapshotOutputSchema = z.object({
  items: z.array(itemOutputSchema), categories: z.array(categoryOutputSchema),
  revision: z.number().int().nonnegative(), savedAt: z.string().nullable(),
  lastImport: z.object({ at: z.string(), coverage: z.string(), count: z.number().int().nonnegative() }).strict().nullable(),
  undoDelete: z.object({ token: z.string(), label: z.string() }).strict().nullable(),
  connection: z.object({ serverVersion: z.literal('0.2.2'), transport: z.enum(['stdio', 'http']) }).strict(),
}).strict();
const connectionOutputSchema = z.object({
  ok: z.literal(true), serverName: z.literal('chat-organizer'), serverVersion: z.literal('0.2.2'),
  instanceId: z.string(), startedAt: z.string(), transport: z.enum(['stdio', 'http']),
  catalogRevision: z.number().int().nonnegative(),
}).strict();
const activityRefreshOutputSchema = snapshotOutputSchema.extend({
  activityRefresh: z.object({
    attempted: z.number().int().nonnegative(), checked: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
    limitation: z.string(),
  }).strict(),
}).strict();

const countSchema = z.number().int().nonnegative();
const exceptionSchema = z.object({
  id: z.string().min(1).max(350), title: z.string().min(1).max(1000).nullable(),
  reason: z.enum(['verification_failed','verification_pending','project_membership_unverified','possibly_missing','title_pending','invalid_metadata','untitled','not_found','potentially_deleted']),
  detail: z.string().min(1).max(500),
}).strict();
const observationSchema = z.object({
  id: z.string().min(1).max(350), observedAt: z.string().datetime({ offset: true }),
  evidence: z.enum(['sidebar', 'project_list', 'project_list_complete', 'local_index', 'chatgpt_cache', 'probe', 'archive_list', 'local_lookup', 'owner_confirmation']),
  outcome: z.enum(['found', 'not_found', 'archived', 'error']),
  source: z.enum(['chatgpt', 'codex']).optional(), sourceId: z.string().min(1).max(300).optional(),
  kind: z.enum(['chat', 'project']).optional(), title: z.string().min(1).max(1000).optional(),
  projectId: z.string().min(1).max(300).nullable().optional(), hostId: z.string().min(1).max(300).nullable().optional(),
  url: z.string().max(2000).nullable().optional(), updatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  webConversationId: z.string().uuid().nullable().optional(),
  chatgptProjectId: z.string().regex(/^g-p-[a-f0-9]{32}$/i).nullable().optional(),
  error: z.string().max(500).optional(), verificationFailure:z.literal('unresolved').optional(),
}).strict();
const syncOutputSchema = z.object({ revision: countSchema, added: countSchema, renamed: countSchema, moved: countSchema,
  statusChanged: countSchema, unchanged: countSchema, errors: countSchema, stale: countSchema, checked: countSchema }).strict();
const auditOutputSchema = z.object({ id: z.string(), day: z.string(), startedAt: z.string(), completedAt: z.string().nullable(),
  total: countSchema, processed: countSchema, errors: countSchema, retryAfter: z.string().nullable().optional(), deferReason: z.string().nullable().optional() }).strict();
const maintenanceRunOutputSchema = z.object({ mode: z.enum(['recent', 'daily']), recordedAt: z.string(),
  dryRun: z.boolean().optional(), complete: z.boolean().optional(), paused: z.boolean().optional(), skipped: z.string().optional(), deferred: z.string().optional(),
  elapsedSeconds: z.number().nonnegative().optional(), added: countSchema.optional(), renamed: countSchema.optional(), moved: countSchema.optional(),
  statusChanged: countSchema.optional(), checked: countSchema.optional(), probeCalls: countSchema.optional(), batches: countSchema.optional(),
  projectCount: countSchema.optional(), observations: countSchema.optional(), visibleItems: countSchema.optional(),
  exceptions: z.array(exceptionSchema).max(1000).optional(), exceptionsOmitted: countSchema.optional(),
  errors: z.array(z.object({ source: z.string().optional(), code: z.string().optional(), message: z.string().optional() }).strict()).optional(),
  audit: auditOutputSchema.nullable().optional(), sources: z.record(z.string(), countSchema).optional() }).strict();
const maintenanceOutputSchema = z.object({ deletionReviewItems:z.array(deletionReviewSchema.extend({id:z.string(),title:z.string()})).optional(), revision: countSchema, visibleItems:countSchema.optional(), recentVerificationRetryAfter:z.string().nullable().optional(),
  counts: z.object({ available: countSchema.optional(), not_found: countSchema.optional(), archived: countSchema.optional() }).strict(),
  lastSync: syncOutputSchema.extend({ at: z.string(), mode: z.string(), coverage: z.string() }).strict().nullable(),
  audit: auditOutputSchema.nullable(), lastRecentRun: maintenanceRunOutputSchema.nullable(), lastDailyRun: maintenanceRunOutputSchema.nullable() }).strict();
const auditItemSchema = z.object({ id: z.string(), source: z.enum(['chatgpt', 'codex']), sourceId: z.string(), kind: z.enum(['chat', 'project']),
  title: z.string(), hostId: z.string().nullable(), availability: z.enum(['available', 'not_found', 'archived']) }).strict();
const currentProjectSchema = z.object({ projectId: z.string().min(1), projectKind: z.enum(['local', 'remote', 'chatgpt']),
  hostId: z.string().nullable().optional(), path: z.string().nullable().optional(), rootPaths: z.array(z.string()).nullable().optional(),
  rootPathAliases: z.array(z.object({ alias: z.string() }).passthrough()).nullable().optional() }).passthrough();
const recentOutputSchema = z.object({ observations: z.array(observationSchema),
  exceptions:z.array(exceptionSchema).optional(),
  projectAliases:z.array(z.object({sourceId:z.string(),hostId:z.literal('local'),chatgptProjectId:z.string().regex(/^g-p-[a-f0-9]{32}$/i)}).strict()).optional(),
  coverage: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  errors: z.array(z.object({ source: z.string(), code: z.string() }).strict()), counts: z.record(z.string(), countSchema) }).strict();

// The gateway exposes catalog operations, never a filesystem path, script, or
// arbitrary tool name. Project paths below are source metadata used solely for
// membership matching; the collector chooses its own fixed local data sources.
const maintenanceProjectSchema = z.object({
  projectId: z.string().min(1).max(300), projectKind: z.enum(['local', 'remote', 'chatgpt']),
  hostId: z.string().max(300).nullable().optional(), path: z.string().max(4000).nullable().optional(),
  rootPaths: z.array(z.string().max(4000)).max(100).nullable().optional(),
  rootPathAliases: z.array(z.object({ alias: z.string().max(4000) }).strict()).max(100).nullable().optional(),
}).strict();
const maintenanceReportSchema = maintenanceRunOutputSchema.omit({ recordedAt: true }).extend({
  skipped: z.string().min(1).max(500).optional(), deferred: z.string().min(1).max(500).optional(),
  errors: z.array(z.object({ source: z.string().min(1).max(100).optional(), code: z.string().min(1).max(100).optional(), message: z.string().min(1).max(500).optional() }).strict()).max(200).optional(),
  sources: z.record(z.string().min(1).max(100), countSchema).optional(),
  audit: auditOutputSchema.extend({
    id: z.string().min(1).max(100), day: z.string().min(1).max(100), startedAt: z.string().min(1).max(100),
    completedAt: z.string().max(100).nullable(), retryAfter: z.string().max(100).nullable().optional(),
    deferReason: z.string().max(500).nullable().optional(),
  }).strict().nullable().optional(),
}).strict();
const maintenanceOperation = (op, args) => z.object({
  op: z.literal(op), args, leaseToken: z.string().min(1).max(100).optional(),
}).strict();
const maintenanceRequestSchema = z.discriminatedUnion('op', [
  maintenanceOperation('acquire', z.object({ ttlMs: z.number().int().min(1000).max(1800000).optional() }).strict()),
  maintenanceOperation('renew', z.object({ token: z.string().min(1).max(100) }).strict()),
  maintenanceOperation('release', z.object({ token: z.string().min(1).max(100) }).strict()),
  maintenanceOperation('queueDeletionReview',z.object({id:z.string().min(1).max(350),expectedRevision:countSchema}).strict()),
  maintenanceOperation('setHidden', z.object({id:z.string().min(1).max(350),hidden:z.boolean(),expectedRevision:countSchema}).strict()),
  maintenanceOperation('state', z.object({}).strict()),
  maintenanceOperation('verificationBatch',z.object({observedIds:z.array(z.string().min(1).max(350)).max(20000),limit:z.number().int().min(1).max(8).default(8)}).strict()),
  maintenanceOperation('deferVerification',z.object({}).strict()),
  maintenanceOperation('collect', z.object({ projects: z.array(maintenanceProjectSchema).max(10000) }).strict()),
  maintenanceOperation('apply', z.object({ observations: z.array(observationSchema).max(20000), expectedRevision: countSchema,
    mode: z.enum(['recent', 'daily']).default('recent'), coverage: z.string().max(4000).default('') }).strict()),
  maintenanceOperation('begin', z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()),
  maintenanceOperation('batch', z.object({ auditId: z.string().min(1).max(100), limit: z.number().int().min(1).max(100).default(40) }).strict()),
  maintenanceOperation('auditApply', z.object({ auditId: z.string().min(1).max(100), observations: z.array(observationSchema).max(100), expectedRevision: countSchema }).strict()),
  maintenanceOperation('recordRun', z.object({ report: maintenanceReportSchema }).strict()),
  maintenanceOperation('defer', z.object({ auditId: z.string().min(1).max(100), retryAfter: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(500), retryIds: z.array(z.string().min(1).max(350)).max(20000).default([]) }).strict()),
]);

function result(value, textValue = value) {
  return { content: [{ type: 'text', text: JSON.stringify(textValue) }], structuredContent: value };
}

async function guarded(action, summarize) {
  try { const value = await action(); return result(value, summarize ? summarize(value) : value); }
  catch (error) {
    const detail = error instanceof CatalogError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'The catalog operation failed.' };
    // Error results may omit structuredContent. If present, clients validate it
    // against the success schema even when isError is true.
    return { isError: true, content: [{ type: 'text', text: detail.message }], _meta: { error: detail } };
  }
}

export function createOrganizerServer(store, transport = 'stdio', { activityReader = readLocalActivity, recentCollector = collectRecentSources } = {}) {
  const server = new McpServer({ name: 'chat-organizer', version: '0.2.2', icons: SERVER_ICONS }, { capabilities: { logging: {} } });
  for (const [name, uri] of [['organizer', UI_URI], ['organizer-stable', STABLE_UI_URI]]) {
  server.registerResource(name, uri, {
    title: 'Chat Organizer', description: 'A private local catalog for organizing ChatGPT and Codex chats.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetPrefersBorder': true },
  }, async () => ({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: await readFile(new URL('./public/organizer.html', import.meta.url), 'utf8'), _meta: {
    ui: { csp: { connectDomains: [], resourceDomains: [] } },
    'openai/ui': { availableDisplayModes: ['fullscreen', 'inline'] },
    'openai/widgetDescription': 'Chat Organizer: find saved chats, assign categories, and mark priorities.',
  } }] }));
  }

  server.registerTool('open_organizer', {
    title: 'Open Chat Organizer', description: 'Open Chat Organizer and its saved catalog.',
    inputSchema: {}, outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: appMeta,
  }, async () => ({ ...result(store.snapshot(transport)), _meta: appMeta }));

  server.registerTool('get_inventory', {
    title: 'Read organizer inventory', description: 'Read the complete saved catalog. It contains imported titles and references, not chat messages.',
    inputSchema: {}, outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async () => result(store.snapshot(transport)));

  server.registerTool('get_connection_status', {
    title: 'Test organizer connection', description: 'Confirm this organizer service is connected and identify the running instance.',
    inputSchema: {}, outputSchema: connectionOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async () => result({ ok: true, serverName: 'chat-organizer', serverVersion: '0.2.2', instanceId, startedAt, transport, catalogRevision: store.snapshot(transport).revision }));

  server.registerTool('get_maintenance_state', {
    title: 'Read organizer maintenance state', description: 'Read compact catalog counts, synchronization coverage, and the current daily audit progress. Use this before an incremental update instead of printing the full catalog.',
    inputSchema: {}, outputSchema: maintenanceOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async () => guarded(() => store.maintenanceState()));

  server.registerTool('get_maintenance_workflow', {
    title: 'Read the organizer update workflow',
    description: 'Return the complete installed maintenance function. When the user requests an update, evaluate this source in the assistant tool runner and await the function with the supported tools object and {mode:"recent",recentOnly:true}. It uses the organizer service and native app tools. Reading this source does not run it or change the catalog.',
    inputSchema: {},
    outputSchema: z.object({ version: z.literal('0.2.2'), source: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model'] } },
  }, async () => guarded(async () => ({
    version: '0.2.2',
    source: await readFile(new URL('./maintenance-workflow.js', import.meta.url), 'utf8'),
  }), value => ({ version: value.version, message: 'The complete workflow source is in structuredContent.source.' })));

  server.registerTool('maintain_catalog', {
    title: 'Maintain the saved organizer catalog',
    description: 'Execute one bounded operation from the saved organizer maintenance workflow in this organizer service. This uses the service-owned catalog and fixed local metadata sources, so the hosting chat does not need filesystem write access. Acquire a lease before applying synchronization, audit changes, or run reports; preserve current categories, ordering, focus marks, and IDs. Supply only explicit source observations; owner_confirmation is only for an owner-confirmed archive. setHidden removes or restores an exact saved entry only on explicit owner request and survives metadata refresh. queueDeletionReview places an exact available chat in the review list only on explicit owner request. No source conversations are messaged or changed.',
    inputSchema: z.object({ request: maintenanceRequestSchema }).strict(),
    outputSchema: z.object({ value: z.unknown() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ request: { op, args, leaseToken } }) => guarded(async () => {
    if (['apply', 'begin', 'auditApply', 'recordRun', 'defer', 'deferVerification', 'setHidden', 'queueDeletionReview'].includes(op)) store.assertMaintenanceLease(leaseToken);
    const operations = {
      acquire: () => store.acquireMaintenanceLease(args), renew: () => store.renewMaintenanceLease(args),
      release: () => store.releaseMaintenanceLease(args), state: () => store.maintenanceState(),
      verificationBatch:()=>store.recentVerificationBatch(args),deferVerification:()=>store.deferRecentVerification(),
      setHidden: () => store.setHidden(args, transport),
      queueDeletionReview: () => store.queueDeletionReview(args, transport),
      collect: () => recentCollector({ projects: args.projects }), apply: () => store.applySync(args),
      begin: () => store.beginAudit(args), batch: () => store.auditBatch(args),
      auditApply: () => store.applyAuditBatch(args), recordRun: () => store.recordMaintenanceRun(args.report),
      defer: () => store.deferAudit(args),
    };
    return { value: await operations[op]() };
  }));

  server.registerTool('collect_recent_metadata', {
    title: 'Collect recent organizer metadata', description: 'Read the local app metadata index and recent ChatGPT metadata cache. Supply the current list_projects results for project membership resolution. This reads titles and references only; it does not update the organizer. Absence is never deletion evidence. Full observations are in structuredContent; the text response gives counts and coverage.',
    inputSchema: { projects: z.array(currentProjectSchema).max(10000) }, outputSchema: recentOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async args => guarded(() => recentCollector(args), value => ({ observations: value.observations.length, counts: value.counts, errors: value.errors, coverage: value.coverage })));

  server.registerTool('apply_sync_batch', {
    title: 'Apply incremental organizer synchronization', description: 'Apply only explicitly observed source metadata to the saved catalog using its latest revision. A null projectId explicitly removes a project assignment. Preserve user categories, category order, focus marks, and omitted records. Mark not_found only from a conclusive direct lookup or complete project list; transient errors remain verification errors. Confirmed archived entries are hidden. Do not infer deletion from partial recent listings.',
    inputSchema: { observations: z.array(observationSchema).max(20000), expectedRevision: countSchema,
      mode: z.enum(['recent', 'daily']).default('recent'), coverage: z.string().max(4000).default('') }, outputSchema: syncOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => guarded(() => store.applySync(args)));

  server.registerTool('begin_daily_audit', {
    title: 'Begin or resume daily organizer audit', description: 'Begin or resume an audit of saved IDs for the supplied calendar day. Persist progress so interrupted work resumes. Use the user timezone for day. This does not probe or change source chats.',
    inputSchema: { day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, outputSchema: auditOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => guarded(() => store.beginAudit(args)));

  server.registerTool('get_audit_batch', {
    title: 'Read next organizer audit batch', description: 'Read the next saved IDs to verify. Retrieve titles and status by stable ID with read-only source tools. A failed request is an error unless the source explicitly reports not found. Full IDs are in structuredContent; text gives progress counts.',
    inputSchema: { auditId: z.string().min(1).max(100), limit: z.number().int().min(1).max(100).default(40) },
    outputSchema: z.object({ audit: auditOutputSchema, items: z.array(auditItemSchema) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async args => guarded(() => store.auditBatch(args), value => ({ audit: value.audit, items: value.items.length })));

  server.registerTool('apply_audit_batch', {
    title: 'Save organizer audit observations', description: 'Apply explicit read-only lookup results and checkpoint the daily audit. Preserve current organization and avoid overwriting newer metadata. Use error for transient failures; use not_found only for an explicit missing response. Archived records remain stored and hidden.',
    inputSchema: { auditId: z.string().min(1).max(100), observations: z.array(observationSchema).max(100), expectedRevision: countSchema },
    outputSchema: z.object({ sync: syncOutputSchema, audit: auditOutputSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => guarded(() => store.applyAuditBatch(args)));

  server.registerTool('set_item_category', {
    title: 'Set organizer category', description: 'Save one item category using the revision from the latest catalog snapshot. Refresh after a stale-revision error.',
    inputSchema: { id: z.string().min(1).max(350), category: z.string().min(1).max(350), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.setCategory(args, transport)));

  server.registerTool('resolve_deletion_review', {
    title:'Resolve a potentially deleted chat',
    description:'Resolve an owner-reviewed organizer entry. Restore returns it to its saved category and resets failed checks. Confirm deleted removes the entry from the organizer using an owner-hidden preference; it does not delete a source conversation or invent source deletion evidence.',
    inputSchema:{id:z.string().min(1).max(350),action:z.enum(['restore','confirm_deleted']),expectedRevision:countSchema},
    outputSchema:snapshotOutputSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{visibility:['model','app']}},
  },async args=>guarded(()=>store.resolveDeletionReview(args,transport)));

  server.registerTool('set_item_focus', {
    title: 'Set organizer chat focus', description: 'Save or remove one chat focus mark using an explicit true or false value and the latest catalog revision. This organizer setting preserves source activity dates, categories, and deletion undo. Projects cannot be marked directly. Refresh after a stale-revision error.',
    inputSchema: { id: z.string().min(1).max(350), focused: z.boolean(), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.setFocus(args, transport)));

  server.registerTool('refresh_local_activity', {
    title: 'Refresh local organizer activity', description: 'Read current titles and source update dates for local app chats already in the organizer. Keep assignments, project membership, links, and unavailable records. Web chat dates need an assistant refresh. Metadata changes preserve category deletion undo. Refresh again after a stale-revision error.',
    inputSchema: { expectedRevision: z.number().int().nonnegative() },
    outputSchema: activityRefreshOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(async () => {
    const initial = store.snapshot(transport);
    if (initial.revision !== args.expectedRevision) throw new CatalogError('STALE_REVISION', 'The catalog changed. Refresh it before updating activity.');
    const activity = await activityReader(initial.items);
    return store.refreshLocalActivity({ ...activity, expectedRevision: args.expectedRevision }, transport);
  }));

  server.registerTool('reorder_categories', {
    title: 'Reorder organizer categories', description: 'Save the display order of every top-level category. Provide each root category ID exactly once, including Uncategorized and Trash. Nested category order and item assignments are preserved. A changed order clears the previous deletion undo; an identical order changes nothing.',
    inputSchema: { ids: z.array(z.string().min(1).max(350)), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.reorderCategories(args, transport)));

  server.registerTool('create_category_path', {
    title: 'Add organizer categories', description: 'Create a new category path atomically beneath an existing parent, or at the root with parentId null. Use one to three new names; the total depth cannot exceed three. Duplicate sibling names are rejected. Any successful change clears the previous deletion undo.',
    inputSchema: { parentId: z.string().min(1).max(350).nullable(), names: z.array(z.string().min(1).max(120)).min(1).max(3), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.createCategoryPath(args, transport)));

  server.registerTool('rename_category', {
    title: 'Rename organizer category', description: 'Rename one category without changing its ID, contents, or descendants. Duplicate sibling names and renaming the permanent Uncategorized or Trash categories are rejected. Any successful change clears the previous deletion undo.',
    inputSchema: { id: z.string().min(1).max(350), name: z.string().min(1).max(120), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.renameCategory(args, transport)));

  server.registerTool('delete_category', {
    title: 'Delete organizer category branch', description: 'Delete a category and all nested subcategories, moving all their items to Uncategorized. The permanent Uncategorized and Trash categories cannot be deleted. Original chats and projects remain intact. The latest deletion can be undone until the next category change or inventory import. Activity refresh and focus changes preserve undo.',
    inputSchema: { id: z.string().min(1).max(350), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.deleteCategory(args, transport)));

  server.registerTool('undo_delete_category', {
    title: 'Undo organizer category deletion', description: 'Restore the latest deleted category branch and its original item assignments using the undo token from the current snapshot. Undo persists across reloads, activity refreshes, and focus changes, but expires after a category change or inventory import.',
    inputSchema: { token: z.string().min(1).max(100), expectedRevision: z.number().int().nonnegative() },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async args => guarded(() => store.undoDeleteCategory(args, transport)));

  server.registerTool('import_inventory', {
    title: 'Import organizer inventory', description: 'Import user-authorized chat and project metadata. Preserve saved categories and local focus marks, retain items omitted from partial listings, and keep the newest source updatedAt. A refresh does not count as chat activity. IDs must be source:kind:sourceId.',
    inputSchema: {
      items: z.array(z.object({ id: z.string(), source: z.enum(['chatgpt', 'codex']), sourceId: z.string(), title: z.string(), kind: z.enum(['chat', 'project']), webConversationId:z.string().uuid().nullable().optional(), chatgptProjectId:z.string().regex(/^g-p-[a-f0-9]{32}$/i).nullable().optional(), projectId: z.string().nullable().optional(), hostId: z.string().optional(), url: z.string().optional(), updatedAt: z.string().optional() })).max(20000),
      coverage: z.string().min(1).max(2000),
    },
    outputSchema: snapshotOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => guarded(() => store.importInventory(args, transport)));
  return server;
}

export async function startHttpServer(store, port = 43187) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port.');
  const listener = createServer(async (req, res) => {
    const allowedHosts = new Set([`127.0.0.1:${listener.address().port}`, `localhost:${listener.address().port}`, `[::1]:${listener.address().port}`]);
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(403).end('Forbidden'); return; }
    const origin = req.headers.origin;
    if (origin) {
      let parsed;
      try { parsed = new URL(origin); } catch { res.writeHead(403).end('Forbidden'); return; }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.port !== String(listener.address().port) || parsed.protocol !== 'http:') { res.writeHead(403).end('Forbidden'); return; }
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, server: 'chat-organizer', version: '0.2.2' })); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end('Not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end('Method not allowed'); return; }
    const server = createOrganizerServer(store, 'http');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  return listener;
}

async function main() {
  const store = new CatalogStore(defaultDatabasePath());
  if (process.argv.includes('--http')) {
    const rawPort = process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? '43187';
    const listener = await startHttpServer(store, Number(rawPort));
    process.stderr.write(`Chat Organizer listening on loopback port ${listener.address().port}.\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => listener.close(() => { store.close(); process.exit(0); }));
  } else {
    const server = createOrganizerServer(store, 'stdio');
    await server.connect(new StdioServerTransport());
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); store.close(); process.exit(0); });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { process.stderr.write(error instanceof CatalogError ? `${error.message}\n` : 'Chat Organizer could not start.\n'); process.exitCode = 1; });
}
