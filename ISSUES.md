1. ~~`src/ipfs-client.ts:374-401` — `MockIpfsClient.extractContent()` returns the raw DAG-PB `node.Data` (UnixFS protobuf) and never follows file links, so `cat()` will yield UnixFS metadata instead of the actual file bytes for UnixFS file nodes created by `@ipld/unixfs`, and it will return empty data for chunked files referenced by links. This breaks manifest/chunk retrieval once CARs are built with real UnixFS file nodes.~~

   **RESOLVED:** `extractContent()` now uses `decode()` from `@ipld/unixfs` to properly parse UnixFS file nodes. It handles:
   - SimpleFile (inline data in `node.content`)
   - AdvancedFile (data spread across linked chunks via `node.parts`)
   - ComplexFile (inline data + linked chunks)
   - Fallback for `@ipld/unixfs` v3.0.0 decode bug with AdvancedFile

   Tests added: 5 new tests for UnixFS file node handling (inline, chunked, nested path, missing link, empty file).
