import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
} from 'twenty-sdk/define';

import {
  PERSON_POSTHOG_LAST_PAGE_FIELD_UNIVERSAL_IDENTIFIER,
  PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER,
  PERSON_POSTHOG_PAGEVIEWS_30D_FIELD_UNIVERSAL_IDENTIFIER,
  PERSON_POSTHOG_PROFILE_FIELD_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_EMAILS_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_LAST_PAGE_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_LAST_SEEN_AT_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_NAME_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_PAGEVIEWS_30D_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_PROFILE_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  RECENTLY_ACTIVE_PEOPLE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

export default defineView({
  universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Recently active people',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  icon: 'IconActivity',
  fields: [
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_NAME_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_EMAILS_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON.fields.emails.universalIdentifier,
      position: 1,
      isVisible: true,
      size: 200,
    },
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_LAST_SEEN_AT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER,
      position: 2,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_LAST_PAGE_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_LAST_PAGE_FIELD_UNIVERSAL_IDENTIFIER,
      position: 3,
      isVisible: true,
      size: 200,
    },
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_PAGEVIEWS_30D_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_PAGEVIEWS_30D_FIELD_UNIVERSAL_IDENTIFIER,
      position: 4,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FIELD_PROFILE_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_PROFILE_FIELD_UNIVERSAL_IDENTIFIER,
      position: 5,
      isVisible: true,
      size: 160,
    },
  ],
  filters: [
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER,
      operand: ViewFilterOperand.IS_NOT_EMPTY,
      value: '',
    },
  ],
  sorts: [
    {
      universalIdentifier: RECENTLY_ACTIVE_PEOPLE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: PERSON_POSTHOG_LAST_SEEN_AT_FIELD_UNIVERSAL_IDENTIFIER,
      direction: ViewSortDirection.DESC,
    },
  ],
});
