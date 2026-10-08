/** Role ladder helpers. viewer (read) < operator (write, no delete) < admin. */

import type { UserRole } from '../api/types';

const RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export function atLeast(role: UserRole | null | undefined, min: UserRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[min];
}

export const can = {
  /** Start/stop/create/pull/deploy. operator and up. */
  write: (role: UserRole | null | undefined) => atLeast(role, 'operator'),
  /** Delete/remove/prune. admin only. */
  destroy: (role: UserRole | null | undefined) => atLeast(role, 'admin'),
  manageUsers: (role: UserRole | null | undefined) => atLeast(role, 'admin'),
  manageSettings: (role: UserRole | null | undefined) => atLeast(role, 'admin'),
  viewAudit: (role: UserRole | null | undefined) => atLeast(role, 'admin'),
  /**
   * Run commands inside a container. Not conferred by the role ladder: exec is
   * root-equivalent on a host with the Docker socket mounted, so it needs the
   * explicit `can_exec` flag. Admins always may.
   */
  exec: (role: UserRole | null | undefined, canExec?: boolean | null) =>
    role === 'admin' || (role === 'operator' && canExec === true),
};

export function roleRank(role: UserRole): number {
  return RANK[role];
}
