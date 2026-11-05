import { CoreApiClient } from 'twenty-client-sdk/core';

import { normalizeEmail } from 'src/lib/queries';
import { withRateLimit } from 'src/lib/twenty-errors';

export type ActivityValues = {
  posthogLastSeenAt: string | null; // ISO 8601
  posthogLastPage: string | null; // URL; a stored '' reads as null
  posthogPageviews30d: number | null;
  posthogProfile: string | null; // URL; a stored '' reads as null
};

// Brand for D-TCA-22's "only ids read in the same run": only the two readers below create one.
declare const readThisRun: unique symbol;
export type PersonSnapshot = ActivityValues & {
  readonly [readThisRun]: true;
  id: string;
  email: string | null; // trimmed, lowercased primaryEmail; null when blank
};

const EMAIL_BATCH = 50;
const PAGE_SIZE = 100;

const SELECTION = {
  id: true,
  emails: { primaryEmail: true },
  posthogLastSeenAt: true,
  posthogPageviews30d: true,
  posthogLastPage: { primaryLinkUrl: true },
  posthogProfile: { primaryLinkUrl: true },
};

type Link = { primaryLinkUrl: string | null } | null;
type PersonNode = {
  id: string;
  emails: { primaryEmail: string | null } | null;
  posthogLastSeenAt: string | null;
  posthogPageviews30d: number | null;
  posthogLastPage: Link;
  posthogProfile: Link;
};
type PeoplePage = {
  people: {
    edges: { node: PersonNode }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

// A cleared LINKS field reads back as ''.
export const linkUrl = (url: string | null | undefined): string | null => url || null;

const toSnapshot = (node: PersonNode): PersonSnapshot =>
  ({
    id: node.id,
    email: normalizeEmail(node.emails?.primaryEmail) || null,
    posthogLastSeenAt: node.posthogLastSeenAt ?? null,
    posthogPageviews30d: node.posthogPageviews30d ?? null,
    posthogLastPage: linkUrl(node.posthogLastPage?.primaryLinkUrl),
    posthogProfile: linkUrl(node.posthogProfile?.primaryLinkUrl),
  }) as PersonSnapshot;

// Reads every page of people matching `filter`, one request per page.
const readPeople = async (client: CoreApiClient, filter: unknown): Promise<PersonSnapshot[]> => {
  const snapshots: PersonSnapshot[] = [];
  let after: string | undefined;
  do {
    const args = after === undefined ? { filter, first: PAGE_SIZE } : { filter, first: PAGE_SIZE, after };
    const data: PeoplePage = await withRateLimit(() =>
      client.query({
        people: {
          __args: args,
          edges: { node: SELECTION },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    snapshots.push(...data.people.edges.map((edge) => toSnapshot(edge.node)));
    const { hasNextPage, endCursor } = data.people.pageInfo;
    after = hasNextPage && endCursor ? endCursor : undefined;
  } while (after !== undefined);
  return snapshots;
};

// Appends a snapshot to its email's group; callers skip a null email first.
export const addByEmail = (groups: Map<string, PersonSnapshot[]>, snapshot: PersonSnapshot): void => {
  const group = groups.get(snapshot.email as string);
  if (group) group.push(snapshot);
  else groups.set(snapshot.email as string, [snapshot]);
};

// `primaryEmail.in` is case-sensitive, so match with escaped ilike, then keep exact matches only.
export const findPeopleByEmails = async (
  emails: string[],
): Promise<Map<string, PersonSnapshot[]>> => {
  const wanted = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  const wantedSet = new Set(wanted);
  const matches = new Map<string, PersonSnapshot[]>();
  if (wanted.length === 0) return matches;

  const client = new CoreApiClient();
  for (let i = 0; i < wanted.length; i += EMAIL_BATCH) {
    const batch = wanted.slice(i, i + EMAIL_BATCH);
    const filter = { or: batch.map((e) => ({ emails: { primaryEmail: { ilike: escapeLike(e) } } })) };
    for (const snapshot of await readPeople(client, filter)) {
      if (snapshot.email !== null && wantedSet.has(snapshot.email)) addByEmail(matches, snapshot);
    }
  }
  return matches;
};

export const findRecentlySeenPeople = async (since: Date): Promise<PersonSnapshot[]> =>
  readPeople(new CoreApiClient(), { posthogLastSeenAt: { gte: since.toISOString() } });
