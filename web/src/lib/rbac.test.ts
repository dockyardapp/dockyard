import { describe, expect, it } from 'vitest';
import { atLeast, can, roleRank } from './rbac';

/**
 * The role ladder is the product's permission model, so every rung is pinned
 * here: viewer reads, operator writes but never deletes, admin does everything.
 */
describe('atLeast', () => {
  it('orders viewer below operator below admin', () => {
    expect(roleRank('viewer')).toBeLessThan(roleRank('operator'));
    expect(roleRank('operator')).toBeLessThan(roleRank('admin'));
  });

  it('is inclusive of the required role itself', () => {
    expect(atLeast('operator', 'operator')).toBe(true);
    expect(atLeast('admin', 'admin')).toBe(true);
    expect(atLeast('viewer', 'viewer')).toBe(true);
  });

  it('refuses a role below the requirement', () => {
    expect(atLeast('viewer', 'operator')).toBe(false);
    expect(atLeast('viewer', 'admin')).toBe(false);
    expect(atLeast('operator', 'admin')).toBe(false);
  });

  it('refuses when there is no role at all, so a signed-out render cannot write', () => {
    expect(atLeast(null, 'viewer')).toBe(false);
    expect(atLeast(undefined, 'viewer')).toBe(false);
    expect(atLeast(null, 'operator')).toBe(false);
  });
});

describe('can', () => {
  it('lets viewer read but not write or destroy', () => {
    expect(can.write('viewer')).toBe(false);
    expect(can.destroy('viewer')).toBe(false);
    expect(can.manageUsers('viewer')).toBe(false);
    expect(can.manageSettings('viewer')).toBe(false);
    expect(can.viewAudit('viewer')).toBe(false);
  });

  it('lets operator write but never destroy', () => {
    expect(can.write('operator')).toBe(true);
    expect(can.destroy('operator')).toBe(false);
    expect(can.manageUsers('operator')).toBe(false);
    expect(can.manageSettings('operator')).toBe(false);
    expect(can.viewAudit('operator')).toBe(false);
  });

  it('lets admin do everything', () => {
    expect(can.write('admin')).toBe(true);
    expect(can.destroy('admin')).toBe(true);
    expect(can.manageUsers('admin')).toBe(true);
    expect(can.manageSettings('admin')).toBe(true);
    expect(can.viewAudit('admin')).toBe(true);
  });

  it('denies every capability when signed out', () => {
    for (const check of Object.values(can)) {
      expect(check(null)).toBe(false);
      expect(check(undefined)).toBe(false);
    }
  });
});
