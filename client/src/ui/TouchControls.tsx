import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { peelAimed, placeSticky } from '../world/boardHands';
import { interact } from '../world/Player';
import { reloadHeld } from '../world/toys/gun';
import { dropHeld, startCharge, throwHeld } from '../world/toys/hands';
import { stick, touchInput } from '../world/touch';

// On foot, on a phone: a joystick to walk (bottom-left) and Use/Throw/Drop/Reload (bottom-right, above the phone
// button). HUD.tsx renders this only when touch is on, a panel isn't open and you're on your feet; dragging and
// tapping the 3D view itself (look and act on what's tapped) are Player.tsx's and CameraRig.tsx's job.

const STICK_RADIUS = 46;

function Joystick() {
  const ringRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    let id: number | null = null;
    let center = { x: 0, y: 0 };
    const apply = (e: PointerEvent) => {
      const s = stick(e.clientX - center.x, e.clientY - center.y, STICK_RADIUS);
      touchInput.x = s.x;
      touchInput.y = s.y;
      touchInput.run = s.run;
      setThumb({ x: s.x * STICK_RADIUS, y: s.y * STICK_RADIUS });
    };
    const release = () => {
      id = null;
      touchInput.x = 0;
      touchInput.y = 0;
      touchInput.run = false;
      setThumb({ x: 0, y: 0 });
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || id !== null) return;
      const r = ring.getBoundingClientRect();
      center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      id = e.pointerId;
      try {
        ring.setPointerCapture(e.pointerId);
      } catch {
        // a synthetic or already-released pointer: the ring still tracks it by id
      }
      e.preventDefault();
      apply(e);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      e.preventDefault();
      apply(e);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      release();
    };
    ring.addEventListener('pointerdown', onDown);
    ring.addEventListener('pointermove', onMove);
    ring.addEventListener('pointerup', onUp);
    ring.addEventListener('pointercancel', onUp);
    return () => {
      ring.removeEventListener('pointerdown', onDown);
      ring.removeEventListener('pointermove', onMove);
      ring.removeEventListener('pointerup', onUp);
      ring.removeEventListener('pointercancel', onUp);
      release();
    };
  }, []);

  return (
    <div className="touch-stick" ref={ringRef}>
      <div className="touch-stick-thumb" style={{ transform: `translate(${thumb.x}px, ${thumb.y}px)` }} />
    </div>
  );
}

export function TouchControls() {
  const held = useStore((s) => s.held);
  const focus = useStore((s) => s.focus);
  return (
    <div className="touch-controls">
      <Joystick />
      <div className="touch-buttons">
        {held?.kind === 'blaster' && (
          <button className="touch-btn" onClick={() => reloadHeld()} aria-label="Reload">
            🔄
          </button>
        )}
        {held && (
          <>
            <button
              className="touch-btn"
              onPointerDown={(e) => {
                e.preventDefault();
                startCharge();
              }}
              onPointerUp={(e) => {
                e.preventDefault();
                throwHeld();
              }}
              onPointerCancel={() => throwHeld()}
              aria-label="Throw"
            >
              🎯
            </button>
            <button
              className="touch-btn"
              onClick={() => {
                if (!placeSticky(focus, true) && !peelAimed(focus)) dropHeld();
              }}
              aria-label="Drop"
            >
              ⬇️
            </button>
          </>
        )}
        <button className="touch-btn touch-btn-use" onClick={() => interact()}>
          {focus ? focus.label : 'Use'}
        </button>
      </div>
    </div>
  );
}
