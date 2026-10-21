import { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../store';
import { drawPipeline, type FloorTag } from './drawOps';
import { useInteractable } from './interact';
import { MANAGER_KIOSK } from './layout';
import { alarmFocus, Beacon, BEZEL, Face, POST, useScreen } from './MissionControl';
import { Box, Cyl } from './Toon';

// The manager's kiosk (#29): a free-standing post beside the elevator on every office floor, a small piece of the
// lobby's mission control wall so the manager's console is one E away wherever you are. Both faces show the same
// pipeline screen as the lobby's wall (drawPipeline, with the same data); the beacon on top spins while an alarm
// is ringing, like the lobby's.

const PX: [number, number] = [1024, 602]; // same ratio as mission control's top screens

export function ManagerKiosk() {
  const ops = useStore((s) => s.ops);
  const repos = useStore((s) => s.repos);

  const tags = useMemo(
    () =>
      ops.floors.map((f) => {
        const r = repos.find((x) => x.id === f.repoId);
        const tag: FloorTag = { floor: f.floor, name: r ? (r.fullName.split('/')[1] ?? r.fullName) : f.repoId, color: r?.color ?? '#8d99ae' };
        return { tag, n: f };
      }),
    [ops.floors, repos],
  );
  const t = ops.total;
  const pipeline = useScreen(
    'kiosk-pipeline',
    PX,
    {
      floors: tags.map(({ tag, n }) => ({ ...tag, ready: n.ready, building: n.building, inQa: n.inQa, fixing: n.fixing, toMerge: n.toMerge, needsYou: n.needsYou, triage: n.triage })),
      total: { ready: t.ready, building: t.building, inQa: t.inQa, fixing: t.fixing, toMerge: t.toMerge, needsYou: t.needsYou, triage: t.triage },
    },
    drawPipeline,
  );
  const alarm = ops.alarms[0] ?? null;

  const ref = useInteractable<THREE.Group>(
    alarm ? alarmFocus('manager-kiosk', alarm) : { id: 'manager-kiosk', label: "Open the manager's console", action: { kind: 'manager', tab: 'ops' } },
    4,
  );

  const { rotY, w, d, postH, bodyH, x, z } = MANAGER_KIOSK;
  const screenY = postH + bodyH / 2;
  return (
    <group ref={ref} position={[x, 0, z]} rotation={[0, rotY, 0]}>
      <Cyl r={0.14} h={postH} position={[0, postH / 2, 0]} color={POST} outline shadow={false} />
      <Box size={[w, bodyH, d]} position={[0, screenY, 0]} color={BEZEL} outline shadow={false} />
      {/* front, toward the elevator doors */}
      <group position={[0, 0, d / 2]}>
        <Face tex={pipeline} w={w - 0.1} h={bodyH - 0.1} y={screenY} />
      </group>
      {/* back, toward the room: the same picture, turned to face -z */}
      <group position={[0, 0, -d / 2]} rotation={[0, Math.PI, 0]}>
        <Face tex={pipeline} w={w - 0.1} h={bodyH - 0.1} y={screenY} />
      </group>
      <group position={[0, postH + bodyH + 0.02, 0]}>
        <Beacon on={!!alarm} size={0.1} />
      </group>
    </group>
  );
}
