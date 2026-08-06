# Database schema changes

Persistent schema changes must use the versioned migration chain.

1. Increment `DATABASE_SCHEMA_VERSION` in `DatabaseLifecycle.ts` by exactly one.
2. Append one migration with that version to `DatabaseMigrations.ts`.
3. Give the migration a stable name and a new checksum string.
4. Update the Prisma schema so new databases already contain the final structure.
5. Add an upgrade assertion to `database-lifecycle-test.mjs`.

Released migrations are immutable. Do not edit their SQL, name, or checksum. Add a
new migration to correct an earlier one. The runner creates a consistent SQLite
snapshot before the first pending migration, runs every migration in its own
transaction, and advances `PRAGMA user_version` only in the same transaction.

Version 0 is the only reset boundary. It represents development databases made
before this migration chain existed. Such a database is archived and recreated.
Versions 1 and later must always upgrade in place. A newer database is never
opened or reset by an older application build.
