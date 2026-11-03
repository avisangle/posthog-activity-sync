import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PERSON_POSTHOG_PAGEVIEWS_30D_FIELD_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: PERSON_POSTHOG_PAGEVIEWS_30D_FIELD_UNIVERSAL_IDENTIFIER,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  type: FieldType.NUMBER,
  name: 'posthogPageviews30d',
  label: 'PostHog Pageviews (30d)',
  description: 'Pageviews in the last 30 days.',
  icon: 'IconEye',
  isNullable: true,
  isAuditLogged: false,
});
