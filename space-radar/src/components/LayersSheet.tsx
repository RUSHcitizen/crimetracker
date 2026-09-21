import { useState } from 'preact/hooks';
import type { Layers } from '../lib/render/scene';
import { sound } from '../lib/sound';
import { Sheet } from './Sheet';

/**
 * Layer toggles.
 *
 * Each row explains what the layer actually shows, because two of them — GRAVITY and
 * BELTS — draw things people routinely misread. The gravity layer in particular is
 * spheres of influence, a real defined boundary, and not a field visualisation.
 */

const ROWS: { key: keyof Layers; name: string; desc: string }[] = [
  { key: 'orbits', name: 'ORBIT TRACKS', desc: 'The path each object follows around its parent, drawn from its orbital elements.' },
  { key: 'labels', name: 'LABELS', desc: 'Object names, prioritised so the densest views stay readable.' },
  { key: 'trajectory', name: 'TRAJECTORY TRAIL', desc: 'Where the tracked object has recently been, sampled from its ephemeris rather than recorded.' },
  { key: 'satellites', name: 'EARTH SATELLITES', desc: 'Objects in Earth orbit. Live element sets when available, labelled demonstration orbits otherwise.' },
  { key: 'belts', name: 'SMALL-BODY POPULATIONS', desc: 'Main belt, Jupiter Trojans and Kuiper belt. Statistically representative, individually simulated — not a real catalogue.' },
  { key: 'gravity', name: 'GRAVITY', desc: 'Spheres of influence: the boundary inside which a body, not the Sun, dominates. r = a·(m/M)^⅖. Not a field diagram.' },
  { key: 'grid', name: 'ECLIPTIC GRID', desc: 'Distance rings on the plane of Earth’s orbit, at 1, 5, 10, 30 and 100 AU.' },
  { key: 'stars', name: 'BACKGROUND SKY', desc: 'Twenty catalogued bright stars at their real positions, over a decorative star field that carries no data.' },
];

export function LayersSheet(props: {
  layers: Layers;
  onToggle: (key: keyof Layers, value: boolean) => void;
  onClose: () => void;
}) {
  const [audio, setAudio] = useState(sound.enabled);

  return (
    <Sheet title="LAYERS" onClose={props.onClose}>
      {ROWS.map((row) => {
        const on = props.layers[row.key];
        return (
          <button
            class="layer-row"
            key={row.key}
            role="switch"
            aria-checked={on}
            onClick={() => props.onToggle(row.key, !on)}
          >
            <span style={{ minWidth: 0 }}>
              <div class="lname" style={{ color: on ? 'var(--text)' : 'var(--dim)' }}>{row.name}</div>
              <div class="ldesc">{row.desc}</div>
            </span>
            <span class={`switch ${on ? 'on' : ''}`}><i /></span>
          </button>
        );
      })}

      {/* Sound is off until you ask for it, and nothing in the app depends on hearing it. */}
      <button
        class="layer-row"
        role="switch"
        aria-checked={audio}
        onClick={() => {
          const next = !audio;
          setAudio(next);
          sound.setEnabled(next);
        }}
      >
        <span style={{ minWidth: 0 }}>
          <div class="lname" style={{ color: audio ? 'var(--text)' : 'var(--dim)' }}>INTERACTION SOUND</div>
          <div class="ldesc">
            Short synthesised acknowledgements for selection, lock-on and discovery. Off by default;
            the app is designed to be complete in silence.
          </div>
        </span>
        <span class={`switch ${audio ? 'on' : ''}`}><i /></span>
      </button>
    </Sheet>
  );
}
