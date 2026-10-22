// A pendant lamp over every busy agent's desk (#52), so the manager can count busy desks by their lit circles, on the
// floor or from the overview. Cheap: no three.js lights or shadows, one geometry and material per part (made once,
// lazily so nothing touches the DOM at import time), no useFrame. It switches on and off with the agent's status,
// no fade. Lives inside Desk's group, in desk space (desk top y 0.77, chair at z 0.8).
import { useEffect } from 'react';
import * as THREE from 'three';
import { markBloom } from './gfx/bloomMarks';
import { DESK_LAMP } from './deskLampRule';

const noRaycast = () => null;

/** Which desk slots currently have a lamp mounted (lit), for window.__swarmDeskLamps. */
const litSlots = new Set<number>();
let busyCount = 0;

/** OfficeFloor's busy count (its sign's "⚙️ N busy"), kept alongside litSlots so a probe can compare them. */
export function setDeskLampBusy(n: number) {
  busyCount = n;
}

if (typeof window !== 'undefined' && !Object.getOwnPropertyDescriptor(window, '__swarmDeskLamps')) {
  Object.defineProperty(window, '__swarmDeskLamps', {
    get: () => ({ lit: [...litSlots].sort((a, b) => a - b), busy: busyCount }),
    enumerable: false,
  });
}

function warmPoolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The beam cone's own texture: even all round (it only varies down the cylinder's V axis), bright at the shade's
 * mouth and fading to nothing at the floor. */
function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

interface Parts {
  cordGeometry: THREE.CylinderGeometry;
  shadeGeometry: THREE.CylinderGeometry;
  shadeCapGeometry: THREE.CircleGeometry;
  bulbGeometry: THREE.SphereGeometry;
  beamGeometry: THREE.CylinderGeometry;
  floorPoolGeometry: THREE.CircleGeometry;
  deskPoolGeometry: THREE.PlaneGeometry;
  cordMaterial: THREE.MeshBasicMaterial;
  shadeMaterial: THREE.MeshBasicMaterial;
  bulbMaterial: THREE.MeshBasicMaterial;
  beamMaterial: THREE.MeshBasicMaterial;
  floorPoolMaterial: THREE.MeshBasicMaterial;
  deskPoolMaterial: THREE.MeshBasicMaterial;
}

let shared: Parts | null = null;

function parts(): Parts {
  if (shared) return shared;
  const L = DESK_LAMP;

  const cordGeometry = new THREE.CylinderGeometry(0.012, 0.012, L.cordTopY - L.shadeTopY, 6).translate(0, (L.cordTopY - L.shadeTopY) / 2, 0);
  const shadeGeometry = new THREE.CylinderGeometry(L.shadeTopR, L.shadeBottomR, L.shadeTopY - L.shadeBottomY, 16, 1, true).translate(0, (L.shadeTopY - L.shadeBottomY) / 2, 0);
  const shadeCapGeometry = new THREE.CircleGeometry(L.shadeTopR, 16).rotateX(-Math.PI / 2);
  const bulbGeometry = new THREE.SphereGeometry(L.bulbR, 12, 10);
  const beamGeometry = new THREE.CylinderGeometry(L.beamTopR, L.floorPool.r, L.shadeBottomY, 20, 1, true).translate(0, L.shadeBottomY / 2, 0);
  const floorPoolGeometry = new THREE.CircleGeometry(L.floorPool.r, 32).rotateX(-Math.PI / 2);
  const deskPoolGeometry = new THREE.PlaneGeometry(L.deskPool.w, L.deskPool.d).rotateX(-Math.PI / 2);

  const cordMaterial = new THREE.MeshBasicMaterial({ color: '#33363f', toneMapped: false });
  const shadeMaterial = new THREE.MeshBasicMaterial({ color: '#3d4252', toneMapped: false, side: THREE.DoubleSide });
  const bulbMaterial = markBloom(new THREE.MeshBasicMaterial({ color: '#fff2c4', toneMapped: false }));

  const tex = warmPoolTexture();
  const beamMaterial = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    color: '#ffdca8',
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const poolOpts = { map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } as const;
  const floorPoolMaterial = new THREE.MeshBasicMaterial({ ...poolOpts, color: '#ffb35c', opacity: 0.55 });
  const deskPoolMaterial = new THREE.MeshBasicMaterial({ ...poolOpts, color: '#ffcf85', opacity: 0.5 });

  shared = { cordGeometry, shadeGeometry, shadeCapGeometry, bulbGeometry, beamGeometry, floorPoolGeometry, deskPoolGeometry, cordMaterial, shadeMaterial, bulbMaterial, beamMaterial, floorPoolMaterial, deskPoolMaterial };
  return shared;
}

/** The lamp over desk `slot`, only while `lit` (OfficeFloor passes deskLampLit(agent?.status)). */
export function DeskLamp({ slot, lit }: { slot: number; lit: boolean }) {
  useEffect(() => {
    if (!lit) return;
    litSlots.add(slot);
    return () => {
      litSlots.delete(slot);
    };
  }, [slot, lit]);

  if (!lit) return null;
  const p = parts();
  const L = DESK_LAMP;
  return (
    <>
      <mesh geometry={p.cordGeometry} material={p.cordMaterial} position={[0, L.shadeTopY, 0]} />
      <mesh geometry={p.shadeGeometry} material={p.shadeMaterial} position={[0, L.shadeBottomY, 0]} />
      <mesh geometry={p.shadeCapGeometry} material={p.shadeMaterial} position={[0, L.shadeTopY, 0]} />
      <mesh geometry={p.bulbGeometry} material={p.bulbMaterial} position={[0, L.bulbY, 0]} />
      <mesh geometry={p.beamGeometry} material={p.beamMaterial} raycast={noRaycast} />
      <mesh geometry={p.floorPoolGeometry} material={p.floorPoolMaterial} position={[0, 0.006, L.floorPool.z]} raycast={noRaycast} />
      <mesh geometry={p.deskPoolGeometry} material={p.deskPoolMaterial} position={[0, L.deskPool.y, 0]} raycast={noRaycast} />
    </>
  );
}
