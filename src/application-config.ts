import { defineApplication, FieldType } from 'twenty-sdk/define';

import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APPLICATION_UNIVERSAL_IDENTIFIER,
  POSTHOG_CUSTOM_HOST_VARIABLE_UNIVERSAL_IDENTIFIER,
  POSTHOG_HOST_VARIABLE_UNIVERSAL_IDENTIFIER,
  POSTHOG_PERSONAL_API_KEY_VARIABLE_UNIVERSAL_IDENTIFIER,
  POSTHOG_PROJECT_ID_VARIABLE_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

const REPOSITORY_URL = 'https://github.com/avisangle/posthog-activity-sync';

export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: APP_DISPLAY_NAME,
  description: APP_DESCRIPTION,
  author: 'ReportStack',
  category: 'Sales',
  logo: 'public/logo.svg',
  websiteUrl: REPOSITORY_URL,
  issueReportUrl: `${REPOSITORY_URL}/issues`,
  emailSupport: 'support@reportstack.app',
  applicationVariables: {
    POSTHOG_HOST: {
      universalIdentifier: POSTHOG_HOST_VARIABLE_UNIVERSAL_IDENTIFIER,
      label: 'PostHog host',
      description:
        'Where your PostHog project is hosted. Choose "Self-hosted" to use the custom host below.',
      type: FieldType.SELECT,
      options: [
        { label: 'PostHog Cloud US', value: 'https://us.posthog.com' },
        { label: 'PostHog Cloud EU', value: 'https://eu.posthog.com' },
        { label: 'Self-hosted (custom host)', value: 'custom' },
      ],
      value: 'https://us.posthog.com',
      isRequired: true,
      scope: 'WORKSPACE',
    },
    POSTHOG_CUSTOM_HOST: {
      universalIdentifier: POSTHOG_CUSTOM_HOST_VARIABLE_UNIVERSAL_IDENTIFIER,
      label: 'Custom PostHog host',
      description:
        'Only used when the host is "Self-hosted". The private API host of your PostHog instance (for example https://posthog.example.com), not the *.i.posthog.com ingestion host.',
      type: FieldType.TEXT,
      isRequired: false,
      scope: 'WORKSPACE',
    },
    POSTHOG_PROJECT_ID: {
      universalIdentifier: POSTHOG_PROJECT_ID_VARIABLE_UNIVERSAL_IDENTIFIER,
      label: 'PostHog project ID',
      description: 'The numeric project ID, shown in PostHog under Settings > Project.',
      type: FieldType.TEXT,
      isRequired: true,
      scope: 'WORKSPACE',
    },
    POSTHOG_PERSONAL_API_KEY: {
      universalIdentifier: POSTHOG_PERSONAL_API_KEY_VARIABLE_UNIVERSAL_IDENTIFIER,
      label: 'PostHog personal API key',
      description:
        'A personal API key (starts with phx_) with only the query:read scope, restricted to this project.',
      type: FieldType.TEXT,
      isSecret: true,
      isRequired: true,
      scope: 'WORKSPACE',
    },
  },
});
