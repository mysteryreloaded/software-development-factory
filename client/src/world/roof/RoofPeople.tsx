import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, type Agent } from '../../store';
import { ding } from '../../ui/sfx';
import { smooth, type Gesture } from '../body';
import { Character } from '../Character';
import { HURRY_SPEED, isFree, nextWaypoint } from '../errands';
import { DECK_CHAIRS, HALF_D, deckChairFront, deckChairSeat } from '../layout';
import { bodyState, placeBody, say, seatBody, setBody, setHandJoint } from '../people';
import { nightFactor } from '../sky/time';
import { dayTime } from '../sky/useDayTime';
import { agentAtSeat, nook, NPC_SMOKE, nookStub, playerSeatsAt, setAgentSeat } from '../smokeBreak';
import { CABIN, DOORS_SECONDS } from '../socials';
import { clear, type Pt } from '../toys/roombaBrain';
import { steer, WALK_R, WALK_SPEED } from '../walkways';
import { RECLINE } from './DeckChairs';
import { endVisit, planVisit, roofVisits, startVisit, updateVisit, visitStage, type VisitKind } from './roofBreaks';
import { useRoofOp, useRoofReport } from './roofOps';
import { useRoof } from './roofState';
import { CALL_SPOTS, findRoofPath, LIFT, roofNav } from './roofWalks';

// Who is up on the roof (roofBreaks.ts): someone on a roof break steps out of the elevator, strolls to their deck chair
// and sits back in it (the whole person tips back with the chair), and when their time's up (or work comes in) goes
// back down; the CEO paces by the west railing, on a call. While you're up here, now and then someone free comes up on
// their own, a few at most. Their bodies are people.ts's, like everyone's; this only drives them.

const NORTH = 0; // body headings: 0 faces −z
const WEST = Math.PI / 2;
const HIP = 0.5; // a desk chair's seat height (Character.tsx), where the recline pivots
const SINK = 0.16; // a deck chair sits that much lower
/** Seconds between rolls for someone coming up while you're here, and the chances per roll. */
const ROLL = { every: 6, breakChance: 0.2, callChance: 0.06, ride: 2.5 };
const ALREADY_UP = 3000; // ms: a visit that started this long before you got here is already sat down

type Stage = 'riding' | 'doors' | 'walk' | 'sitting' | 'seated' | 'call' | 'leave';

interface Walker {
  id: string;
  kind: VisitKind;
  chair: number;
  /** A smoke bench seat (#58) instead of a deck chair; null for a deck chair or a call. */
  bench: 0 | 1 | null;
  stage: Stage;
  t: number;
  path: Pt[];
  wp: number;
  /** The call's pacing: which spot they're heading for, and seconds left standing there once they've got to it. */
  leg: number;
  hold: number;
  hurry: boolean;
  /** Seconds waited for the player in the way; then they walk on through for a moment. */
  waited: number;
  ghost: number;
  quietAt: number;
  /** The bench's own roll → light → puff timeline, in seconds since they sat down; -1 while not smoking. */
  smoke: number;
  puffsLeft: number;
  /** The last timeline stage applied (so each one only fires its side effect once); -1 before they've sat down. */
  stageIdx: number;
}

/** A walk from `from` to `to` round the furniture (straight there when the grid has no way). */
const route = (from: Pt, to: Pt): Pt[] => findRoofPath(from, to) ?? [to];

/** Standing in the gap by the roof's smoke bench (world/smokeBreak.ts), seat 0 or 1: where a bench visitor stands
 * (and faces), like every other errand's stand-in for actually sitting on arbitrary furniture. */
function benchStand(seat: 0 | 1): Pt {
  const n = nook('roof');
  return { x: (n.gap.minX + n.gap.maxX) / 2, z: n.seats[seat].z };
}

/** A visitor on the roof's smoke bench (#58): upright, not reclined, rolling and lighting one and taking six puffs. */
function Bencher({ agent, seat }: { agent: Agent; seat: 0 | 1 }) {
  const spot = benchStand(seat);
  return (
    <group position={[spot.x, 0, spot.z]} rotation={[0, nook('roof').yaw, 0]}>
      <Character agent={agent} />
    </group>
  );
}

/** A visitor on a break, drawn in their deck chair: they lean back with it while they sit. */
function Lounger({ agent, chair }: { agent: Agent; chair: number }) {
  const tilt = useRef<THREE.Group>(null);
  const seat = deckChairSeat(chair);
  useFrame(() => {
    const g = tilt.current;
    if (!g) return;
    const st = bodyState(agent.id);
    const k = st ? smooth(st.sit) : 1;
    g.rotation.x = RECLINE * k;
    g.position.y = HIP - SINK * k;
  });
  return (
    <group position={[seat.x, 0, seat.z]}>
      <group ref={tilt} position={[0, HIP - SINK, 0]} rotation={[RECLINE, 0, 0]}>
        <group position={[0, -HIP, 0]}>
          <Character agent={agent} />
        </group>
      </group>
    </group>
  );
}

/** The CEO on a call: never sits (there's no chair), so their "seat" is just where they pace. */
function Caller({ agent }: { agent: Agent }) {
  return (
    <group position={[CALL_SPOTS[0].x, 0, CALL_SPOTS[0].z]} rotation={[0, WEST, 0]}>
      <Character agent={agent} />
    </group>
  );
}

export function RoofPeople() {
  const camera = useThree((s) => s.camera);
  const agents = useStore((s) => s.agents);
  const [drawn, setDrawn] = useState<{ id: string; kind: VisitKind; chair: number; bench: 0 | 1 | null }[]>([]);
  const walkers = useMemo(() => new Map<string, Walker>(), []);
  const run = useMemo(() => ({ roll: ROLL.every, mounted: Date.now(), dirty: false }), []);

  // Off the roof: their visits carry on (roofBreaks.ts), but nobody here is driving their bodies any more. A bench
  // seat and a lit joint are this component's own (nothing else frees them), so a bench walker lets go of both:
  // nobody will be back to stub it out before the visit's own time runs out and roofVisits() forgets it.
  useEffect(
    () => () => {
      for (const w of walkers.values()) {
        if (w.bench != null) {
          setAgentSeat('roof', w.bench, null);
          setHandJoint(w.id, null);
        }
        seatBody(w.id);
        say(w.id, null);
      }
      walkers.clear();
    },
    [walkers],
  );

  /** Brings someone up now (the probe, or a roll while you're here). False when there's no room or they're busy. */
  const comeUp = (a: Agent | undefined, seconds?: number) => {
    if (!a || !isFree(a.status)) return false;
    const kind: VisitKind = a.role === 'ceo' ? 'call' : 'break';
    const v = planVisit(roofVisits(), a.id, kind, Date.now(), Math.random(), {
      chairs: DECK_CHAIRS.xs.length,
      playerChair: useRoof.getState().sitting,
      playerBenchSeats: playerSeatsAt('roof'),
      ride: ROLL.ride,
      stay: seconds,
    });
    if (v) startVisit(v);
    return !!v;
  };
  useRoofOp('visit', (arg) => {
    const [id, secs] = arg.split(':');
    const ok = comeUp(useStore.getState().agents[id], secs ? Number(secs) : undefined);
    if (!ok) useStore.getState().pushToast('info', '🛗 No room on the roof for them just now (or they are busy)');
  });
  useRoofReport('visitors', () =>
    [...walkers.values()].map((w) => ({ id: w.id, name: useStore.getState().agents[w.id]?.name ?? w.id, kind: w.kind, chair: w.chair, stage: w.stage, seated: bodyState(w.id)?.stage === 'seated' })),
  );

  const show = (w: Walker, on: boolean) => {
    run.dirty = true;
    if (on) walkers.set(w.id, w);
    else walkers.delete(w.id);
  };

  /** Off to the elevator and down (briskly when work's come in). */
  const leave = (w: Walker, hurry: boolean, from: Pt) => {
    w.stage = 'leave';
    w.hurry = hurry;
    w.path = [...route(from, LIFT), CABIN];
    w.wp = 0;
    w.waited = w.ghost = 0;
    say(w.id, null);
    if (hurry) updateVisit(w.id, { leave: Date.now() });
  };

  /** One frame along w's path; true once they're at its end and stood still. */
  const follow = (w: Walker, dt: number, gesture: Gesture, face?: number): boolean => {
    const st = bodyState(w.id);
    if (!st) return false;
    w.wp = nextWaypoint(w.path, w.wp, st);
    const goal = w.path[w.wp];
    const last = w.wp === w.path.length - 1;
    const dx = goal.x - st.x;
    const dz = goal.z - st.z;
    const d = Math.hypot(dx, dz);
    if (last && d < 0.08 && st.speed < 0.05) return true;
    const heading = last && face !== undefined ? face : Math.atan2(-dx, -dz);
    const speed = w.hurry ? HURRY_SPEED : WALK_SPEED;
    // Wait for the player (or anyone) in the way, a few seconds at most, then walk on through.
    if (d > 0.05 && w.ghost <= 0) {
      const others = [...walkers.values()].filter((o) => o !== w).flatMap((o) => {
        const b = bodyState(o.id);
        return b ? [{ id: o.id, x: b.x, z: b.z }] : [];
      });
      const s = steer({ id: w.id, x: st.x, z: st.z, dx: dx / d, dz: dz / d }, others, { x: camera.position.x, z: camera.position.z }, (x, z) => clear(roofNav().rects, x, z, WALK_R));
      if (s.wait || s.speed < 0.15) {
        w.waited += dt;
        if (w.waited > 3) w.ghost = 2;
        setBody(w.id, { mode: 'standing', x: st.x, z: st.z, heading: st.heading, gesture });
        return false;
      }
    }
    w.waited = 0;
    w.ghost = Math.max(0, w.ghost - dt);
    setBody(w.id, { mode: 'walking', x: goal.x, z: goal.z, heading, speed, gesture });
    return false;
  };

  const ROLL_END = NPC_SMOKE.roll;
  const LIGHT_END = ROLL_END + NPC_SMOKE.light;
  const CYCLE = NPC_SMOKE.puffGesture + NPC_SMOKE.puffGap;

  /** One frame of the bench's roll → light → puff timeline (w.smoke: seconds since they sat down). True once the
   * last puff is spent and they're ready to stub out and go. */
  const tickBenchSmoke = (w: Walker, dt: number): boolean => {
    w.smoke += dt;
    const t = w.smoke;
    let gesture: Gesture = 'roll';
    let stageIdx = 0;
    if (t >= ROLL_END && t < LIGHT_END) {
      gesture = 'light';
      stageIdx = 1;
    } else if (t >= LIGHT_END) {
      const pt = t - LIGHT_END;
      const cycle = Math.floor(pt / CYCLE);
      if (cycle >= NPC_SMOKE.puffs) return true;
      const within = pt - cycle * CYCLE;
      gesture = within < NPC_SMOKE.puffGesture ? 'puff' : 'none';
      stageIdx = 2 + cycle * 2 + (gesture === 'puff' ? 0 : 1);
    }
    if (stageIdx !== w.stageIdx) {
      w.stageIdx = stageIdx;
      if (stageIdx === 1) setHandJoint(w.id, { lit: true, puffsLeft: w.puffsLeft, exhaleAt: 0 });
      else if (gesture === 'puff') {
        w.puffsLeft = Math.max(0, w.puffsLeft - 1);
        setHandJoint(w.id, { lit: w.puffsLeft > 0, puffsLeft: w.puffsLeft, exhaleAt: performance.now() });
      }
    }
    const spot = benchStand(w.bench!);
    setBody(w.id, { mode: 'standing', x: spot.x, z: spot.z, heading: nook('roof').yaw, gesture });
    return false;
  };

  /** Lets go of the bench seat and the ashtray gets its stub, however the bench visit ends. */
  const endBenchSmoke = (w: Walker) => {
    if (w.bench == null) return;
    setAgentSeat('roof', w.bench, null);
    if (w.stageIdx >= 0) nookStub('roof'); // only once they'd actually rolled one
    setHandJoint(w.id, null);
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const now = Date.now();
    const s = useStore.getState();
    const day = nightFactor(dayTime.t) < 0.5;

    // Visits that have got here (or were already here when you came up).
    const visits = roofVisits(now);
    for (const v of visits) {
      if (walkers.has(v.id) || !s.agents[v.id]) continue;
      const stage = visitStage(v, now);
      if (stage === 'down') continue;
      const w: Walker = {
        id: v.id,
        kind: v.kind,
        chair: v.chair,
        bench: v.bench,
        stage: 'riding',
        t: 0,
        path: [],
        wp: 0,
        leg: 0,
        hold: -1,
        hurry: false,
        waited: 0,
        ghost: 0,
        quietAt: 0,
        smoke: 0,
        puffsLeft: NPC_SMOKE.puffs,
        stageIdx: -1,
      };
      if (stage === 'up' && (now - v.arrive > ALREADY_UP || now - run.mounted < 1000)) {
        // they were up here before you
        if (v.kind === 'call') {
          placeBody(v.id, CALL_SPOTS[0].x, CALL_SPOTS[0].z, WEST);
          setBody(v.id, { gesture: 'call' });
          w.stage = 'call';
        } else {
          w.stage = 'seated';
          if (w.bench != null) {
            const spot = benchStand(w.bench);
            placeBody(v.id, spot.x, spot.z, nook('roof').yaw);
            setAgentSeat('roof', w.bench, v.id);
          } else seatBody(v.id);
        }
      }
      show(w, true);
    }

    for (const w of walkers.values()) {
      const a = s.agents[w.id];
      const v = visits.find((x) => x.id === w.id);
      if (!a || (!v && w.stage === 'riding')) {
        if (!a) endBenchSmoke(w);
        seatBody(w.id);
        show(w, false);
        continue;
      }
      w.t += dt;
      const st = bodyState(w.id);
      const busy = !isFree(a.status);
      const over = !v || now >= v.leave;
      if (w.quietAt && now > w.quietAt) {
        say(w.id, null);
        w.quietAt = 0;
      }
      switch (w.stage) {
        case 'riding':
          if (v && now >= v.arrive) {
            placeBody(w.id, CABIN.x, CABIN.z, NORTH);
            ding({ x: 0, y: 2.6, z: HALF_D });
            w.stage = 'doors';
            w.t = 0;
            run.dirty = true; // out of the elevator: drawn from now on
          }
          break;
        case 'doors':
          if (w.t < DOORS_SECONDS) break;
          w.path = [LIFT, ...route(LIFT, w.kind === 'call' ? CALL_SPOTS[0] : w.bench != null ? benchStand(w.bench) : deckChairFront(w.chair))];
          w.wp = 0;
          w.hurry = busy;
          w.stage = 'walk';
          break;
        case 'walk':
          if (busy && !w.hurry && st) leave(w, true, st);
          else if (follow(w, dt, w.kind === 'call' ? 'call' : 'none', w.kind === 'call' ? WEST : w.bench != null ? nook('roof').yaw : NORTH)) {
            if (w.kind === 'call') {
              w.stage = 'call';
              w.t = 0;
            } else if (w.bench != null) {
              // the seat may have gone to someone else a moment ago (another visit's, or the player's own): back
              // up and head home instead
              if (agentAtSeat('roof', w.bench) != null || playerSeatsAt('roof').includes(w.bench)) {
                leave(w, false, st!);
                break;
              }
              setAgentSeat('roof', w.bench, w.id);
              w.smoke = 0;
              w.stage = 'seated';
            } else {
              seatBody(w.id); // the last steps to beside the chair, and down into it
              w.stage = 'sitting';
            }
          }
          break;
        case 'sitting':
          if (st?.stage === 'seated') {
            w.stage = 'seated';
            say(w.id, day ? '😎' : '🌙');
            w.quietAt = now + 3000;
          }
          break;
        case 'seated':
          if (w.bench != null) {
            if ((over || busy) && st) {
              endBenchSmoke(w);
              leave(w, busy, benchStand(w.bench));
              break;
            }
            if (tickBenchSmoke(w, dt)) {
              endBenchSmoke(w);
              leave(w, false, benchStand(w.bench));
            }
            break;
          }
          if ((over || busy) && st) leave(w, busy, deckChairFront(w.chair));
          break;
        case 'call': {
          if ((over || busy) && st) {
            leave(w, busy, st);
            break;
          }
          // pace between the two spots, the phone in hand, now and then a word or two
          const spot = CALL_SPOTS[w.leg];
          if (!w.path.length || w.path[w.path.length - 1] !== spot) {
            w.path = [spot];
            w.wp = 0;
          }
          if (!follow(w, dt, 'call', WEST)) break;
          if (w.hold < 0) {
            w.hold = 4 + Math.random() * 5; // a while at the railing, looking out
            if (Math.random() < 0.6) {
              say(w.id, Math.random() < 0.5 ? '📞' : '💬');
              w.quietAt = now + 2500;
            }
          }
          w.hold -= dt;
          if (w.hold <= 0) {
            w.leg = 1 - w.leg;
            w.hold = -1;
          }
          break;
        }
        case 'leave':
          if (follow(w, dt, 'none')) {
            endVisit(w.id);
            seatBody(w.id);
            say(w.id, null);
            show(w, false);
          }
          break;
      }
    }

    // Now and then, while you're up here, someone free comes up for a break, or the CEO for a call.
    run.roll -= dt;
    if (run.roll <= 0) {
      run.roll = ROLL.every;
      const up = new Set(visits.map((v) => v.id));
      const free = Object.values(s.agents).filter((a) => !up.has(a.id) && isFree(a.status));
      const team = free.filter((a) => a.role !== 'ceo');
      if (team.length && Math.random() < ROLL.breakChance) comeUp(team[Math.floor(Math.random() * team.length)]);
      const ceo = free.find((a) => a.role === 'ceo');
      if (ceo && Math.random() < ROLL.callChance) comeUp(ceo);
    }

    if (run.dirty) {
      run.dirty = false;
      setDrawn([...walkers.values()].filter((w) => w.stage !== 'riding').map((w) => ({ id: w.id, kind: w.kind, chair: w.chair, bench: w.bench })));
    }
  });

  return (
    <group>
      {drawn.map((d) => {
        const a = agents[d.id];
        if (!a) return null;
        if (d.kind === 'call') return <Caller key={d.id} agent={a} />;
        return d.bench != null ? <Bencher key={d.id} agent={a} seat={d.bench} /> : <Lounger key={d.id} agent={a} chair={d.chair} />;
      })}
    </group>
  );
}
