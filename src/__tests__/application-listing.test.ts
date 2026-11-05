import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import application from 'src/application-config';

// twenty-sdk 2.54.3 ApplicationConfig: logo?: string; galleryImages?: string[]
// (screenshots is deprecated); author, category, emailSupport, issueReportUrl.
const { config } = application;

const GALLERY_DIR = 'public/gallery';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readme = () => readFileSync('README.md', 'utf8');
const packageJson = () =>
  JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// Body of a `## <heading>` section, up to the next `## ` heading.
const section = (markdown: string, heading: string): string => {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (line) => line.replace(/^##\s+/, '').trim().toLowerCase() === heading.toLowerCase()
      && line.startsWith('## '),
  );
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

const changelogVersions = () =>
  [...readFileSync('CHANGELOG.md', 'utf8').matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map(
    (match) => match[1],
  );

describe('marketplace listing (TCA-32)', () => {
  it('animates the logo with CSS only, honouring reduced motion (no SMIL, which DOMPurify strips)', () => {
    expect(config.logo).toBe('public/logo.svg');
    const svg = readFileSync('public/logo.svg', 'utf8');

    expect(svg).toContain('@keyframes');
    expect(svg).toContain('prefers-reduced-motion');
    expect(svg).not.toMatch(/<(animate|animateTransform|animateMotion|set)\b/i);
  });

  it('lists four 1600x1000 PNGs under 10 MB in galleryImages, with no unlisted gallery files', () => {
    const images = config.galleryImages ?? [];
    expect(images).toHaveLength(4);
    expect(new Set(images).size).toBe(4);

    for (const path of images) {
      expect(path).toMatch(/^public\/gallery\/[^/]+\.png$/);
      expect(existsSync(path)).toBe(true);
      const png = readFileSync(path);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR: width and height are big-endian uint32 at bytes 16 and 20.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 1000]);
      expect(statSync(path).size).toBeLessThan(MAX_IMAGE_BYTES);
    }

    const onDisk = readdirSync(GALLERY_DIR)
      .filter((file) => file.endsWith('.png'))
      .map((file) => `${GALLERY_DIR}/${file}`);
    expect(onDisk.sort()).toEqual([...images].sort());
  });

  it('README has every listing section, the identify snippet, install command, key scope and seed script', () => {
    const markdown = readme();
    for (const heading of [
      'What you get',
      'How it works',
      'Prerequisite',
      'Install',
      'Setup',
      'Privacy',
      'Permissions',
      'PostHog usage',
      'Pricing',
      'Support',
      'Seeding a demo project',
    ]) {
      expect(section(markdown, heading), `## ${heading}`).not.toBe('');
    }

    expect(section(markdown, 'Prerequisite')).toMatch(/posthog\.identify\(\s*\w+\s*,\s*\{\s*email/);
    expect(section(markdown, 'Install')).toContain('npx twenty@latest app install');
    expect(section(markdown, 'Setup')).toContain('query:read');
    expect(section(markdown, 'Setup').toLowerCase()).toContain('health check');
    expect(section(markdown, 'Seeding a demo project')).toContain('scripts/seed-posthog.sh');
  });

  it('README privacy states what leaves, where it goes, what is stored, deletion, the GDPR limit and data residency', () => {
    const markdown = readme();
    const privacy = section(markdown, 'Privacy');

    for (const lead of [
      'What leaves the workspace',
      'Where it goes',
      'What is stored',
      'Deleting it',
    ]) {
      expect(privacy, lead).toMatch(new RegExp(`\\*\\*${lead}\\.?\\*\\*`));
    }
    // D-TCA-30-gdpr-clear-scope: deletions older than 31 days are not cleared.
    expect(privacy).toContain('31 days');
    // Data residency: EU customers should point at PostHog EU.
    expect(privacy).toContain('eu.posthog.com');

    expect(section(markdown, 'Permissions')).toMatch(/read and update/i);
    expect(section(markdown, 'Permissions')).toMatch(/\bPerson/);
    expect(section(markdown, 'PostHog usage')).toContain('500');
  });

  it('README pricing and support agree with the listing metadata', () => {
    expect(config.author).toBeTruthy();
    expect(config.category).toBeTruthy();
    expect(config.emailSupport).toBeTruthy();

    const markdown = readme();
    const pricing = section(markdown, 'Pricing');
    expect(pricing).toMatch(/free/i);
    expect(pricing).toContain('MIT');

    const support = section(markdown, 'Support');
    expect(support).toContain(config.emailSupport as string);
    expect(support).toContain(config.issueReportUrl as string);
    expect(support).toContain('SETUP.md');
    expect(support).toContain('CHANGELOG.md');
  });

  it('releases 0.1.0: newest CHANGELOG entry matches package.json and lists changes', () => {
    const versions = changelogVersions();
    expect(versions[0]).toBe(packageJson().version);

    // Newest entry body: between the first `## <version>` heading and the next.
    const entry = readFileSync('CHANGELOG.md', 'utf8').split(/^## /m)[1] ?? '';
    expect(entry).toMatch(/^\s*[-*] \S/m);
  });
});

// Shape only. Needed by: none (last story of TCA-20); this pins the promised
// "listing assets; 0.1.0 release (or a ready-to-tag PR)".
describe('contract: TCA-32 output (listing assets and 0.1.0 release)', () => {
  it('exposes logo, galleryImages and support metadata, and a 0.1.0 version with a changelog entry', () => {
    expect(typeof config.logo).toBe('string');
    expect(Array.isArray(config.galleryImages)).toBe(true);
    for (const path of config.galleryImages ?? []) {
      expect(typeof path).toBe('string');
    }
    expect(typeof config.author).toBe('string');
    expect(typeof config.category).toBe('string');
    expect(typeof config.emailSupport).toBe('string');

    expect(packageJson().version).toBe('0.1.0');
    expect(changelogVersions()).toContain('0.1.0');
  });
});
