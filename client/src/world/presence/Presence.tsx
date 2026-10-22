import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { VisitorHeld, VisitorPose } from '../../../../shared/types';
import { useStore, type Held } from '../../store';
import { photoActive } from '../../photo/gate';
import { isConfirmOpen } from '../../ui/Confirm';
import { isKey } from '../../ui/controls';
import { cameraMode, exitView, followBody, followingId, followOnFloor, playerAt, rigOwnsCamera } from '../camera/rig';
import { Pings, pingHere } from './Pings';
import { drawnVisitors, remoteOf, seatedVisitors, setFloorHere, setFollower, syncSelf, tickPresence } from './presenceState';
import { Visitors, visitorBodyId } from './Visitors';
import { mySmokeHeld, parseSeatId, setSmokeVisitorsProbe } from '../smokeBreak';

// Wires the smoke break's own probe (#59) to presence, without smokeBreak.ts importing presence code (its own
// comment explains why): the server's demoVisitors.ts needs that file's pure nook geometry and stage timings.
setSmokeVisitorsProbe(() =>
  seatedVisitors()
    .map(({ id, seat, held }) => {
      const parsed = parseSeatId(seat);
      return parsed && { id, nook: parsed.nookId, seat: parsed.seat, puffsLeft: held?.k === 'joint' ? held.s ?? null : null, lit: held?.k === 'joint' && held.l === 1, rolling: held?.k === 'joint' && held.r === 1 };
    })
    .filter((v): v is NonNullable<typeof v> => !!v),
);

// Shared presence in the 3D view (#223): the other visitors on this floor and their pings, following one with the
// camera (rig.ts's follow cam, riding the elevator after them), and this tab's own pose going out (presenceState.ts
// sends it only when it changed, at most ten times a second).

/** What's in your hands, as the others draw it (a sticky stays yours). */
export function heldForOthers(h: Held | null): VisitorHeld | null {
  if (!h) return null;
  if (h.kind === 'mug') return { k: 'mug', id: h.id, s: h.sips };
  if (h.kind === 'ball' || h.kind === 'blaster') return { k: h.kind, id: h.id };
  return null;
}

// ---------- following a visitor ----------

const VISITOR = 'visitor:';
/** The visitor the follow cam trails (or is on its way to), by presence id; null for nobody or someone else. */
const followedVisitor = () => {
  const id = followingId();
  return id?.startsWith(VISITOR) ? id.slice(VISITOR.length) : null;
};

function followVisitor(id: string) {
  const r = remoteOf(id);
  if (!r) return false;
  followOnFloor(r.floor, followBody(visitorBodyId(id), r.name));
  return true;
}

setFollower({ start: followVisitor, stop: () => void (followedVisitor() && exitView()), current: followedVisitor });

/** They walked into the elevator and are gone from this floor: ride after them, and carry on following up there. */
function rideAlong(floor: number, travelling: boolean) {
  const id = followedVisitor();
  if (!id || travelling || cameraMode() !== 'follow') return;
  const r = remoteOf(id);
  if (r && r.floor !== floor && !drawnVisitors().includes(id)) followVisitor(id);
}

// ---------- input ----------

/** The ping key (X) drops a marker where you aim, on the spot or thing under the crosshair. */
function usePingInput() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const ready = s.started && !s.overlay && !s.travel && !s.replaying && !photoActive() && !isConfirmOpen();
      if (!isKey('ping', e.code) || e.repeat || e.ctrlKey || e.metaKey || e.altKey || cameraMode() !== 'first' || !ready) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      pingHere();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---------- the scene ----------

const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function Presence() {
  const floor = useStore((s) => s.floor);
  const camera = useThree((s) => s.camera);
  useEffect(() => setFloorHere(floor), [floor]);
  usePingInput();

  useFrame(() => {
    const s = useStore.getState();
    const now = performance.now();
    tickPresence(now);
    rideAlong(s.floor, !!s.travel);
    let pose: VisitorPose | null = null;
    if (s.started && !s.travel) {
      // In the overview, following someone or in photo mode, you're still where you stood (rig.ts playerAt), not
      // where the camera is.
      const away = rigOwnsCamera() || photoActive();
      euler.setFromQuaternion(camera.quaternion, 'YXZ');
      pose = {
        ts: Math.round(now),
        f: s.floor,
        x: r2(away ? playerAt.x : camera.position.x),
        z: r2(away ? playerAt.z : camera.position.z),
        h: r3(away ? playerAt.yaw : euler.y),
        p: away ? 0 : r3(euler.x),
        held: heldForOthers(s.held),
      };
      // On a smoke break (#59): others draw you seated there, holding the joint, whatever x/z/held say above.
      const smoke = mySmokeHeld();
      if (smoke) {
        pose.s = smoke.seat;
        if (smoke.held) pose.held = smoke.held;
      }
    }
    syncSelf({ started: s.started, floor: s.floor, pose }, now);
  });

  return (
    <>
      <Visitors />
      <Pings />
    </>
  );
}
