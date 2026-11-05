import { useEffect, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent, PageLayoutType, STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';
import { useSelectedRecordIds } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components/feedback';
import { LightButton } from 'twenty-ui/components/input';
import { IconExternalLink, IconRefresh } from 'twenty-ui/icon';
import { Skeleton } from 'twenty-ui/primitives/feedback';
import { OverflowingTextWithTooltip, Text } from 'twenty-ui/primitives/typography';
import { useTheme } from 'twenty-ui/theme';

import { PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import type { ActivityResponse } from 'src/lib/activity';
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  selectedPersonId,
  toViewState,
  type ActivityRequest,
} from 'src/lib/activity-view-state';

const LOADING_ROWS = 3;

const ProductActivity = () => {
  const theme = useTheme();
  const personId = selectedPersonId(useSelectedRecordIds());
  const [request, setRequest] = useState<ActivityRequest>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (personId === null) return;

    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ACTIVITY_REQUEST_TIMEOUT_MS);

    setRequest({ phase: 'loading' });
    new RestApiClient()
      .get<ActivityResponse>('/s/activity', { query: { personId }, signal: controller.signal })
      .then((response) => {
        if (!cancelled) setRequest({ phase: 'loaded', response });
      })
      .catch(() => {
        if (!cancelled) setRequest({ phase: 'failed', timedOut });
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [personId, attempt]);

  const view = toViewState(personId, request, new Date());
  if (view.kind === 'hidden') return null;

  const container = {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    minWidth: 0,
    fontFamily: theme.font.family,
  } as const;

  const renderBody = () => {
    switch (view.kind) {
      case 'loading':
        return Array.from({ length: LOADING_ROWS }, (_, i) => (
          <Skeleton key={i} width="100%" height={theme.spacing[6]} />
        ));
      case 'empty':
        return (
          <Text size="sm" color="tertiary">
            {view.message}
          </Text>
        );
      case 'error':
        return (
          <Callout
            status="error"
            title={view.message}
            fullWidth
            action={
              <LightButton startIcon={<IconRefresh size={16} />} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </LightButton>
            }
          />
        );
      case 'events':
        return (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing[2] }}>
              {view.events.map((row, i) => (
                <li
                  key={i}
                  style={{ display: 'flex', alignItems: 'baseline', gap: theme.spacing[2], minWidth: 0 }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 }}>
                    <OverflowingTextWithTooltip text={row.event} size="md" weight="medium" color="primary" />
                    {row.url !== null && <OverflowingTextWithTooltip text={row.url} size="sm" color="tertiary" />}
                  </div>
                  <Text size="sm" color="tertiary" style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                    {row.relativeTime}
                  </Text>
                </li>
              ))}
            </ul>
            {view.profileUrl !== null && (
              <div>
                <LightButton
                  href={view.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  startIcon={<IconExternalLink size={16} />}
                >
                  Open PostHog profile
                </LightButton>
              </div>
            )}
          </>
        );
    }
  };

  const isLoading = view.kind === 'loading';
  return (
    <div
      style={container}
      aria-busy={isLoading}
      aria-label={isLoading ? 'Loading PostHog activity' : undefined}
    >
      {renderBody()}
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: PRODUCT_ACTIVITY_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'Product activity',
  description: "This person's latest PostHog events, with a link to their PostHog profile",
  component: ProductActivity,
  widgetAvailability: {
    pageLayoutType: PageLayoutType.RECORD_PAGE,
    objectUniversalIdentifiers: [STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier],
  },
});
