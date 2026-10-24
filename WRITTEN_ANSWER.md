# Written Answer

1. Every formula change is stored as a new row, so history is the source of truth rather than an afterthought.
2. Old previews and invoices can be explained with the exact version used, and rollback is a safe copy-forward operation.
3. Insert-only writes avoid destructive edits, so an audit trail cannot be lost through an accidental `UPDATE` or `DELETE`.
4. The cost is storage growth: every edit adds a full formula row, and every preview adds one run-log row per evaluated formula.
5. The current-version view also has more rows to inspect as history grows, and every insert must maintain the indexes.
6. To keep the table fast after millions of versions, current-row lookup uses the unique `(uuid, version)` index and the `(uuid, id)` access path.
7. History and audit queries are indexed by UUID and time, while run-log reports use `(formula_uuid, inserted_at)` and `(inserted_at, status)`.
8. The current-state view should remain a small, index-friendly projection; a materialized current table can be added if reads outgrow it.
9. Old run logs can be partitioned by month and archived to cheaper storage without deleting business history.
10. Precomputed daily aggregates can serve the seven-day reports without scanning every run row.
11. Write batches stay bounded through 500-row log chunks and controlled concurrency.
12. Monitor slow queries and index usage, and add covering indexes only where real query plans justify them.
