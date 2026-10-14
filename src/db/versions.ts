export const SCHEMA_VERSION = 4
export const RECORD_VERSION = 2
export const BACKUP_VERSION = 2
export const EXPORT_FORMAT_VERSION = 1

/**
 * Vaults upgraded to per-person keys (2.0). They live beside the 1.6 track above, which stays the default for
 * vaults that have not been upgraded, so a 1.6 vault keeps its schema, record and backup versions until the
 * founder upgrades it.
 */
export const KEYS_SCHEMA_VERSION = 5
export const KEYS_RECORD_VERSION = 3
export const KEYS_BACKUP_VERSION = 3
