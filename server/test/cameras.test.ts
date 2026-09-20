import { describe, expect, it, vi } from 'vitest';
import { WASHINGTON_BBOX } from '@crimetracker/shared';
import { WsdotCameraDirectory } from '../src/cameras/directory.js';
import { SourcePolicyError } from '../src/sources/policy.js';

const CAMERA = {
  CameraID: 9001,
  CameraLocation: {
    Description: 'I-5 at NE 45th St',
    Direction: 'N',
    Latitude: 47.6606,
    Longitude: -122.3231,
    MilePost: 169.4,
    RoadName: '005',
  },
  CameraOwner: 'WSDOT',
  DisplayLatitude: 47.6606,
  DisplayLongitude: -122.3231,
  ImageURL: 'https://images.wsdot.wa.gov/nw/005vc16940.jpg',
  IsActive: true,
  Region: 'Northwest',
  Title: 'I-5 at MP 169.4: NE 45th St',
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function build(fetchImpl: typeof fetch, over: Partial<{ refreshMinutes: number; now: () => number }> = {}) {
  return new WsdotCameraDirectory({
    url: 'https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson',
    accessCode: 'SECRET-123',
    region: WASHINGTON_BBOX,
    imageHosts: ['wsdot.wa.gov'],
    refreshMinutes: over.refreshMinutes ?? 360,
    fetchImpl,
    ...(over.now ? { now: over.now } : {}),
  });
}

describe('WsdotCameraDirectory', () => {
  it('fetches the directory once and serves it from cache', async () => {
    const fetchImpl = vi.fn(async () => ok([CAMERA])) as unknown as typeof fetch;
    const directory = build(fetchImpl);

    const first = await directory.list();
    const second = await directory.list();

    expect(first.directory.cameras).toHaveLength(1);
    expect(second.directory.cameras).toHaveLength(1);
    // The list of cameras an agency operates changes over months, not minutes.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the access code to the publisher and nowhere else', async () => {
    let requested = '';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested = String(input);
      return ok([CAMERA]);
    }) as unknown as typeof fetch;

    const listing = await build(fetchImpl).list();
    expect(new URL(requested).searchParams.get('AccessCode')).toBe('SECRET-123');
    // Nothing in the response the client receives carries the key.
    expect(JSON.stringify(listing)).not.toContain('SECRET-123');
  });

  it('coalesces concurrent callers onto one upstream request', async () => {
    const fetchImpl = vi.fn(async () => ok([CAMERA])) as unknown as typeof fetch;
    const directory = build(fetchImpl);
    await Promise.all([directory.list(), directory.list(), directory.list()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports rejected records rather than quietly shrinking the overlay', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        CAMERA,
        { ...CAMERA, CameraID: 9002, IsActive: false },
        { ...CAMERA, CameraID: 9003, ImageURL: 'https://evil.example.com/x.jpg' },
      ]),
    ) as unknown as typeof fetch;

    const listing = await build(fetchImpl).list();
    expect(listing.directory.cameras).toHaveLength(1);
    expect(listing.message).toContain('2 camera record(s) not shown');
    // Filtered records are worth reporting, but the directory itself is fresh.
    expect(listing.stale).toBe(false);
  });

  it('names the access code when the publisher rejects it', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    const listing = await build(fetchImpl).list();
    expect(listing.directory.cameras).toEqual([]);
    expect(listing.message).toContain('rejected the access code');
  });

  it('serves the last good directory when a refresh fails', async () => {
    let call = 0;
    const clock = { now: 0 };
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return ok([CAMERA]);
      throw new Error('getaddrinfo ENOTFOUND www.wsdot.wa.gov');
    }) as unknown as typeof fetch;

    const directory = build(fetchImpl, { refreshMinutes: 15, now: () => clock.now });
    const first = await directory.list();
    expect(first.stale).toBe(false);

    // Past the refresh window, with the publisher unreachable.
    clock.now = 20 * 60_000;
    const second = await directory.list();
    // An overlay that empties itself on a transient network error is worse than one that
    // says how old it is.
    expect(second.directory.cameras).toHaveLength(1);
    expect(second.stale).toBe(true);
    expect(second.message).toContain('fetch failed');
  });

  it('strips the access code out of a fetch error before anyone sees it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('request to https://wsdot.example/x?AccessCode=SECRET-123 failed');
    }) as unknown as typeof fetch;

    const listing = await build(fetchImpl).list();
    expect(listing.message).not.toContain('SECRET-123');
    expect(listing.message).toContain('REDACTED');
  });

  it('refuses a non-public directory url', () => {
    expect(
      () =>
        new WsdotCameraDirectory({
          url: 'http://cameras.internal/list',
          accessCode: 'x',
          region: null,
          imageHosts: [],
          refreshMinutes: 60,
        }),
    ).toThrow(SourcePolicyError);
  });
});
