import { CoreApiClient } from 'twenty-client-sdk/core';

import { linkUrl, type ActivityValues, type PersonSnapshot } from 'src/lib/match-people';
import { withRateLimit } from 'src/lib/twenty-errors';

// Write method and LINKS shapes: D-TCA-22-posthog-api-shapes. Payload: D-TCA-27-shared-write-lease.
export type ActivityChange = { snapshot: PersonSnapshot; next: Partial<ActivityValues> };

const WRITE_BATCH = 200;

const KEYS = [
  'posthogLastSeenAt',
  'posthogLastPage',
  'posthogPageviews30d',
  'posthogProfile',
] as const satisfies readonly (keyof ActivityValues)[];

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

const isSame = (key: keyof ActivityValues, a: unknown, b: unknown): boolean => {
  if (key === 'posthogLastSeenAt') return sameInstant(a as string | null, b as string | null);
  if (key === 'posthogLastPage' || key === 'posthogProfile') {
    return linkUrl(a as string | null) === linkUrl(b as string | null);
  }
  return a === b;
};

// Twenty ignores null on a LINKS field and replaces the composite whole, so always send all of it.
const link = (value: string | null, label: string) => {
  const target = linkUrl(value);
  return target === null
    ? { primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] }
    : { primaryLinkUrl: target, primaryLinkLabel: label, secondaryLinks: [] };
};

const toRecord = ({ snapshot, next }: ActivityChange) => {
  const pick = <K extends keyof ActivityValues>(key: K): ActivityValues[K] =>
    next[key] !== undefined ? (next[key] as ActivityValues[K]) : snapshot[key];
  return {
    id: snapshot.id,
    posthogLastSeenAt: pick('posthogLastSeenAt'),
    posthogPageviews30d: pick('posthogPageviews30d'),
    posthogLastPage: link(pick('posthogLastPage'), ''),
    posthogProfile: link(pick('posthogProfile'), 'PostHog'),
  };
};

const hasChange = ({ snapshot, next }: ActivityChange): boolean =>
  KEYS.some((key) => next[key] !== undefined && !isSame(key, snapshot[key], next[key]));

export const writeActivity = async (
  changes: ActivityChange[],
): Promise<{ written: number; unchanged: number }> => {
  const records = changes.filter(hasChange).map(toRecord);
  if (records.length > 0) {
    const client = new CoreApiClient();
    for (let i = 0; i < records.length; i += WRITE_BATCH) {
      const data = records.slice(i, i + WRITE_BATCH);
      await withRateLimit(() =>
        client.mutation({ createPeople: { __args: { data, upsert: true }, id: true } }),
      );
    }
  }
  return { written: records.length, unchanged: changes.length - records.length };
};

export const clearActivity = (): ActivityValues => ({
  posthogLastSeenAt: null,
  posthogLastPage: null,
  posthogPageviews30d: null,
  posthogProfile: null,
});
