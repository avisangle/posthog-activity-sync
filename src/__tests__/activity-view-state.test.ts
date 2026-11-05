// TCA-31 red-phase tests: Product activity widget. Every displayed outcome is decided by pure
// functions in src/lib/activity-view-state.ts; the .tsx only renders the returned state.
//
// External facts (no DB tables; Twenty metadata and the TCA-28 route only):
//  - ActivityResponse / ActivityEvent: src/lib/activity.ts (TCA-28). The route always answers
//    HTTP 200 with a `status`; the widget maps `status`, never HTTP codes (TCA-20 "Route errors").
//    Route messages are fixed there and in the PRD's Edge Cases table; the widget shows them as is.
//  - RestApiClient (twenty-client-sdk/rest) throws RestApiClientError on non-2xx and rejects when
//    the AbortSignal fires, so a client-side failure never carries a route `status`.
//  - twenty-sdk 2.54.3: definePageLayoutWidget(...) returns { success, config, errors };
//    config = { universalIdentifier, pageLayoutTabUniversalIdentifier, title, type: WidgetType,
//    objectUniversalIdentifier, position, heightBehavior,
//    configuration: { configurationType: 'FRONT_COMPONENT', frontComponentUniversalIdentifier } }.
//    Person Home tab: STANDARD_PAGE_LAYOUT.personRecordPage.tabs.home.universalIdentifier.
//
// The issue asks for "every table row" but carries no table. This is the table, derived from the
// route's statuses (TCA-28) and the PRD Edge Cases rows; nothing below invents user-facing copy:
//
//  | input                                   | ViewState                                        |
//  | --------------------------------------- | ------------------------------------------------ |
//  | personId null (not exactly one id)      | { kind: 'hidden' }                               |
//  | request loading                         | { kind: 'loading' }                              |
//  | ok, events non-empty                    | { kind: 'events', events (+relativeTime), profileUrl } |
//  | ok, events empty                        | { kind: 'empty', 'No PostHog activity for this email' } |
//  | not_configured / no_email / no_activity | { kind: 'empty', message: route message }        |
//  | rate_limited / timeout / error          | { kind: 'error', message: route message } (Try again) |
//  | client: aborted at 8 s                  | { kind: 'error', 'PostHog took too long, try again' } |
//  | client: any other throw                 | { kind: 'error', 'Could not load PostHog activity' }  |
//
// Pinned contract for /implement:
//  src/lib/activity-view-state.ts exports
//    ACTIVITY_REQUEST_TIMEOUT_MS = 8_000
//    selectedPersonId(ids: string[]): string | null         -- the id only when exactly one
//    formatRelativeTime(iso: string, now: Date): string
//    toViewState(personId: string | null, request: ActivityRequest, now: Date): ActivityViewState
//    types ActivityRequest =
//      | { phase: 'loading' } | { phase: 'loaded'; response: ActivityResponse }
//      | { phase: 'failed'; timedOut: boolean }
//    and ActivityViewState (the ViewState column above).
//  src/page-layouts/product-activity.widget.ts default-exports definePageLayoutWidget(...).
//  src/front-components/product-activity.tsx default-exports defineFrontComponent(...).
//  constants: PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
//             PRODUCT_ACTIVITY_WIDGET_UNIVERSAL_IDENTIFIER.
//
// New modules are loaded at runtime by absolute path so this file runs before they exist.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PageLayoutTabLayoutMode,
  PageLayoutWidgetVerticalListHeightBehavior,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  STANDARD_PAGE_LAYOUT,
  WidgetType,
} from 'twenty-sdk/define';
import { describe, expect, it } from 'vitest';

import * as ids from 'src/constants/universal-identifiers';
import type { ActivityResponse } from 'src/lib/activity';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERSON_ID = '6f1c2d3e-4a5b-4c6d-8e7f-901234567890';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const LIB = 'src/lib/activity-view-state.ts';
const WIDGET_FILE = 'src/page-layouts/product-activity.widget.ts';
const COMPONENT_FILE = 'src/front-components/product-activity.tsx';
const FRONT_COMPONENT_ID = 'PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER';
const WIDGET_ID = 'PRODUCT_ACTIVITY_WIDGET_UNIVERSAL_IDENTIFIER';

const constants = ids as Record<string, string>;

const importAbs = (relPath: string) => import(/* @vite-ignore */ resolve(process.cwd(), relPath));
const loadLib = () => importAbs(LIB);

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('TCA-31 contract for TCA-32: Product activity widget on the Person Home tab', () => {
  it('default-exports a FIT_CONTENT "Product activity" front-component widget on the Person Home tab', async () => {
    for (const n of [FRONT_COMPONENT_ID, WIDGET_ID]) expect(constants[n], n).toMatch(UUID_V4);
    expect(constants[FRONT_COMPONENT_ID]).not.toBe(constants[WIDGET_ID]);

    const widget = (await importAbs(WIDGET_FILE)).default;
    expect(widget.success, JSON.stringify(widget.errors)).toBe(true);
    expect(widget.config).toMatchObject({
      universalIdentifier: constants[WIDGET_ID],
      pageLayoutTabUniversalIdentifier: STANDARD_PAGE_LAYOUT.personRecordPage.tabs.home.universalIdentifier,
      title: 'Product activity',
      type: WidgetType.FRONT_COMPONENT,
      objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      heightBehavior: PageLayoutWidgetVerticalListHeightBehavior.FIT_CONTENT,
      configuration: {
        configurationType: 'FRONT_COMPONENT',
        frontComponentUniversalIdentifier: constants[FRONT_COMPONENT_ID],
      },
    });
    expect([PageLayoutTabLayoutMode.VERTICAL_LIST, PageLayoutTabLayoutMode.GRID]).toContain(
      widget.config.position?.layoutMode,
    );
  });
});

describe('selectedPersonId: show nothing and make no request unless exactly one record is selected', () => {
  it.each([
    [[], null],
    [[PERSON_ID], PERSON_ID],
    [[PERSON_ID, '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70'], null],
  ])('%j -> %j', async (selected, expected) => {
    const { selectedPersonId } = await loadLib();
    expect(selectedPersonId(selected)).toBe(expected);
  });

  it('maps a null person id to the hidden state whatever the request holds', async () => {
    const { toViewState } = await loadLib();
    expect(toViewState(null, { phase: 'loading' }, NOW)).toEqual({ kind: 'hidden' });
    expect(
      toViewState(null, { phase: 'loaded', response: { status: 'no_email', message: 'x' } }, NOW),
    ).toEqual({ kind: 'hidden' });
  });
});

describe('toViewState: every displayed outcome', () => {
  it('shows the loading state while the request is in flight', async () => {
    const { toViewState } = await loadLib();
    expect(toViewState(PERSON_ID, { phase: 'loading' }, NOW)).toEqual({ kind: 'loading' });
  });

  it('lists ok events newest first with relative times, keeping url and profileUrl', async () => {
    const { toViewState } = await loadLib();
    const response: ActivityResponse = {
      status: 'ok',
      events: [
        { event: '$pageview', url: 'https://example.com/pricing', timestamp: ago(2 * HOUR) },
        { event: 'signup_completed', url: null, timestamp: ago(DAY + HOUR) },
      ],
      profileUrl: 'https://us.posthog.com/project/1/person/abc',
    };
    expect(toViewState(PERSON_ID, { phase: 'loaded', response }, NOW)).toEqual({
      kind: 'events',
      events: [
        { event: '$pageview', url: 'https://example.com/pricing', relativeTime: '2 hours ago' },
        { event: 'signup_completed', url: null, relativeTime: 'yesterday' },
      ],
      profileUrl: 'https://us.posthog.com/project/1/person/abc',
    });

    const noProfile = toViewState(PERSON_ID, { phase: 'loaded', response: { ...response, profileUrl: null } }, NOW);
    expect(noProfile.profileUrl).toBeNull();
  });

  it('treats ok with no events as the no-activity empty state', async () => {
    const { toViewState } = await loadLib();
    const response: ActivityResponse = { status: 'ok', events: [], profileUrl: null };
    expect(toViewState(PERSON_ID, { phase: 'loaded', response }, NOW)).toEqual({
      kind: 'empty',
      message: 'No PostHog activity for this email',
    });
  });

  // Messages are the route's (TCA-28); the widget passes them through unchanged.
  it.each([
    ['not_configured', 'Connect PostHog in Settings > Apps', 'empty'],
    ['no_email', 'No email on this person', 'empty'],
    ['no_activity', 'No PostHog activity for this email', 'empty'],
    ['rate_limited', 'PostHog is busy, try again in a minute', 'error'],
    ['timeout', 'PostHog took too long, try again', 'error'],
    ['error', "PostHog connection failed; an admin should check Settings > Apps", 'error'],
    ['error', 'Could not load PostHog activity', 'error'],
  ] as const)('status %s ("%s") -> %s with the route message', async (status, message, kind) => {
    const { toViewState } = await loadLib();
    const response = { status, message } as ActivityResponse;
    expect(toViewState(PERSON_ID, { phase: 'loaded', response }, NOW)).toEqual({ kind, message });
  });

  it('maps a client-side failure (no route status) to a retryable error: abort vs any other throw', async () => {
    const { toViewState, ACTIVITY_REQUEST_TIMEOUT_MS } = await loadLib();
    expect(ACTIVITY_REQUEST_TIMEOUT_MS).toBe(8_000);
    expect(toViewState(PERSON_ID, { phase: 'failed', timedOut: true }, NOW)).toEqual({
      kind: 'error',
      message: 'PostHog took too long, try again',
    });
    expect(toViewState(PERSON_ID, { phase: 'failed', timedOut: false }, NOW)).toEqual({
      kind: 'error',
      message: 'Could not load PostHog activity',
    });
  });
});

describe('formatRelativeTime(iso, now)', () => {
  it.each([
    ['in the future (clock skew)', -30 * SEC, 'just now'],
    ['0 s', 0, 'just now'],
    ['59 s', 59 * SEC, 'just now'],
    ['60 s', MIN, '1 min ago'],
    ['5 min', 5 * MIN, '5 min ago'],
    ['59 min', 59 * MIN, '59 min ago'],
    ['60 min', HOUR, '1 hour ago'],
    ['2 hours', 2 * HOUR, '2 hours ago'],
    ['23 h 59 min', DAY - MIN, '23 hours ago'],
    ['24 h', DAY, 'yesterday'],
    ['47 h', 2 * DAY - HOUR, 'yesterday'],
    ['48 h', 2 * DAY, '2 days ago'],
    ['30 days', 30 * DAY, '30 days ago'],
  ])('%s (%i ms) -> %s', async (_label, ms, expected) => {
    const { formatRelativeTime } = await loadLib();
    expect(formatRelativeTime(ago(ms), NOW)).toBe(expected);
  });

  it('shows the date (with year) beyond 30 days', async () => {
    const { formatRelativeTime } = await loadLib();
    const text = formatRelativeTime('2026-09-20T12:00:00.000Z', NOW);
    expect(text).not.toMatch(/ago$|^yesterday$|^just now$/);
    expect(text).toContain('2026');
    expect(formatRelativeTime('2025-12-31T12:00:00.000Z', NOW)).toContain('2025');
  });
});

// The front component is not render-tested (no testing-library; twenty-ui does not load in node).
// These scans fence its wiring to the pure seam above; the absence check is a whole-file property.
describe('product-activity.tsx wiring', () => {
  it('defines the front component through the seam, with an abortable request and no polling', () => {
    expect(existsSync(resolve(process.cwd(), COMPONENT_FILE)), COMPONENT_FILE).toBe(true);
    const source = readFileSync(resolve(process.cwd(), COMPONENT_FILE), 'utf8');
    for (const token of [
      'defineFrontComponent',
      FRONT_COMPONENT_ID,
      'RECORD_PAGE',
      'useSelectedRecordIds',
      'selectedPersonId',
      'toViewState',
      'AbortController',
      'ACTIVITY_REQUEST_TIMEOUT_MS',
      "'/s/activity'",
    ]) {
      expect(source, token).toContain(token);
    }
    expect(source).not.toMatch(/setInterval|refetchInterval/);
  });
});
