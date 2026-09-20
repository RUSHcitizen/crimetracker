import { describe, expect, it } from 'vitest';
import {
  CAMERA_USE_NOTICE,
  cameraImageUrl,
  DEFAULT_CAMERA_IMAGE_HOSTS,
  mapWsdotCameras,
  WASHINGTON_BBOX,
} from '../src/index.js';

/** Shaped after WSDOT's documented `GetCamerasAsJson` response. */
const camera = (over: Record<string, unknown> = {}) => ({
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
  Description: '',
  DisplayLatitude: 47.6606,
  DisplayLongitude: -122.3231,
  ImageURL: 'https://images.wsdot.wa.gov/nw/005vc16940.jpg',
  ImageHeight: 243,
  ImageWidth: 352,
  IsActive: true,
  OwnerURL: null,
  Region: 'Northwest',
  SortOrder: 100,
  Title: 'I-5 at MP 169.4: NE 45th St',
  ...over,
});

describe('mapWsdotCameras', () => {
  it('maps a published camera to a positioned site', () => {
    const { cameras, rejected } = mapWsdotCameras([camera()]);
    expect(rejected.total).toBe(0);
    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({
      id: '9001',
      title: 'I-5 at MP 169.4: NE 45th St',
      imageUrl: 'https://images.wsdot.wa.gov/nw/005vc16940.jpg',
      roadway: '005',
      direction: 'N',
      region: 'Northwest',
      owner: 'WSDOT',
    });
    expect(cameras[0]?.coordinates).toEqual({ lat: 47.6606, lon: -122.3231 });
  });

  it('drops cameras the agency has retired', () => {
    const { cameras, rejected } = mapWsdotCameras([camera({ IsActive: false })]);
    expect(cameras).toHaveLength(0);
    expect(rejected.inactive).toBe(1);
  });

  it('refuses to send a browser to an image host outside the allow-list', () => {
    /*
     * The browser is told to load these URLs directly. Which hosts it can be pointed at
     * is not a decision an upstream record gets to make — a record naming somewhere else
     * is dropped, whether that is a typo or something worse.
     */
    const { cameras, rejected } = mapWsdotCameras([
      camera({ ImageURL: 'https://evil.example.com/steal.jpg' }),
      camera({ CameraID: 9002, ImageURL: 'http://images.wsdot.wa.gov/nw/plain.jpg' }),
      camera({ CameraID: 9003, ImageURL: 'javascript:alert(1)' }),
    ]);
    expect(cameras).toHaveLength(0);
    expect(rejected.imageHost).toBe(3);
  });

  it('accepts a subdomain of an allowed host but not a lookalike suffix', () => {
    const ok = mapWsdotCameras([camera({ ImageURL: 'https://images.wsdot.wa.gov/x.jpg' })]);
    expect(ok.cameras).toHaveLength(1);

    const lookalike = mapWsdotCameras([camera({ ImageURL: 'https://notwsdot.wa.gov/x.jpg' })]);
    expect(lookalike.cameras).toHaveLength(0);
    expect(lookalike.rejected.imageHost).toBe(1);
  });

  it('drops cameras positioned outside the region', () => {
    const { cameras, rejected } = mapWsdotCameras([
      camera({ DisplayLatitude: 40.7, DisplayLongitude: -74, CameraLocation: {} }),
    ]);
    expect(cameras).toHaveLength(0);
    expect(rejected.position).toBe(1);
  });

  it('falls back to the nested location when display coordinates are absent', () => {
    const { cameras } = mapWsdotCameras([
      camera({ DisplayLatitude: undefined, DisplayLongitude: undefined }),
    ]);
    expect(cameras[0]?.coordinates).toEqual({ lat: 47.6606, lon: -122.3231 });
  });

  it('deduplicates repeated camera ids', () => {
    const { cameras, rejected } = mapWsdotCameras([camera(), camera()]);
    expect(cameras).toHaveLength(1);
    expect(rejected.total).toBe(1);
  });

  it('builds a title from the route when the publisher supplies none', () => {
    const { cameras } = mapWsdotCameras([camera({ Title: '', Description: '' })]);
    // `CameraLocation.Description` first, then route and milepost.
    expect(cameras[0]?.title).toBe('I-5 at NE 45th St');
  });

  it('survives a payload that is not an array of records', () => {
    expect(mapWsdotCameras(null).cameras).toEqual([]);
    expect(mapWsdotCameras({ Cameras: [] }).cameras).toEqual([]);
    expect(mapWsdotCameras([null, 4, 'x']).cameras).toEqual([]);
  });

  it('honours a caller-supplied region and host list', () => {
    const { cameras } = mapWsdotCameras(
      [camera({ DisplayLatitude: 40.7, DisplayLongitude: -74, ImageURL: 'https://cams.example.gov/a.jpg' })],
      { region: null, imageHosts: ['example.gov'] },
    );
    expect(cameras).toHaveLength(1);
  });

  it('defaults to the region and hosts the project ships with', () => {
    expect(DEFAULT_CAMERA_IMAGE_HOSTS).toContain('wsdot.wa.gov');
    expect(WASHINGTON_BBOX.north).toBeGreaterThan(WASHINGTON_BBOX.south);
  });
});

describe('cameraImageUrl', () => {
  const site = mapWsdotCameras([camera()]).cameras[0]!;

  it('buckets the cache-buster so viewers share one request per interval', () => {
    // Aligned to a bucket boundary so the assertion is about bucketing, not arithmetic.
    const base = 16_666_666 * 60_000;
    const a = cameraImageUrl(site, base, 60_000);
    const b = cameraImageUrl(site, base + 30_000, 60_000);
    const c = cameraImageUrl(site, base + 90_000, 60_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('appends correctly to a url that already has a query', () => {
    const withQuery = { ...site, imageUrl: 'https://images.wsdot.wa.gov/a.jpg?x=1' };
    expect(cameraImageUrl(withQuery, 0)).toContain('?x=1&t=');
  });
});

describe('use notice', () => {
  it('states plainly that images are not analysed or used to identify anyone', () => {
    // The notice is part of the contract with the agency and with anyone on camera, so
    // its substance is pinned rather than left to whoever edits the string next.
    expect(CAMERA_USE_NOTICE).toMatch(/not recorded, analysed/i);
    expect(CAMERA_USE_NOTICE).toMatch(/identify people or vehicles/i);
  });
});
