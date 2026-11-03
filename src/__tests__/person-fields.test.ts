// TCA-25 red-phase tests: Person PostHog fields, "Recently active people" view, sidebar item.
//
// External facts (no DB tables involved; this is Twenty app metadata):
//  - Field types per docs/prd/posthog-activity-sync.md: posthogLastSeenAt DATE_TIME,
//    posthogLastPage LINKS, posthogPageviews30d NUMBER, posthogProfile LINKS.
//  - SDK 2.54.3 view filter = { universalIdentifier, fieldMetadataUniversalIdentifier, operand, value };
//    view sort = { universalIdentifier, fieldMetadataUniversalIdentifier, direction }; `key` is ignored.
//  - Nav item = { type: VIEW, viewUniversalIdentifier }.
//
// Pinned contract for /implement (files default-export defineField/defineView/defineNavigationMenuItem):
//  src/fields/person-posthog-{last-seen-at,last-page,pageviews-30d,profile}.field.ts
//  src/views/recently-active-people.view.ts
//  src/navigation-menu-items/recently-active-people.navigation-menu-item.ts
//  constants (src/constants/universal-identifiers.ts): see CONSTANT_NAMES below.
//
// Implementation modules are loaded at runtime by absolute path so this file
// compiles before they exist.
import { resolve } from 'node:path';

import {
  FieldType,
  NavigationMenuItemType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
} from 'twenty-sdk/define';
import { describe, expect, it } from 'vitest';

import * as ids from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const load = async (relPath: string) =>
  (await import(/* @vite-ignore */ resolve(process.cwd(), relPath))).default;

const FIELDS = [
  {
    name: 'posthogLastSeenAt',
    type: FieldType.DATE_TIME,
    file: 'src/fields/person-posthog-last-seen-at.field.ts',
    id: 'PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER',
  },
  {
    name: 'posthogLastPage',
    type: FieldType.LINKS,
    file: 'src/fields/person-posthog-last-page.field.ts',
    id: 'PERSON_POSTHOG_LAST_PAGE_FIELD_UNIVERSAL_IDENTIFIER',
  },
  {
    name: 'posthogPageviews30d',
    type: FieldType.NUMBER,
    file: 'src/fields/person-posthog-pageviews-30d.field.ts',
    id: 'PERSON_POSTHOG_PAGEVIEWS_30D_FIELD_UNIVERSAL_IDENTIFIER',
  },
  {
    name: 'posthogProfile',
    type: FieldType.LINKS,
    file: 'src/fields/person-posthog-profile.field.ts',
    id: 'PERSON_POSTHOG_PROFILE_FIELD_UNIVERSAL_IDENTIFIER',
  },
] as const;

const VIEW_FILE = 'src/views/recently-active-people.view.ts';
const NAV_FILE = 'src/navigation-menu-items/recently-active-people.navigation-menu-item.ts';
const VIEW_ID = 'RECENTLY_ACTIVE_PEOPLE_VIEW_UNIVERSAL_IDENTIFIER';
const NAV_ID = 'RECENTLY_ACTIVE_PEOPLE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER';

const constants = ids as Record<string, string>;

describe('TCA-25 contract for TCA-27 and TCA-32', () => {
  it('exports the four field identifiers, the view and the nav item under their exact names, each a distinct UUID v4', async () => {
    const names = [...FIELDS.map((f) => f.id), VIEW_ID, NAV_ID];
    for (const n of names) expect(constants[n], n).toMatch(UUID_V4);
    expect(new Set(names.map((n) => constants[n])).size).toBe(names.length);

    for (const f of FIELDS) {
      const field = await load(f.file);
      expect(field.config.name).toBe(f.name);
      expect(field.config.universalIdentifier).toBe(constants[f.id]);
    }
    expect((await load(VIEW_FILE)).config.name).toBe('Recently active people');
    expect((await load(VIEW_FILE)).config.universalIdentifier).toBe(constants[VIEW_ID]);
  });
});

describe('Person PostHog fields', () => {
  it('has the four exact names and types', async () => {
    const actual = await Promise.all(
      FIELDS.map(async (f) => {
        const { config } = await load(f.file);
        return { name: config.name, type: config.type };
      }),
    );
    expect(actual).toEqual(FIELDS.map((f) => ({ name: f.name, type: f.type })));
  });

  it('targets Person, is nullable and is not audit-logged, for every field', async () => {
    for (const f of FIELDS) {
      const { config } = await load(f.file);
      expect(config.objectUniversalIdentifier, f.name).toBe(PERSON.universalIdentifier);
      expect(config.isNullable, f.name).toBe(true);
      expect(config.isAuditLogged, f.name).toBe(false);
    }
  });
});

describe('Recently active people view', () => {
  it('filters on posthogLastSeenAt IS_NOT_EMPTY and sorts on it DESC, without a deprecated key', async () => {
    const { config } = await load(VIEW_FILE);
    const lastSeen = constants['PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER'];
    expect(config.objectUniversalIdentifier).toBe(PERSON.universalIdentifier);
    expect(config.key).toBeUndefined();

    expect(config.filters).toHaveLength(1);
    expect(config.filters[0]).toMatchObject({
      fieldMetadataUniversalIdentifier: lastSeen,
      operand: ViewFilterOperand.IS_NOT_EMPTY,
    });
    expect(config.filters[0].universalIdentifier).toMatch(UUID_V4);

    expect(config.sorts).toHaveLength(1);
    expect(config.sorts[0]).toMatchObject({
      fieldMetadataUniversalIdentifier: lastSeen,
      direction: ViewSortDirection.DESC,
    });
    expect(config.sorts[0].universalIdentifier).toMatch(UUID_V4);
  });

  it('shows name, emails and the four PostHog fields as visible columns', async () => {
    const { config } = await load(VIEW_FILE);
    const shown = config.fields
      .filter((f: { isVisible?: boolean }) => f.isVisible !== false)
      .map((f: { fieldMetadataUniversalIdentifier: string }) => f.fieldMetadataUniversalIdentifier);
    expect(shown).toEqual([
      PERSON.fields.name.universalIdentifier,
      PERSON.fields.emails.universalIdentifier,
      ...FIELDS.map((f) => constants[f.id]),
    ]);
    const viewFieldIds = config.fields.map((f: { universalIdentifier: string }) => f.universalIdentifier);
    expect(new Set(viewFieldIds).size).toBe(viewFieldIds.length);
    for (const id of viewFieldIds) expect(id).toMatch(UUID_V4);
  });
});

describe('Recently active people sidebar item', () => {
  it('is a VIEW item pointing at the Recently active people view', async () => {
    const { config } = await load(NAV_FILE);
    expect(config.type).toBe(NavigationMenuItemType.VIEW);
    expect(config.viewUniversalIdentifier).toBe(constants[VIEW_ID]);
    expect(config.universalIdentifier).toBe(constants[NAV_ID]);
  });
});
