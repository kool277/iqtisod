import { readRosterDoc, rosterHash, type RosterDoc } from '../../crypto/roster'
import type { SqlDatabase } from '../../db/sqlite'
import { parseJsonSafely } from '../../lib/safe-json'
import { rosterTailDocs } from './session'

/**
 * The roster versions this browser kept for a vault (design 4.10), compared with a vault's own chain by hash: a copy is
 * behind what this browser saw when it is older, or when it forked from it (the same version numbers, signed
 * differently), however high its own numbers go.
 */

export type KeptTail = { docs: RosterDoc[]; hashes: Map<number, string> }

function parsed(text: string): unknown {
  try {
    return parseJsonSafely(text, { maxChars: 262_144 })
  } catch {
    return undefined
  }
}

/** The kept versions of this vault in order, with their hashes; empty when none are kept, or any is unreadable or missing. */
export async function keptTail(vaultId: string): Promise<KeptTail> {
  const docs: RosterDoc[] = []
  for (const text of rosterTailDocs(vaultId)) {
    const doc = readRosterDoc(parsed(text))
    if (!doc || doc.vaultId !== vaultId) return { docs: [], hashes: new Map() }
    docs.push(doc)
  }
  docs.sort((left, right) => left.version - right.version)
  if (docs.some((doc, index) => index > 0 && doc.version !== docs[index - 1].version + 1)) return { docs: [], hashes: new Map() }
  const hashes = new Map<number, string>()
  for (const doc of docs) hashes.set(doc.version, await rosterHash(doc))
  return { docs, hashes }
}

/** A vault's roster hashes by version, as checked against each version when its chain was read. */
export function chainHashes(db: SqlDatabase): Map<number, string> {
  return new Map(db.query('SELECT version, hash FROM roster_versions').map((row) => [Number(row.version), String(row.hash)]))
}

/**
 * Where a chain ending at `latest` stands against what this browser saw: not behind, or behind with the newest
 * version both share (`common`), which is null when the kept versions cannot show one.
 */
export function tailPosition(latest: number, hashes: ReadonlyMap<number, string>, tail: KeptTail, seen: number): { behind: false } | { behind: true; common: number | null } {
  const forked = tail.docs.some((doc) => doc.version <= latest && hashes.get(doc.version) !== tail.hashes.get(doc.version))
  const newest = tail.docs.at(-1)?.version ?? 0
  if (!forked && seen <= latest && newest <= latest) return { behind: false }
  // The newest version this chain shares with the kept one: equal hashes, or the kept version after it links to it.
  for (let version = Math.min(latest, newest); version >= 1; version -= 1) {
    if (tail.hashes.has(version)) {
      if (tail.hashes.get(version) === hashes.get(version)) return { behind: true, common: version }
      continue
    }
    const next = tail.docs.find((doc) => doc.version === version + 1)
    return { behind: true, common: next && next.prev === hashes.get(version) ? version : null }
  }
  return { behind: true, common: null }
}
