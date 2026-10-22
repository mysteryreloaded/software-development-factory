// The penalty pitch (#46): the goal, its net, the ball, and the billboard that pages between the live match and the
// all-time board. Mounted with the city (outside/City.tsx), so it (and the match) show from the office windows too.
// Pure positions come from parkPitch.ts; the match clock itself is penaltyState.ts, ticked by ParkOpponent.tsx.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store';
import { GOAL } from '../../../../shared/penalty';
import { roundRect, SANS } from '../draw';
import { useCanvasTexture, useInteractable } from '../interact';
import { toon } from '../materials';
import { boxesGeometry, type BoxSpec } from '../shapes';
import { boardPitch, goalPitch } from './parkPitch';
import { penaltyFree, penaltyMatch, penaltyView, subscribePenalty } from './penaltyState';

const POST = 0.1;

function goalGeometry() {
  const g = goalPitch();
  const hw = GOAL.width / 2;
  const specs: BoxSpec[] = [
    { size: [POST, GOAL.height, POST], at: [g.lineX, GOAL.height / 2, g.z - hw] },
    { size: [POST, GOAL.height, POST], at: [g.lineX, GOAL.height / 2, g.z + hw] },
    { size: [POST, POST, GOAL.width + POST], at: [g.lineX, GOAL.height, g.z] },
    // the net's side and back frame, so the ball has somewhere to end up behind the line
    { size: [POST * 0.6, GOAL.height, POST * 0.6], at: [g.netX, GOAL.height / 2, g.z - hw] },
    { size: [POST * 0.6, GOAL.height, POST * 0.6], at: [g.netX, GOAL.height / 2, g.z + hw] },
  ];
  return boxesGeometry(specs);
}

/** The net: a loose grid of lines between the frame and the back posts, just enough to read as a net. */
function netGeometry() {
  const g = goalPitch();
  const hw = GOAL.width / 2;
  const pts: number[] = [];
  const rows = 8;
  const cols = 10;
  const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => pts.push(x1, y1, z1, x2, y2, z2);
  for (let i = 0; i <= rows; i++) {
    const y = (GOAL.height * i) / rows;
    push(g.lineX, y, g.z - hw, g.netX, y, g.z - hw);
    push(g.netX, y, g.z - hw, g.netX, y, g.z + hw);
  }
  for (let i = 0; i <= cols; i++) {
    const z = g.z - hw + (GOAL.width * i) / cols;
    push(g.netX, 0, z, g.netX, GOAL.height, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function Goal() {
  const frame = useMemo(goalGeometry, []);
  const net = useMemo(netGeometry, []);
  useEffect(() => () => {
    frame.dispose();
    net.dispose();
  }, [frame, net]);
  return (
    <group>
      <mesh geometry={frame} material={toon('#f1f3f5')} />
      <lineSegments geometry={net}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.35} />
      </lineSegments>
    </group>
  );
}

/** The ball: at the spot while nobody's shooting, flying towards its landing point once struck. */
function PenaltyBall() {
  const ref = useRef<THREE.Mesh>(null);
  const g = useMemo(goalPitch, []);
  useFrame(() => {
    const m = penaltyMatch();
    const mesh = ref.current;
    if (!mesh) return;
    if (!m || m.stage === 'walkup' || m.stage === 'setup' || m.stage === 'live' || !m.shot) {
      mesh.position.set(g.spotX, GOAL.ballR, g.z);
      return;
    }
    if ((m.stage === 'flight' || m.stage === 'result' || m.stage === 'over') && m.strikeAt && m.outcome) {
      const t = Math.min(1, (performance.now() - m.strikeAt) / Math.max(1, m.outcome.flightMs));
      const landX = g.lineX;
      const landY = Math.max(GOAL.ballR, Math.min(GOAL.height, m.shot.y));
      const landZ = g.z + Math.max(-GOAL.width, Math.min(GOAL.width, m.shot.x));
      mesh.position.set(g.spotX + (landX - g.spotX) * t, GOAL.ballR + (landY - GOAL.ballR) * t, g.z + (landZ - g.z) * t);
    }
  });
  return (
    <mesh ref={ref} position={[0, GOAL.ballR, 0]}>
      <sphereGeometry args={[GOAL.ballR, 12, 10]} />
      <meshStandardMaterial color="#ffffff" />
    </mesh>
  );
}

const BOARD_PAGES = ['top5', 'hardest'] as const;
type Page = (typeof BOARD_PAGES)[number];
const BOARD_W = 1024;
const BOARD_H = 768;

function drawTop5(ctx: CanvasRenderingContext2D) {
  const w = BOARD_W;
  const h = BOARD_H;
  const board = useStore.getState().penalty;
  roundRect(ctx, 0, 0, w, h, 24);
  ctx.fillStyle = '#132a13';
  ctx.fill();
  ctx.fillStyle = '#d8f3dc';
  ctx.textAlign = 'center';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText('⚽ All-time top 5', w / 2, 60);
  ctx.textAlign = 'left';
  ctx.font = `600 38px ${SANS}`;
  const rows = board.rows.slice(0, 5);
  if (rows.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillText('No games yet', w / 2, h / 2);
  } else {
    rows.forEach((r, i) => {
      const y = 140 + i * 70;
      ctx.fillStyle = '#d8f3dc';
      ctx.fillText(`${i + 1}.`, 60, y);
      ctx.fillText(r.name.slice(0, 8), 140, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${r.wins}W`, w - 60, y);
      ctx.textAlign = 'left';
    });
  }
}

function drawHardest(ctx: CanvasRenderingContext2D) {
  const w = BOARD_W;
  const h = BOARD_H;
  const board = useStore.getState().penalty;
  roundRect(ctx, 0, 0, w, h, 24);
  ctx.fillStyle = '#240046';
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e0aaff';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText('🚀 Hardest shot', w / 2, 60);
  ctx.font = `700 76px ${SANS}`;
  if (!board.hardest) {
    ctx.font = `600 38px ${SANS}`;
    ctx.fillText('No games yet', w / 2, h / 2);
  } else {
    ctx.fillText(`${Math.round(board.hardest.kmh)} km/h`, w / 2, h / 2 - 20);
    ctx.font = `600 40px ${SANS}`;
    ctx.fillText(board.hardest.name.slice(0, 16), w / 2, h / 2 + 70);
  }
}

function drawLive(ctx: CanvasRenderingContext2D) {
  const w = BOARD_W;
  const h = BOARD_H;
  const v = penaltyView();
  roundRect(ctx, 0, 0, w, h, 24);
  ctx.fillStyle = '#03045e';
  ctx.fill();
  if (!v) return;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#caf0f8';
  ctx.font = `700 46px ${SANS}`;
  ctx.fillText(`Manager vs ${v.opponentName.slice(0, 14)}`, w / 2, 56);
  ctx.font = `700 90px ${SANS}`;
  ctx.fillText(`${v.score.player} – ${v.score.opponent}`, w / 2, 160);
  const dot = (k: 'goal' | 'miss') => (k === 'goal' ? '●' : '○');
  ctx.font = `600 40px ${SANS}`;
  const playerKicks = v.kicksShown.filter((_, i) => i % 2 === 0);
  const oppKicks = v.kicksShown.filter((_, i) => i % 2 === 1);
  ctx.fillText(playerKicks.map(dot).join(' ') || '—', w / 2, 230);
  ctx.fillText(oppKicks.map(dot).join(' ') || '—', w / 2, 280);
  ctx.font = `600 32px ${SANS}`;
  ctx.fillText(v.winner ? `${v.winner === 'player' ? 'You win!' : `${v.opponentName} wins!`}` : `${v.turn === 'player' ? 'Your kick' : `${v.opponentName}'s kick`}`, w / 2, 340);
}

function Billboard() {
  const b = useMemo(boardPitch, []);
  const [page, setPage] = useState<Page>('top5');
  const [tick, setTick] = useState(0);
  const since = useRef(0);
  useFrame((_, dt) => {
    since.current += dt;
    const live = !penaltyFree();
    if (live) {
      setTick((t) => t + 1);
      return;
    }
    if (since.current > 8) {
      since.current = 0;
      setPage((p) => (p === 'top5' ? 'hardest' : 'top5'));
    }
  });
  useEffect(() => subscribePenalty(() => setTick((t) => t + 1)), []);
  const live = !penaltyFree();
  const draw = live ? drawLive : page === 'top5' ? drawTop5 : drawHardest;
  const texture = useCanvasTexture(1024, 768, draw, [live, page, tick]);
  const yaw = Math.atan2(b.facing.x, b.facing.z);
  return (
    <group position={[b.x, b.bottom + b.height / 2, b.z]} rotation={[0, yaw, 0]}>
      <mesh>
        <planeGeometry args={[b.width, b.height]} />
        <meshStandardMaterial map={texture} />
      </mesh>
      <mesh position={[0, 0, -0.05]}>
        <boxGeometry args={[b.width + 0.3, b.height + 0.3, 0.1]} />
        <meshStandardMaterial color="#495057" />
      </mesh>
    </group>
  );
}

/** Where you stand to start a shoot-out (E Play penalties); hidden once a match is on. */
function StartSpot() {
  const g = useMemo(goalPitch, []);
  const [free, setFree] = useState(penaltyFree());
  useEffect(() => subscribePenalty(() => setFree(penaltyFree())), []);
  const ref = useInteractable<THREE.Mesh>(free ? { id: 'penalty', label: 'Play penalties', action: { kind: 'penalty' } } : null, 3.2);
  // double-sided: you stand right on this spot (unlike pong's TableEnd, reached from outside it), so the
  // crosshair ray starts inside the box and must hit it from the inside too.
  return (
    <mesh ref={ref} position={[g.spotX, 1, g.z]}>
      <boxGeometry args={[1, 2, 1]} />
      <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function Pitch() {
  return (
    <group>
      <Goal />
      <PenaltyBall />
      <Billboard />
      <StartSpot />
    </group>
  );
}
