// The free agent's walk out to the goal and back (#46): once parkErrand.ts has hidden them from their own floor,
// they step out of the revolving door, walk the open grounds (a single rectangle, outside/grounds.ts: no obstacles,
// so a straight line always does) to the penalty spot, and stand there for the match; work calling them back, or the
// match ending, sends them the same way home. Mounted with the city (outside/City.tsx), so it runs on every floor,
// and the billboard and the match stay visible from the office windows. Drives the clock (tickPenalty) too.

import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useStore } from '../../store';
import { Character } from '../Character';
import { isFree } from '../errands';
import { HALF_W, SIDE_OPENINGS, WALL_T } from '../layout';
import { bodyState, placeBody, say, seatBody, setBody } from '../people';
import { WALK_SPEED } from '../walkways';
import { goalPitch } from './parkPitch';
import { parkAwayId, penaltyMatch, penaltyOpponentArrived, setParkAway, tickPenalty } from './penaltyState';
import './penaltyProbe';

const DOOR = { x: -(HALF_W + WALL_T) + 1.2, z: SIDE_OPENINGS.lobby.west.door };

type Stage = 'toSpot' | 'playing' | 'toDoor';
interface Walker {
  id: string;
  stage: Stage;
}

/** Faces along the line from (x, z) towards (tx, tz) (body.ts heading 0 faces -z). */
const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));

export function ParkOpponent() {
  const agents = useStore((s) => s.agents);
  const walker = useRef<Walker | null>(null);
  const goal = useMemo(goalPitch, []);
  const keeperSpot = { x: goal.lineX + 0.6, z: goal.z };
  const shooterSpot = { x: goal.spotX, z: goal.z };
  const [drawn, setDrawn] = useState<string | null>(null);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    tickPenalty();
    const away = parkAwayId();
    if (away !== drawn) setDrawn(away);
    let w = walker.current;

    if (!w && away) {
      placeBody(away, DOOR.x, DOOR.z, facing(DOOR.x, DOOR.z, goal.spotX, goal.z));
      w = walker.current = { id: away, stage: 'toSpot' };
    }
    if (!w) return;
    const a = agents[w.id];
    if (!a) {
      seatBody(w.id);
      walker.current = null;
      setParkAway(null);
      return;
    }
    const m = penaltyMatch();
    const busy = !isFree(a.status);
    const over = !m || m.opponentId !== w.id || m.stage === 'over';
    if (w.stage !== 'toDoor' && (over || busy)) {
      say(w.id, null);
      w.stage = 'toDoor';
    }

    if (w.stage === 'toSpot' || w.stage === 'toDoor') {
      const target = w.stage === 'toSpot' ? shooterSpot : DOOR;
      const at = bodyState(w.id) ?? { x: DOOR.x, z: DOOR.z };
      const tx = target.x - at.x;
      const tz = target.z - at.z;
      const d = Math.hypot(tx, tz);
      if (d < 0.1) {
        setBody(w.id, { mode: 'standing', x: target.x, z: target.z, heading: facing(target.x, target.z, goal.lineX, goal.z) });
        if (w.stage === 'toSpot') {
          w.stage = 'playing';
          penaltyOpponentArrived();
        } else {
          seatBody(w.id);
          walker.current = null;
          setParkAway(null);
        }
      } else {
        const heading = Math.atan2(-tx, -tz);
        const step = Math.min(d, WALK_SPEED * dt);
        setBody(w.id, { mode: 'walking', x: at.x + (tx / d) * step, z: at.z + (tz / d) * step, heading, speed: WALK_SPEED });
      }
      return;
    }

    // playing: at the start of each kick, stand where this kick's role puts them (shooting the spot, keeping the line)
    if (m && m.stage === 'setup') {
      const at = m.turn === 'opponent' ? shooterSpot : keeperSpot;
      setBody(w.id, { mode: 'standing', x: at.x, z: at.z, heading: facing(at.x, at.z, goal.lineX, goal.z) });
    }
  });

  const agent = drawn ? agents[drawn] : null;
  return agent ? <Character agent={agent} /> : null;
}
