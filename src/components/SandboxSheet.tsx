import { useEffect, useMemo, useState } from 'preact/hooks';
import { runScenario, SCENARIOS, type ScenarioId } from '../lib/sandbox';
import type { Engine } from '../lib/render/engine';
import { Sheet } from './Sheet';

/**
 * WHAT IF.
 *
 * Drag a slider, watch the hypothetical orbit appear over the real one in magenta, read
 * the consequences. The consequences are computed, not written: change Earth's distance
 * and the new year length comes out of Kepler's third law, the insolation out of the
 * inverse square law, the equilibrium temperature out of a blackbody balance.
 *
 * The banner and the caveat are always visible. This is a sandbox, and it says so.
 */
export function SandboxSheet(props: { engine: Engine; onClose: () => void; selectedId: string | null }) {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('earth-distance');
  const [value, setValue] = useState(1);

  const def = SCENARIOS.find((s) => s.id === scenarioId)!;

  const result = useMemo(
    () => runScenario(props.engine.world, props.engine.clock.jd, scenarioId, value, props.selectedId),
    [props.engine, scenarioId, value, props.selectedId],
  );

  // Push the hypothetical path into the renderer, and take it away again on close.
  useEffect(() => {
    if (!result) {
      props.engine.setOverlays([]);
      return;
    }
    const neutral = Math.abs(value - def.neutral) < 1e-6;
    props.engine.setOverlays(
      neutral
        ? []
        : [
            { id: 'sandbox-ref', points: result.reference, color: '#3d4753' },
            { id: 'sandbox', points: result.path, color: '#c084e0' },
          ],
    );
  }, [result, value, def.neutral]);

  useEffect(() => () => props.engine.setOverlays([]), []);

  const needsSelection = def.appliesTo === 'selection' && !props.selectedId;

  return (
    <Sheet title="WHAT IF" note="SANDBOX" onClose={props.onClose}>
      <div class="simbanner">SIMULATION — NOT A REAL TRAJECTORY</div>

      <div class="actions" style={{ borderBottom: '1px solid var(--hairline)' }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            class="action"
            aria-pressed={s.id === scenarioId}
            onClick={() => {
              setScenarioId(s.id);
              setValue(s.neutral);
            }}
          >
            {s.tab}
          </button>
        ))}
      </div>

      <div class="scenario">
        <div class="sq">{def.question}</div>

        {needsSelection ? (
          <div class="mbrief" style={{ color: 'var(--accent)' }}>
            Select an object first — tap anything in the view, then come back.
          </div>
        ) : (
          <>
            <div class="slider-row">
              <input
                type="range"
                min={def.min}
                max={def.max}
                step={def.step}
                value={value}
                onInput={(e) => setValue(Number((e.currentTarget as HTMLInputElement).value))}
                aria-label={def.title}
              />
              <span class="val">{def.format(value)}</span>
            </div>
            <div class="mrow">
              <button class="btn" onClick={() => setValue(def.neutral)}>RESET TO REALITY</button>
              <span style={{ alignSelf: 'center', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', color: 'var(--faint)' }}>
                {def.unit}
              </span>
            </div>
          </>
        )}
      </div>

      {result && !needsSelection ? (
        <>
          {result.escapes ? (
            <div class="simbanner" style={{ color: 'var(--bad)', borderColor: 'rgba(255,107,90,.35)', background: 'rgba(255,107,90,.1)' }}>
              UNBOUND — THIS ORBIT NEVER CLOSES
            </div>
          ) : null}
          <div class="readout" style={{ borderBottom: 'none' }}>
            {result.readouts.map((r) => (
              <div class="cell" key={r.label} style={{ gridColumn: r.value.length > 26 ? '1 / -1' : undefined }}>
                <div class="k">{r.label}</div>
                <div class="v" style={{ fontSize: r.value.length > 18 ? 11.5 : 14 }}>{r.value}</div>
                {r.delta ? <div class="aside">{r.delta}</div> : null}
              </div>
            ))}
          </div>
          <div class="caveat">
            <strong style={{ color: 'var(--sim)', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.12em' }}>
              WHAT THIS MODEL CANNOT TELL YOU —{' '}
            </strong>
            {result.caveat}
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
