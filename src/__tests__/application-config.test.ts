import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import application from 'src/application-config';
import * as identifiers from 'src/constants/universal-identifiers';

// twenty-sdk 2.54.3: applicationVariables is Record<key, { universalIdentifier,
// label, description, type, options, value, isSecret, isRequired, scope }>.
const { config } = application;
const variables = config.applicationVariables ?? {};

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_URL = 'https://github.com/avisangle/posthog-activity-sync';
const SETTINGS_KEYS = [
  'POSTHOG_HOST',
  'POSTHOG_CUSTOM_HOST',
  'POSTHOG_PROJECT_ID',
  'POSTHOG_PERSONAL_API_KEY',
];

describe('application settings variables', () => {
  it('passes twenty-sdk validation with no errors or warnings', () => {
    expect(application.errors).toEqual([]);
    expect(application.warnings ?? []).toEqual([]);
    expect(application.success).toBe(true);
  });

  it('declares exactly the four PostHog keys, each workspace-scoped and documented', () => {
    expect(Object.keys(variables).sort()).toEqual([...SETTINGS_KEYS].sort());

    for (const variable of Object.values(variables)) {
      expect(variable.scope).toBe('WORKSPACE');
      expect(variable.label).toBeTruthy();
      expect(variable.description).toBeTruthy();
      expect(variable.universalIdentifier).toMatch(UUID_V4);
    }
    const ids = Object.values(variables).map((v) => v.universalIdentifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks only the personal API key secret, required and without a default', () => {
    const secretKeys = Object.entries(variables)
      .filter(([, variable]) => variable.isSecret === true)
      .map(([key]) => key);
    expect(secretKeys).toEqual(['POSTHOG_PERSONAL_API_KEY']);

    const apiKey = variables.POSTHOG_PERSONAL_API_KEY;
    expect(apiKey.type).toBe('TEXT');
    expect(apiKey.isRequired).toBe(true);
    expect('value' in apiKey).toBe(false);
  });

  it('offers the host as a SELECT of US, EU and self-hosted, defaulting to US', () => {
    const host = variables.POSTHOG_HOST;
    expect(host.type).toBe('SELECT');
    expect(host.isRequired).toBe(true);
    expect('value' in host && host.value).toBe('https://us.posthog.com');
    expect((host.options ?? []).map((option) => option.value)).toEqual([
      'https://us.posthog.com',
      'https://eu.posthog.com',
      'custom',
    ]);
  });

  it('requires the project ID and leaves the custom host optional', () => {
    expect(variables.POSTHOG_PROJECT_ID.type).toBe('TEXT');
    expect(variables.POSTHOG_PROJECT_ID.isRequired).toBe(true);
    expect(variables.POSTHOG_CUSTOM_HOST.type).toBe('TEXT');
    expect(variables.POSTHOG_CUSTOM_HOST.isRequired ?? false).toBe(false);
  });

  it('declares the marketplace listing fields and a bundled logo', () => {
    expect(config.universalIdentifier).toMatch(UUID_V4);
    expect(config.displayName).toBe('PostHog Activity');
    expect(config.description).toBeTruthy();
    expect(config.author).toBe('ReportStack');
    expect(config.category).toBe('Sales');
    expect(config.emailSupport).toBe('support@reportstack.app');
    expect(config.websiteUrl).toBe(REPOSITORY_URL);
    expect(config.issueReportUrl).toBe(`${REPOSITORY_URL}/issues`);
    expect(config.logo).toBe('public/logo.svg');
    expect(existsSync('public/logo.svg')).toBe(true);
  });
});

// Shape only. Consumed by TCA-23, TCA-24, TCA-25 and every later story.
describe('contract: TCA-21 output for dependents (TCA-23, TCA-24, TCA-25)', () => {
  it('exposes the settings keys, the identifiers module to extend and the conventions', () => {
    // Settings keys later stories read through src/lib/settings.ts.
    for (const key of SETTINGS_KEYS) {
      expect(variables).toHaveProperty(key);
    }

    // Identifiers module: flat *_UNIVERSAL_IDENTIFIER string exports.
    expect(typeof identifiers.APPLICATION_UNIVERSAL_IDENTIFIER).toBe('string');
    expect(typeof identifiers.DEFAULT_ROLE_UNIVERSAL_IDENTIFIER).toBe('string');
    const exported = Object.entries(identifiers)
      .filter(([name]) => name.endsWith('_UNIVERSAL_IDENTIFIER'))
      .map(([, value]) => value);
    for (const value of exported) {
      expect(value).toMatch(UUID_V4);
    }
    expect(new Set(exported).size).toBe(exported.length);

    // Every UUID in use so far lives in the identifiers module.
    expect(exported).toContain(config.universalIdentifier);
    for (const variable of Object.values(variables)) {
      expect(exported).toContain(variable.universalIdentifier);
    }

    // CLAUDE.md conventions section, mirrored in AGENTS.md.
    const section = (file: string) =>
      readFileSync(file, 'utf8').split('## Project conventions')[1];
    expect(section('CLAUDE.md')).toBeTruthy();
    expect(section('AGENTS.md')).toBe(section('CLAUDE.md'));
  });
});
