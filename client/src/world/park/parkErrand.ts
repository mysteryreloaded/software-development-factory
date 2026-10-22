// The free agent's trip out to the park for a penalty shoot-out (#46), seen from their own floor (like roofErrand.ts):
// into the elevator and out of sight; ParkOpponent.tsx takes it from there, walking them out of the revolving door
// to the goal and back. A scripted errand (errands.ts) the errand director runs on whichever floor they're on.

import { registerErrand, type Act, type ErrandScript } from '../errands';
import { CABIN, DOORS_SECONDS } from '../socials';
import { setHidden } from '../people';
import { parkAwayId, penaltyMatch, setParkAway } from './penaltyState';

const NORTH = 0; // a body heading facing -z: out through the cabin's doors
const DOORS_SHUT = 0.9; // seconds stood in the cabin before the doors close on them

/** Into the cabin and out of sight; once ParkOpponent.tsx has walked them back, out again to their desk. */
function headOut(id: string): ErrandScript {
  let stage: 'in' | 'doors' | 'away' | 'out' = 'in';
  let t = 0;
  const act: Act = { do: 'walk', x: CABIN.x, z: CABIN.z, heading: NORTH, gesture: 'none' };
  const doing = (d: Act['do']) => ((act.do = d), act);
  return {
    tick(me) {
      switch (stage) {
        case 'in':
          if (!me.arrived) return doing('walk');
          stage = 'doors';
          t = 0;
          return doing('stand');
        case 'doors':
          t += me.dt;
          if (t < DOORS_SHUT) return doing('stand');
          setParkAway(id);
          setHidden(id, true);
          stage = 'away';
          return doing('stand');
        case 'away':
          if (parkAwayId() === id) return doing('stand'); // still out there (or on the way)
          setHidden(id, false);
          stage = 'out';
          t = 0;
          return doing('stand');
        case 'out':
          t += me.dt;
          return doing(t < DOORS_SECONDS ? 'stand' : 'done');
      }
    },
    end() {
      setHidden(id, false);
    },
  };
}

registerErrand({
  name: 'penalty',
  // Not something anyone fancies at random (unlike the idle errands' weighted pick): requestPenaltyMatch() has
  // already chosen this one agent, so `work: true` queues it at once rather than leaving it to that lottery.
  work: true,
  when: (a) => penaltyMatch()?.opponentId === a.id && penaltyMatch()?.stage === 'walkup' && parkAwayId() !== a.id,
  spot: ['elevator'],
  steps: [],
  max: 1,
  script: (a) => headOut(a.id),
});
