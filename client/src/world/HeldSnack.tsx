import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store';
import { Outlines } from './Outlines';
import { toon } from './materials';
import { SNACKS, fridgeNow, meltStage } from './fridge';
import { sipPose } from './toys/sipping';
import { FIRST_PERSON } from './viewTags';

// The snack in your hands, held like a mug or the roof's sausage: in view at the lower right, raised to your mouth
// for each bite/sip/go/lick (sipping.ts times it), a little smaller with every portion. A held ice cream sags and
// drips the longer it's out of the freezer (fridge.ts's melt stages), until it leaves your hands as a puddle.

const VIEW = { x: 0.17, y: -0.15, z: -0.42, tilt: -0.4, turn: 0.6 };
const MOUTH = { x: 0.03, y: -0.08, z: -0.22, tilt: -0.1, turn: 1.2 };
const INK = '#1f1d2b';

const COLORS: Record<string, string> = { bar: '#8a5a32', water: '#8ecae6', candy: '#f72585', icecream: '#fdf4e3' };

export function HeldSnack() {
  const held = useStore((s) => (s.held?.kind === 'snack' ? s.held : null));
  const root = useRef<THREE.Group>(null);
  const hand = useRef<THREE.Group>(null);
  // An ice cream keeps sagging while held, which needs a re-render to show without waiting for `held` itself to
  // change (it only does on a bite or a drop).
  const [, retick] = useState(0);
  useEffect(() => {
    if (held?.snack !== 'icecream') return;
    const id = setInterval(() => retick((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, [held]);
  useFrame(({ camera }) => {
    const r = root.current;
    const h = hand.current;
    if (!r || !h) return;
    r.position.copy(camera.position);
    r.quaternion.copy(camera.quaternion);
    const k = sipPose.lift;
    const t = performance.now() / 1000;
    h.position.set(VIEW.x + (MOUTH.x - VIEW.x) * k, VIEW.y + (MOUTH.y - VIEW.y) * k + Math.sin(t * 1.6) * 0.003 * (1 - k), VIEW.z + (MOUTH.z - VIEW.z) * k);
    h.rotation.set(VIEW.tilt + (MOUTH.tilt - VIEW.tilt) * k, VIEW.turn + (MOUTH.turn - VIEW.turn) * k, 0, 'YXZ');
  });
  if (!held) return null;
  const def = SNACKS[held.snack];
  const left = Math.max(0.3, held.left / def.portions);
  const scale = 0.6 + 0.4 * left;
  const melt = held.snack === 'icecream' ? meltStage(held.outAt, fridgeNow()) : 'fresh';
  const sag = melt === 'puddle' ? 1 : melt === 'soft' ? 0.5 : 0;
  const color = COLORS[held.snack];
  return (
    <group ref={root} userData={FIRST_PERSON}>
      <group ref={hand} scale={0.85}>
        <group scale={[scale, scale * (1 - sag * 0.3), scale]}>
          {held.snack === 'water' ? (
            <mesh material={toon(color)}>
              <cylinderGeometry args={[0.028, 0.032, 0.14, 10]} />
              <Outlines thickness={0.004} color={INK} />
            </mesh>
          ) : held.snack === 'icecream' ? (
            <>
              <mesh position={[0, -0.03, 0]} rotation={[Math.PI, 0, 0]} material={toon('#e9c46a')}>
                <coneGeometry args={[0.03, 0.08, 8]} />
                <Outlines thickness={0.004} color={INK} />
              </mesh>
              <mesh position={[0, 0.03 + sag * 0.015, 0]} scale={[1, 1 - sag * 0.35, 1]} material={toon(color)}>
                <sphereGeometry args={[0.035, 10, 8]} />
                <Outlines thickness={0.004} color={INK} />
              </mesh>
              {sag > 0 && (
                <mesh position={[0.01, -0.01 - sag * 0.03, 0.015]} scale={[0.5, 1 + sag, 0.5]} material={toon(color)}>
                  <capsuleGeometry args={[0.006, 0.02, 2, 4]} />
                </mesh>
              )}
            </>
          ) : held.snack === 'candy' ? (
            <mesh material={toon(color)}>
              <sphereGeometry args={[0.03, 10, 8]} />
              <Outlines thickness={0.004} color={INK} />
            </mesh>
          ) : (
            <mesh material={toon(color)}>
              <boxGeometry args={[0.1, 0.03, 0.045]} />
              <Outlines thickness={0.004} color={INK} />
            </mesh>
          )}
        </group>
      </group>
    </group>
  );
}
