import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROLE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import defaultRole from 'src/default-role';

const { config } = defaultRole;
const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier;

describe('default function role', () => {
  it('is defined under the constants-file identifier and passes validation', () => {
    expect(config.universalIdentifier).toBe(DEFAULT_ROLE_UNIVERSAL_IDENTIFIER);
    expect(defaultRole.errors).toEqual([]);
    expect(defaultRole.success).toBe(true);
  });

  // Twenty Cloud treats a role assignable to members or API keys as a custom
  // role (Organization plan only), so the app install would be refused.
  it('is not assignable to workspace members or API keys', () => {
    expect(config.canBeAssignedToUsers).toBe(false);
    expect(config.canBeAssignedToApiKeys).toBe(false);
  });
});

describe('least privilege (marketplace review)', () => {
  it('grants nothing workspace-wide', () => {
    expect(config.canReadAllObjectRecords).toBe(false);
    expect(config.canUpdateAllObjectRecords).toBe(false);
    expect(config.canSoftDeleteAllObjectRecords).toBe(false);
    expect(config.canDestroyAllObjectRecords).toBe(false);
  });

  it('reads and updates People only, never deleting', () => {
    expect(config.objectPermissions).toHaveLength(1);
    expect(config.objectPermissions?.[0]).toMatchObject({
      objectUniversalIdentifier: PERSON,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    });
  });

  it('requests no system permission flags', () => {
    expect(config.permissionFlagUniversalIdentifiers ?? []).toEqual([]);
  });
});
