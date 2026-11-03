import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

describe('App installation', () => {
  it('should find the installed app in the applications list', async () => {
    const client = new MetadataApiClient();

    const result = await client.query({
      findManyApplications: {
        id: true,
        name: true,
        universalIdentifier: true,
      },
    });

    const app = result.findManyApplications.find(
      (a: { universalIdentifier: string }) =>
        a.universalIdentifier === APPLICATION_UNIVERSAL_IDENTIFIER,
    );

    expect(app).toBeDefined();
  });
});

describe('CoreApiClient', () => {
  it('should support CRUD on standard objects', async () => {
    const client = new CoreApiClient();

    const created = await client.mutation({
      createNote: {
        __args: { data: { title: 'Integration test note' } },
        id: true,
      },
    });
    expect(created.createNote?.id).toBeDefined();

    await client.mutation({
      destroyNote: {
        __args: { id: created.createNote!.id },
        id: true,
      },
    });
  });
});

// TCA-25: Person carries the four PostHog summary fields after `app apply`.
describe('Person PostHog fields', () => {
  it('should expose the four fields with the right types', async () => {
    const client = new MetadataApiClient();

    const result = await client.query({
      objects: {
        __args: { filter: {}, paging: { first: 100 } },
        edges: {
          node: {
            nameSingular: true,
            fields: {
              __args: { filter: {}, paging: { first: 200 } },
              edges: { node: { name: true, type: true } },
            },
          },
        },
      },
    });

    const person = result.objects.edges.find(
      (e: { node: { nameSingular: string } }) => e.node.nameSingular === 'person',
    );
    const types = Object.fromEntries(
      person!.node.fields.edges.map((e: { node: { name: string; type: string } }) => [
        e.node.name,
        e.node.type,
      ]),
    );

    expect(types).toMatchObject({
      posthogLastSeenAt: 'DATE_TIME',
      posthogLastPage: 'LINKS',
      posthogPageviews30d: 'NUMBER',
      posthogProfile: 'LINKS',
    });
  });
});
