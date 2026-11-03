import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PERSON_POSTHOG_LAST_PAGE_FIELD_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineField({
  universalIdentifier: PERSON_POSTHOG_LAST_PAGE_FIELD_UNIVERSAL_IDENTIFIER,
  objectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  type: FieldType.LINKS,
  name: 'posthogLastPage',
  label: 'PostHog Last Page',
  description: 'The last page this person viewed.',
  icon: 'IconFileText',
  isNullable: true,
  isAuditLogged: false,
});
