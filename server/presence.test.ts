import { describe, expect, it } from 'vitest';
import { FLOOR_CAP } from '../shared/presence.ts';
import type { ServerEvent } from '../shared/types.ts';
import { EMOTE_GAP_MS, PresenceHub, RELAY_GAP_MS, recipients, roster, visibleOn, type Peer } from './presence.ts';

// ---------- the pure rules ----------

let seq = 0;
const peer = (patch: Partial<Peer> = {}): Peer => ({
  id: `p${seq}`,
  seq: seq++,
  name: 'Visitor',
  color: '#ef476f',
  mode: 'visible',
  floor: 1,
  pose: { ts: 0, f: 1, x: 0, z: 0, h: 0, p: 0, held: null },
  relayedAt: 0,
  dirty: false,
  emoteAt: 0,
  pingAt: 0,
  send: () => undefined,
  walker: null,
  ...patch,
});

describe('interest rules', () => {
  it('a pose reaches everyone else on the same floor, and nobody elsewhere', () => {
    const a = peer();
    const b = peer();
    const watcher = peer({ mode: 'watching', pose: null });
    const upstairs = peer({ floor: 2 });
    const away = peer({ mode: 'away', floor: null, pose: null });
    expect(recipients([a, b, watcher, upstairs, away], a)).toEqual([b, watcher]);
  });

  it("someone who doesn't appear, or isn't in the office, sends nothing", () => {
    const a = peer({ mode: 'watching' });
    const b = peer();
    expect(recipients([a, b], a)).toEqual([]);
    expect(recipients([peer({ mode: 'away', floor: null }), b], peer({ mode: 'away', floor: null }))).toEqual([]);
  });

  it('caps a floor at FLOOR_CAP visitors, in join order: the rest are not relayed', () => {
    const crowd = Array.from({ length: FLOOR_CAP + 3 }, () => peer());
    expect(visibleOn(crowd, 1)).toEqual(crowd.slice(0, FLOOR_CAP));
    expect(recipients(crowd, crowd[FLOOR_CAP - 1])).toHaveLength(FLOOR_CAP + 2);
    expect(recipients(crowd, crowd[FLOOR_CAP])).toEqual([]); // 17th: drawn by nobody, so relayed to nobody
    expect(visibleOn(crowd, 2)).toEqual([]);
  });

  it('fake visitors are never sent anything', () => {
    const a = peer();
    const fake = peer({ walker: {} as Peer['walker'] });
    expect(recipients([a, fake], a)).toEqual([]);
  });

  it('the roster lists everyone appearing, on any floor, in join order', () => {
    const a = peer({ name: 'Ada', floor: 2 });
    const b = peer({ name: 'Bo', mode: 'watching' });
    const c = peer({ name: 'Cy', floor: 0 });
    expect(roster([c, b, a]).map((v) => [v.name, v.floor])).toEqual([
      ['Ada', 2],
      ['Cy', 0],
    ]);
  });
});

// ---------- the hub ----------

interface Tab {
  peer: Peer;
  got: ServerEvent[];
  say: (msg: unknown) => void;
  last: <T extends ServerEvent['type']>(type: T) => Extract<ServerEvent, { type: T }> | undefined;
  all: <T extends ServerEvent['type']>(type: T) => Extract<ServerEvent, { type: T }>[];
}

function setup(demo = false) {
  let now = 1_000;
  const hub = new PresenceHub({ demo, now: () => now, timer: false });
  const tab = (): Tab => {
    const got: ServerEvent[] = [];
    const p = hub.join((data) => got.push(JSON.parse(data) as ServerEvent));
    const all = <T extends ServerEvent['type']>(type: T) => got.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
    return { peer: p, got, say: (msg) => hub.receive(p, JSON.stringify(msg)), all, last: (type) => all(type).at(-1) };
  };
  return { hub, tab, advance: (ms: number) => void (now += ms) };
}

const pose = (f: number, x = 0, z = 0, extra: object = {}) => ({ type: 'pose', ts: 1, f, x, z, h: 0, p: 0, held: null, ...extra });

describe('PresenceHub', () => {
  it('relays a pose to the other tab on the floor, with the cleaned name in the roster', () => {
    const { tab, advance } = setup();
    const a = tab();
    const b = tab();
    a.say({ type: 'hello', name: '  <b>Ada</b>\u0000 ', color: '#118AB2' });
    a.say(pose(1, 2, 3));
    b.say({ type: 'watch', f: 1 });
    expect(b.last('visitors')?.visitors).toEqual([{ id: a.peer.id, name: '<b>Ada</b>', color: '#118ab2', floor: 1 }]);
    expect(b.last('visitorPose')).toMatchObject({ id: a.peer.id, f: 1, x: 2, z: 3 }); // caught up on arrival
    advance(RELAY_GAP_MS);
    a.say(pose(1, 4, 3));
    expect(b.last('visitorPose')).toMatchObject({ x: 4 });
    expect(a.all('visitorPose')).toEqual([]); // nobody hears themselves
    expect(a.last('visitors')?.visitors).toEqual([]); // nor sees themselves in the list
  });

  it('holds back poses sent faster than the relay gap and flushes the latest on the next tick', () => {
    const { hub, tab, advance } = setup();
    const a = tab();
    const b = tab();
    b.say({ type: 'watch', f: 1 });
    a.say(pose(1, 1));
    advance(20);
    a.say(pose(1, 2));
    a.say(pose(1, 3));
    expect(b.all('visitorPose').map((e) => e.x)).toEqual([1]);
    advance(RELAY_GAP_MS);
    hub.tick();
    expect(b.all('visitorPose').map((e) => e.x)).toEqual([1, 3]);
    hub.tick();
    expect(b.all('visitorPose')).toHaveLength(2); // nothing new: nothing sent
  });

  it('drops what happens on other floors', () => {
    const { tab } = setup();
    const a = tab();
    const b = tab();
    b.say(pose(2));
    a.say(pose(1));
    a.say({ type: 'emote', e: 'wave' });
    a.say({ type: 'ping', x: 0, y: 1, z: 0, label: 'here' });
    expect(b.all('visitorPose').map((e) => e.id)).not.toContain(a.peer.id);
    expect(b.all('visitorEmote')).toEqual([]);
    expect(b.all('visitorPing')).toEqual([]);
  });

  it('changing floors tells everyone (the list) before the first pose there, and catches the mover up', () => {
    const { tab } = setup();
    const a = tab();
    const b = tab();
    b.say(pose(2, 5, 5));
    a.say(pose(1));
    a.got.length = 0;
    a.say(pose(2, 0, 10));
    const order = b.got.map((e) => e.type);
    expect(order.lastIndexOf('visitors')).toBeLessThan(order.lastIndexOf('visitorPose'));
    expect(b.last('visitors')?.visitors).toEqual([expect.objectContaining({ id: a.peer.id, floor: 2 })]);
    expect(a.last('visitorPose')).toMatchObject({ id: b.peer.id, x: 5, z: 5 });
  });

  it('turning "Appear to others" off (watch) or leaving the office removes you from the list at once', () => {
    const { hub, tab } = setup();
    const a = tab();
    const b = tab();
    a.say(pose(1));
    b.say({ type: 'watch', f: 1 });
    expect(b.last('visitors')?.visitors).toHaveLength(1);
    a.say({ type: 'watch', f: 1 });
    expect(b.last('visitors')?.visitors).toEqual([]);
    a.say(pose(1));
    expect(b.last('visitors')?.visitors).toHaveLength(1);
    hub.leave(a.peer);
    expect(b.last('visitors')?.visitors).toEqual([]);
    a.say(pose(1)); // a closed socket's late message changes nothing
    expect(b.last('visitors')?.visitors).toEqual([]);
  });

  it('when a full floor loses someone, the next in line is sent to the floor', () => {
    const { hub, tab } = setup();
    const crowd = Array.from({ length: FLOOR_CAP + 1 }, () => tab());
    crowd.forEach((t, i) => t.say(pose(1, i)));
    const watcher = tab();
    watcher.say({ type: 'watch', f: 1 });
    const last = crowd[FLOOR_CAP];
    expect(watcher.all('visitorPose').map((e) => e.id)).not.toContain(last.peer.id);
    hub.leave(crowd[0].peer);
    expect(watcher.last('visitorPose')).toMatchObject({ id: last.peer.id, x: FLOOR_CAP });
  });

  it('rate-limits emotes and pings', () => {
    const { tab, advance } = setup();
    const a = tab();
    const b = tab();
    a.say(pose(1));
    b.say(pose(1));
    a.say({ type: 'emote', e: 'wave' });
    a.say({ type: 'emote', e: 'clap' });
    expect(b.all('visitorEmote').map((e) => e.e)).toEqual(['wave']);
    advance(EMOTE_GAP_MS);
    a.say({ type: 'emote', e: 'clap' });
    expect(b.all('visitorEmote').map((e) => e.e)).toEqual(['wave', 'clap']);
    a.say({ type: 'ping', x: 0, y: 1, z: 0, label: '<the whiteboard>' });
    a.say({ type: 'ping', x: 1, y: 1, z: 0, label: 'again' });
    expect(b.all('visitorPing')).toEqual([{ type: 'visitorPing', id: a.peer.id, x: 0, y: 1, z: 0, label: '<the whiteboard>' }]);
  });

  it('ignores junk', () => {
    const { hub, tab } = setup();
    const a = tab();
    const b = tab();
    b.say({ type: 'watch', f: 1 });
    for (const junk of ['', 'null', '[1,2]', '{"type":"pose"}', '{"type":"emote","e":"<script>"}', 'x'.repeat(5000)]) hub.receive(a.peer, junk);
    expect(b.all('visitorPose')).toEqual([]);
    expect(b.all('visitorEmote')).toEqual([]);
  });

  it('keeps fakes for the demo only, and they come to the floor the real visitor is on', () => {
    const plain = setup();
    const t = plain.tab();
    t.say({ type: 'fakes', n: 4 });
    expect(plain.hub.state().filter((p) => p.fake)).toEqual([]);

    const { hub, tab, advance } = setup(true);
    expect(hub.state().filter((p) => p.fake)).toHaveLength(2);
    const me = tab();
    me.say(pose(3));
    advance(100);
    hub.tick();
    expect(me.last('visitors')?.visitors.map((v) => v.floor)).toEqual([3, 3]);
    expect(me.all('visitorPose').length).toBeGreaterThan(0);
    me.say({ type: 'fakes', n: 8 });
    advance(100);
    hub.tick();
    expect(me.last('visitors')?.visitors).toHaveLength(8);
    me.say({ type: 'fakes', n: 0 });
    expect(me.last('visitors')?.visitors).toEqual([]);
  });

  it('never sits a fake on a smoke-break seat a real visitor already holds (#59)', () => {
    const { hub, tab, advance } = setup(true);
    hub.setFakes(1);
    const fakeId = hub.state().find((p) => p.fake)!.id;
    const me = tab();
    me.say(pose(1, 0, 0, { s: 'office-west:0' })); // claims the seat before the fake ever considers one
    for (let i = 0; i < 400; i++) {
      advance(500);
      hub.tick();
    }
    const fakeSeats = me.all('visitorPose').filter((p) => p.id === fakeId && p.s).map((p) => p.s);
    expect(fakeSeats.length).toBeGreaterThan(0); // it did take a smoke break at some point in this run
    expect(fakeSeats).not.toContain('office-west:0');
  });
});

// ---------- visitor penalty matches (#47) ----------

describe('visitor penalty matches', () => {
  it('two joins on floor 0 start a live match, relayed to a third tab on the same floor', () => {
    const { tab } = setup();
    const a = tab();
    const b = tab();
    const c = tab();
    a.say({ type: 'hello', name: 'Ada', color: '#118ab2' });
    b.say({ type: 'hello', name: 'Bo', color: '#118ab2' });
    a.say(pose(0, -68));
    b.say(pose(0, -68));
    c.say(pose(0, -68));
    a.say({ type: 'pk-join' });
    expect(a.last('pk-state')).toMatchObject({ phase: 'waiting', players: [{ id: a.peer.id, name: 'Ada', side: 'player' }] });
    b.say({ type: 'pk-join' });
    const state = c.last('pk-state');
    expect(state).toMatchObject({
      phase: 'live',
      turn: 'player',
      players: [{ id: a.peer.id, side: 'player' }, { id: b.peer.id, side: 'opponent' }],
    });
  });

  it("someone not on floor 0, or not appearing, can't join", () => {
    const { tab } = setup();
    const a = tab();
    a.say(pose(1));
    a.say({ type: 'pk-join' });
    expect(a.last('pk-state')).toBeUndefined();
  });

  it('a kick resolves the same way for every tab on the floor, once flight and the grace have passed', () => {
    const { hub, tab, advance } = setup();
    const a = tab();
    const b = tab();
    const c = tab();
    a.say(pose(0, -68));
    b.say(pose(0, -68));
    c.say(pose(0, -68));
    a.say({ type: 'pk-join' });
    b.say({ type: 'pk-join' });
    a.say({ type: 'pk-shot', x: 0, y: 10, power: 0.5 }); // well over the bar: a clean miss
    advance(10_000);
    hub.tick();
    expect(a.last('pk-kick')).toMatchObject({ result: 'over' });
    expect(c.last('pk-kick')).toMatchObject({ result: 'over' });
    expect(c.last('pk-state')).toMatchObject({ turn: 'opponent', kicks: [{ side: 'player', scored: false }] });
  });

  it('an early dive saves a hard shot, the same for shooter and keeper', () => {
    const { hub, tab, advance } = setup();
    const a = tab();
    const b = tab();
    a.say(pose(0, -68));
    b.say(pose(0, -68));
    a.say({ type: 'pk-join' });
    b.say({ type: 'pk-join' });
    b.say({ type: 'pk-dive', x: 2, y: 1 });
    advance(300);
    a.say({ type: 'pk-shot', x: 2, y: 1, power: 1 });
    advance(10_000);
    hub.tick();
    expect(a.last('pk-kick')).toMatchObject({ result: 'saved' });
  });

  it('reports the finished match to onPenaltyResult, with the real names and the kicks', () => {
    const results: unknown[] = [];
    let now = 1_000;
    const hub = new PresenceHub({ now: () => now, timer: false, onPenaltyResult: (r) => results.push(r) });
    const got: Record<string, unknown[]> = {};
    const tab = (id: string) => {
      got[id] = [];
      const p = hub.join((data) => got[id].push(JSON.parse(data)));
      return { peer: p, say: (msg: unknown) => hub.receive(p, JSON.stringify(msg)) };
    };
    const a = tab('a');
    const b = tab('b');
    a.say({ type: 'hello', name: 'Ada', color: '#118ab2' });
    b.say({ type: 'hello', name: 'Bo', color: '#118ab2' });
    a.say(pose(0, -68));
    b.say(pose(0, -68));
    a.say({ type: 'pk-join' });
    b.say({ type: 'pk-join' });
    // Ada always scores, Bo always goes over the bar: decided 1-0 after 3 each.
    for (let i = 0; i < 6 && results.length === 0; i++) {
      const turn = (hub.penaltyState().turn ?? 'player') as 'player' | 'opponent';
      if (turn === 'player') a.say({ type: 'pk-shot', x: 2, y: 1, power: 1 });
      else b.say({ type: 'pk-shot', x: 0, y: 10, power: 0.5 });
      now += 10_000;
      hub.tick();
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ player: { name: 'Ada' }, opponent: { name: 'Bo' }, winner: 'player' });
    expect(hub.penaltyState().phase).toBe('empty'); // the pitch is free again
  });

  it('a disconnect, leaving floor 0, or wandering too far forfeits the match, with no result', () => {
    const results: unknown[] = [];
    let now = 1_000;
    const hub = new PresenceHub({ now: () => now, timer: false, onPenaltyResult: (r) => results.push(r) });
    const got: ServerEvent[][] = [[], []];
    const peers = [hub.join((d) => got[0].push(JSON.parse(d))), hub.join((d) => got[1].push(JSON.parse(d)))];
    hub.receive(peers[0], JSON.stringify(pose(0, -68)));
    hub.receive(peers[1], JSON.stringify(pose(0, -68)));
    hub.receive(peers[0], JSON.stringify({ type: 'pk-join' }));
    hub.receive(peers[1], JSON.stringify({ type: 'pk-join' }));
    expect(hub.penaltyState().phase).toBe('live');

    hub.leave(peers[1]);
    expect(hub.penaltyState().phase).toBe('empty');
    expect(results).toHaveLength(0);

    // a fresh match, this time ended by walking off floor 0
    hub.receive(peers[0], JSON.stringify({ type: 'pk-join' }));
    const c = hub.join((d) => got[0].push(JSON.parse(d)));
    hub.receive(c, JSON.stringify(pose(0, -68)));
    hub.receive(c, JSON.stringify({ type: 'pk-join' }));
    expect(hub.penaltyState().phase).toBe('live');
    hub.receive(peers[0], JSON.stringify(pose(1)));
    expect(hub.penaltyState().phase).toBe('empty');

    // and once more, ended by wandering more than 15 m from the pitch
    hub.receive(peers[0], JSON.stringify(pose(0, -68))); // back on floor 0, at the pitch
    hub.receive(peers[0], JSON.stringify({ type: 'pk-join' }));
    hub.receive(c, JSON.stringify({ type: 'pk-join' }));
    expect(hub.penaltyState().phase).toBe('live');
    hub.receive(c, JSON.stringify(pose(0, 100, 0)));
    expect(hub.penaltyState().phase).toBe('empty');
    expect(results).toHaveLength(0);
  });
});
