import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { fridgeNow, puddleFade, puddlesOf, type Puddle } from './fridge';
import { toon } from './materials';

// What's left of a melted ice cream (fridge.ts has the rules: at most PUDDLE.cap on a floor, the oldest going first,
// each one drying up after PUDDLE.life seconds): a flat irregular cream/pink blob with a soggy cone on top, fading
// out over its last 10 s.

const BLOB = new THREE.CircleGeometry(1, 16);
// Nudge every other point in and out so the puddle's edge isn't a perfect circle.
for (let i = 0; i < BLOB.attributes.position.count; i++) {
  if (i === 0) continue; // the centre vertex
  const k = 0.82 + 0.22 * Math.sin(i * 2.4) * Math.cos(i * 1.3);
  BLOB.attributes.position.setX(i, BLOB.attributes.position.getX(i) * k);
  BLOB.attributes.position.setY(i, BLOB.attributes.position.getY(i) * k);
}
BLOB.computeVertexNormals();

const CONE = new THREE.ConeGeometry(0.05, 0.09, 8);

function PuddleBlob({ puddle }: { puddle: Puddle }) {
  const [fade, setFade] = useState(1);
  useFrame(() => setFade(puddleFade(puddle, fridgeNow())));
  if (fade <= 0) return null;
  return (
    <group position={[puddle.x, 0.004, puddle.z]} rotation={[0, (puddle.bornAt * 37) % (Math.PI * 2), 0]} scale={0.35}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} geometry={BLOB} material={toon('#ffe8f0', { transparent: true, opacity: 0.85 * fade })} renderOrder={1} />
      <mesh position={[0, 0.1, 0]} rotation={[Math.PI, 0, 0]} geometry={CONE} material={toon('#fff5e6', { transparent: true, opacity: 0.85 * fade })} />
    </group>
  );
}

/** Every melted-ice-cream puddle on `floor`, re-read every half second (they only change when one's dropped or dries up). */
export function Puddles({ floor }: { floor: number }) {
  const [puddles, setPuddles] = useState<Puddle[]>(() => puddlesOf(floor));
  useEffect(() => {
    setPuddles(puddlesOf(floor));
    const id = setInterval(() => setPuddles(puddlesOf(floor)), 500);
    return () => clearInterval(id);
  }, [floor]);
  return (
    <>
      {puddles.map((p) => (
        <PuddleBlob key={p.id} puddle={p} />
      ))}
    </>
  );
}
