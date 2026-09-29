import { useMemo } from 'react'
import { usePeriod } from '../../context/PeriodContext'
import { useVault } from '../../context/VaultContext'
import type { GroupSummaryReport } from '../../domain/group-summary'
import { Permission, canUser } from '../../rbac'
import { loadGroupSummaries } from '../../services/group-summary.service'

/** Group totals for the shared period; recomputed whenever the vault changes. `null` without dashboard access. */
export function useGroupSummaries(): GroupSummaryReport | null {
  const { user, query, revision } = useVault()
  const { range } = usePeriod()
  const allowed = Boolean(user && canUser(user, Permission.READ_DASHBOARD))
  return useMemo(
    () => (allowed ? query((vault) => loadGroupSummaries(vault, range)) : null),
    [allowed, query, range, revision],
  )
}
