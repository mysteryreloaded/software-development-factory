// The free agent's walk out to the goal and back (#46): claims the match's opponent itself, like RoofPeople claims a
// roof visit, the moment it's in 'walkup' - there's no floor-specific errand to wait on (their own floor isn't even
// mounted while you're down here: lobby-only, like the park itself, City.tsx). Steps out of the revolving door (the
// CEO instead walks out from their own desk, already in the lobby), walks the open grounds (a single rectangle,
// outside/grounds.ts: no obstacles, so a straight line always does) to the penalty spot, and stands there for the
// match; work calling them back, or the match ending, sends them the same way home. Drives the clock (tickPenalty)
// too.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { CEO_ID } from '../../../../shared/types';
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

  // Leaving the lobby mid-walk (ParkOpponent is lobby-only, City.tsx): back to their chair, like RoofPeople's own
  // unmount cleanup, so they aren't left stranded out here with nobody driving them.
  useEffect(
    () => () => {
      const w = walker.current;
      if (!w) return;
      seatBody(w.id);
      say(w.id, null);
      walker.current = null;
      setParkAway(null);
    },
    [],
  );

  useFrame(() => {
    tickPenalty();
    // Claim the waiting match ourselves (like RoofPeople claims a roof visit): nobody else will.
    const m0 = penaltyMatch();
    if (!parkAwayId() && m0 && m0.stage === 'walkup') setParkAway(m0.opponentId);
    const away = parkAwayId();
    if (away !== drawn) setDrawn(away);
    let w = walker.current;

    if (!w && away) {
      // everyone else's body isn't drawn anywhere down here until they step out of the revolving door; the CEO's
      // already is (Desk.tsx, their desk is in the lobby too), so they walk out from wherever they actually are.
      if (away !== CEO_ID) placeBody(away, DOOR.x, DOOR.z, facing(DOOR.x, DOOR.z, goal.spotX, goal.z));
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
      const d = Math.hypot(target.x - at.x, target.z - at.z);
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
        // the target is the destination itself, not an incremental step: body.ts's own walkTo() accelerates and
        // covers the ground over the following frames (like ErrandDirector's and RoofPeople's own follow()).
        const heading = Math.atan2(-(target.x - at.x), -(target.z - at.z));
        setBody(w.id, { mode: 'walking', x: target.x, z: target.z, heading, speed: WALK_SPEED });
      }
      return;
    }

    // playing: at the start of each kick, stand where this kick's role puts them (shooting the spot, keeping the line)
    if (m && m.stage === 'setup') {
      const at = m.turn === 'opponent' ? shooterSpot : keeperSpot;
      setBody(w.id, { mode: 'standing', x: at.x, z: at.z, heading: facing(at.x, at.z, goal.lineX, goal.z) });
    }
  });

  // The CEO's own desk (Desk.tsx, part of the lobby) already draws them wherever their body is; a second
  // <Character> for the same id would be a duplicate (there's no setHidden to paper over it: that hid every
  // copy, this one included). Everyone else's desk is on a floor that isn't mounted down here.
  const agent = drawn && drawn !== CEO_ID ? agents[drawn] : null;
  return agent ? <Character agent={agent} /> : null;
}
