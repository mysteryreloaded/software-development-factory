import { useSyncExternalStore } from 'react';
import { Key } from './Key';
import { penaltyView, playerRole, subscribePenalty, type PenaltyView } from '../world/park/penaltyState';

// Playing a penalty shoot-out (a kick in progress): the score, whose kick it is, the power bar, and the controls.

function penaltyStatus(v: PenaltyView): string {
  if (v.stage === 'walkup') return `${v.opponentName} is on the way out to the park…`;
  if (v.stage === 'over' && v.winner) return v.winner === 'player' ? 'You win!' : `${v.opponentName} wins!`;
  if (v.you === 'shooter') return v.stage === 'live' ? 'Hold to charge, aim with the mouse, release to shoot' : 'Your kick…';
  return v.stage === 'live' || v.stage === 'flight' ? 'A/D to shuffle, mouse to aim, click to dive' : `${v.opponentName} is kicking…`;
}

export function PenaltyHud() {
  const v = useSyncExternalStore(subscribePenalty, penaltyView);
  if (!v) return null;
  const status = penaltyStatus(v);
  return (
    <>
      <div className="hud-pong" aria-live="polite">
        <div className="hud-pong-score">
          <span>You</span>
          <b>{v.score.player}</b>
          <i>:</i>
          <b>{v.score.opponent}</b>
          <span>{v.opponentName}</span>
        </div>
        {status && <div className="hud-pong-status">{status}</div>}
        {v.you === 'shooter' && v.stage === 'live' && (
          <div className="charge">
            <div className="charge-fill" style={{ transform: `scaleX(${v.power})` }} />
          </div>
        )}
      </div>
      <div className="hud-hint hud-pong-keys">
        {playerRole() === 'keeper' ? (
          <>
            <kbd>A</kbd>/<kbd>D</kbd> shuffle · <kbd>Mouse</kbd> aim the dive · <kbd>Click</kbd> dive
          </>
        ) : (
          <>
            <kbd>Mouse</kbd> aim · hold <kbd>Click</kbd> / <Key action="throw" /> to charge, release to shoot
          </>
        )}{' '}
        · <Key action="drop" /> / <kbd>Esc</kbd> leave
      </div>
    </>
  );
}
