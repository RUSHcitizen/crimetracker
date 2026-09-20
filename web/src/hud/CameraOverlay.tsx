import { useEffect, useMemo, useState } from 'react';
import { cameraImageUrl, type CameraSite } from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { CAMERA_MIN_ZOOM } from '../map/cameraLayers.js';

/**
 * The public roadway-camera overlay.
 *
 * Two rules are enforced here rather than left to whoever edits this next:
 *
 *  1. **The use notice ships with the picture.** It is rendered as part of the card, not
 *     as a tooltip or a line in the docs, because the only moment it matters is while
 *     someone is looking at the image.
 *  2. **The image is the whole feature.** There is no analysis of it, no annotation drawn
 *     over it, no description generated from it. A still from a public road camera shown
 *     as-is is an observation; the same still with a machine's guess written across it is
 *     an accusation about whoever happens to be in frame.
 */

/** How often an open camera re-requests its still. Matches typical agency update rates. */
const REFRESH_MS = 60_000;

export function CameraToggle() {
  const camerasVisible = useTracker((s) => s.ui.camerasVisible);
  const cameraState = useTracker((s) => s.cameraState);
  const count = useTracker((s) => s.cameras.length);
  const setUi = useTracker((s) => s.setUi);
  const loadCameras = useTracker((s) => s.loadCameras);
  const selectCamera = useTracker((s) => s.selectCamera);

  const label =
    cameraState === 'loading'
      ? 'LOADING…'
      : cameraState === 'unavailable'
        ? 'UNAVAILABLE'
        : count > 0
          ? `${count}`
          : 'CAMERAS';

  return (
    <button
      type="button"
      className={`camtoggle${camerasVisible ? ' camtoggle--on' : ''}`}
      aria-pressed={camerasVisible}
      title="Public roadway cameras (C)"
      onClick={() => {
        const next = !camerasVisible;
        setUi({ camerasVisible: next });
        if (next) void loadCameras();
        else selectCamera(null);
      }}
    >
      <span className="camtoggle__glyph" aria-hidden="true">
        ▣
      </span>
      <span className="camtoggle__label">CAM {label}</span>
    </button>
  );
}

export function CameraCard() {
  const selectedCameraId = useTracker((s) => s.selectedCameraId);
  const cameras = useTracker((s) => s.cameras);
  const notice = useTracker((s) => s.cameraNotice);
  const attribution = useTracker((s) => s.cameraAttribution);
  const selectCamera = useTracker((s) => s.selectCamera);

  const camera = useMemo(
    () => cameras.find((entry) => entry.id === selectedCameraId) ?? null,
    [cameras, selectedCameraId],
  );

  if (!camera) return null;
  return (
    <CameraView
      camera={camera}
      notice={notice}
      attribution={attribution}
      onClose={() => selectCamera(null)}
    />
  );
}

function CameraView({
  camera,
  notice,
  attribution,
  onClose,
}: {
  camera: CameraSite;
  notice: string | null;
  attribution: string | null;
  onClose: () => void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  // Re-request the still on a coarse interval. The bucketed URL means every open viewer
  // shares one request per interval rather than each generating its own.
  useEffect(() => {
    setFailed(false);
    const timer = window.setInterval(() => setTick(Date.now()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [camera.id]);

  const src = cameraImageUrl(camera, tick, REFRESH_MS);

  return (
    <div className="camcard" role="dialog" aria-label={`Roadway camera: ${camera.title}`}>
      <div className="camcard__head">
        <div className="camcard__title">
          <span className="camcard__kicker micro">ROADWAY CAMERA</span>
          <span className="camcard__name">{camera.title}</span>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          CLOSE
        </button>
      </div>

      <div className="camcard__frame">
        {failed ? (
          <div className="camcard__failed micro">
            IMAGE UNAVAILABLE FROM AGENCY
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setFailed(false);
                setTick(Date.now());
              }}
            >
              RETRY
            </button>
          </div>
        ) : (
          <img
            className="camcard__img"
            src={src}
            alt={`Live still from the public roadway camera at ${camera.title}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        )}
        <span className="camcard__scan" aria-hidden="true" />
      </div>

      <dl className="camcard__meta micro">
        {camera.roadway && (
          <>
            <dt>ROUTE</dt>
            <dd>
              {camera.roadway}
              {camera.direction ? ` ${camera.direction}` : ''}
            </dd>
          </>
        )}
        <dt>POSITION</dt>
        <dd>
          {camera.coordinates.lat.toFixed(4)}, {camera.coordinates.lon.toFixed(4)}
        </dd>
        <dt>OPERATOR</dt>
        <dd>{camera.owner}</dd>
      </dl>

      {/* Non-negotiable: the notice travels with the image. */}
      <p className="camcard__notice micro">{notice ?? ''}</p>
      {attribution && <p className="camcard__credit micro">SOURCE: {attribution}</p>}
    </div>
  );
}

/**
 * The one line the overlay is allowed to put over the map.
 *
 * Reserved for the two cases where the operator would otherwise think the toggle is
 * broken: the server cannot supply a directory at all, or the markers exist but are
 * zoom-gated. The routine bookkeeping — how many records the region and host checks
 * filtered out — belongs in the source list, not across the middle of the map.
 */
export function CameraNotice() {
  const camerasVisible = useTracker((s) => s.ui.camerasVisible);
  const cameraState = useTracker((s) => s.cameraState);
  const message = useTracker((s) => s.cameraMessage);
  const count = useTracker((s) => s.cameras.length);
  const zoom = useTracker((s) => s.viewportZoom);

  if (!camerasVisible) return null;

  if (cameraState === 'unavailable') {
    return (
      <div className="camnotice micro camnotice--unavailable" role="status">
        {message ?? 'Camera overlay unavailable.'}
      </div>
    );
  }

  if (cameraState === 'ready' && count > 0 && zoom > 0 && zoom < CAMERA_MIN_ZOOM) {
    return (
      <div className="camnotice micro" role="status">
        {count} ROADWAY CAMERAS — ZOOM IN TO SHOW THEM
      </div>
    );
  }

  return null;
}
