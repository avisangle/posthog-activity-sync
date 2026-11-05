// TCA-23 red-phase tests: readSettings() in src/lib/settings.ts.
//
// External facts (no DB tables involved):
//  - The four keys come from src/application-config.ts (TCA-21): POSTHOG_HOST is a SELECT of
//    'https://us.posthog.com' | 'https://eu.posthog.com' | 'custom'; POSTHOG_CUSTOM_HOST,
//    POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY are TEXT. Logic functions see them as process.env.<KEY>.
//  - *.i.posthog.com is the ingestion host, not the API host (D-TCA-22-posthog-api-shapes).
//
// Pinned contract for /implement:
//  readSettings(env = process.env)
//    -> { ok: true; settings: { host; projectId; apiKey } }
//     | { ok: false; problems: { key: string; reason: string }[] }
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsResult } from 'src/lib/settings';

type SettingsModule = typeof import('src/lib/settings');

const loadSettings = async (): Promise<SettingsModule> =>
  import(/* @vite-ignore */ resolve(process.cwd(), 'src/lib/settings.ts'));

const US = 'https://us.posthog.com';
const KEY = 'phx_settings_test_key_0123456789';

const baseEnv = (overrides: Record<string, string | undefined> = {}) => ({
  POSTHOG_HOST: US,
  POSTHOG_PROJECT_ID: '12345',
  POSTHOG_PERSONAL_API_KEY: KEY,
  ...overrides,
});

const problemKeys = (result: SettingsResult) =>
  result.ok ? [] : result.problems.map((p) => p.key).sort();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readSettings', () => {
  it('returns trimmed settings for a cloud host, stripping trailing slashes', async () => {
    const { readSettings } = await loadSettings();

    expect(readSettings(baseEnv())).toEqual({
      ok: true,
      settings: { host: US, projectId: '12345', apiKey: KEY },
    });

    expect(
      readSettings({
        POSTHOG_HOST: '  https://eu.posthog.com//  ',
        POSTHOG_PROJECT_ID: ' 67890 ',
        POSTHOG_PERSONAL_API_KEY: `  ${KEY}\n`,
      }),
    ).toEqual({
      ok: true,
      settings: { host: 'https://eu.posthog.com', projectId: '67890', apiKey: KEY },
    });
  });

  it('uses POSTHOG_CUSTOM_HOST when the host is "custom", and ignores it otherwise', async () => {
    const { readSettings } = await loadSettings();

    expect(
      readSettings(
        baseEnv({ POSTHOG_HOST: 'custom', POSTHOG_CUSTOM_HOST: ' https://posthog.example.com/ ' }),
      ),
    ).toEqual({
      ok: true,
      settings: { host: 'https://posthog.example.com', projectId: '12345', apiKey: KEY },
    });

    const cloud = readSettings(baseEnv({ POSTHOG_CUSTOM_HOST: 'https://posthog.example.com' }));
    expect(cloud.ok && cloud.settings.host).toBe(US);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['plain http', 'http://posthog.example.com'],
    ['not a URL', 'posthog.example.com'],
    ['the ingestion host', 'https://us.i.posthog.com'],
    ['a regional ingestion host with a trailing slash', 'https://eu.i.posthog.com/'],
  ])('rejects a custom host that is %s, naming POSTHOG_CUSTOM_HOST', async (_case, customHost) => {
    const { readSettings } = await loadSettings();

    const result = readSettings(baseEnv({ POSTHOG_HOST: 'custom', POSTHOG_CUSTOM_HOST: customHost }));

    expect(result.ok).toBe(false);
    expect(problemKeys(result)).toEqual(['POSTHOG_CUSTOM_HOST']);
    if (!result.ok) expect(result.problems[0].reason.trim()).not.toBe('');
  });

  it('rejects an ingestion host given directly as POSTHOG_HOST', async () => {
    const { readSettings } = await loadSettings();

    const result = readSettings(baseEnv({ POSTHOG_HOST: 'https://us.i.posthog.com' }));

    expect(problemKeys(result)).toEqual(['POSTHOG_HOST']);
  });

  it('reports every problem together: bad host, empty project ID and empty API key', async () => {
    const { readSettings } = await loadSettings();

    const blank = readSettings(
      baseEnv({
        POSTHOG_HOST: 'custom',
        POSTHOG_CUSTOM_HOST: 'http://posthog.example.com',
        POSTHOG_PROJECT_ID: '  ',
        POSTHOG_PERSONAL_API_KEY: '',
      }),
    );
    expect(blank.ok).toBe(false);
    expect(problemKeys(blank)).toEqual([
      'POSTHOG_CUSTOM_HOST',
      'POSTHOG_PERSONAL_API_KEY',
      'POSTHOG_PROJECT_ID',
    ]);
    if (!blank.ok) {
      for (const problem of blank.problems) {
        expect(typeof problem.reason).toBe('string');
        expect(problem.reason.trim()).not.toBe('');
      }
    }

    const missing = readSettings({ POSTHOG_HOST: US });
    expect(problemKeys(missing)).toEqual(['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID']);
  });

  it('reads process.env when called without an argument', async () => {
    const { readSettings } = await loadSettings();
    vi.stubEnv('POSTHOG_HOST', 'https://eu.posthog.com/');
    vi.stubEnv('POSTHOG_CUSTOM_HOST', '');
    vi.stubEnv('POSTHOG_PROJECT_ID', '424242');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', KEY);

    expect(readSettings()).toEqual({
      ok: true,
      settings: { host: 'https://eu.posthog.com', projectId: '424242', apiKey: KEY },
    });
  });
});
