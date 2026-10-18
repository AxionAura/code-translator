// WS F support: sync-to-async classification for module mappings
// (docs/dependency-mapping.md §6). `sync-to-async` marks modules whose target API
// is asynchronous-only (requests -> fetch) and triggers the call-graph propagation.
export type SyncAsync = "sync-to-sync" | "sync-to-async";

export function isAsyncBoundary(mapping: { readonly syncAsync: SyncAsync }): boolean {
  return mapping.syncAsync === "sync-to-async";
}
