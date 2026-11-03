import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  type: FieldType.DATE_TIME,
  name: 'posthogLastSeenAt',
  label: 'PostHog Last Seen',
  description: 'When PostHog last saw this person.',
  icon: 'IconClock',
  isNullable: true,
  isAuditLogged: false,
});
