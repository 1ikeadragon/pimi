// Pimi. Apache-2.0.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const activeMoves = new WeakMap();
const laneMoveDuration = 340;
const laneMoveLift = 5;

function visibleInBoard(rect, bounds) {
  return (
    rect.right > Math.max(0, bounds.left) &&
    rect.left < Math.min(window.innerWidth, bounds.right) &&
    rect.bottom > Math.max(0, bounds.top) &&
    rect.top < Math.min(window.innerHeight, bounds.bottom)
  );
}

function animateMove(card, x, y, duration, changedLane) {
  const frames = [{ transform: `translate(${x}px, ${y}px)` }];
  // A refreshed card resumes from its visible position without a second lift.
  if (changedLane) {
    frames.push({ transform: `translate(${x / 2}px, ${y / 2 - laneMoveLift}px)` });
  }
  frames.push({ transform: "translate(0, 0)" });

  card.classList.add("card-moving");
  const animation = card.animate(frames, { duration, easing: "cubic-bezier(.25, .65, .25, 1)" });
  activeMoves.set(card, animation);
  const clear = () => {
    activeMoves.delete(card);
    card.classList.remove("card-moving");
  };
  animation.finished.then(clear, clear);
}

export function replaceBoardLanes(board, lanes, idAttribute) {
  if (reducedMotion.matches || document.hidden || !board.getClientRects().length) {
    board.replaceChildren(...lanes);
    return;
  }

  const selector = `[${idAttribute}]`;
  const previous = new Map(
    [...board.querySelectorAll(selector)].map((card) => [card.getAttribute(idAttribute), card]),
  );
  const moves = [];
  for (const lane of lanes) {
    for (const card of lane.querySelectorAll(selector)) {
      const old = previous.get(card.getAttribute(idAttribute));
      if (!old) continue;
      const animation = activeMoves.get(old);
      const changedLane = old.parentElement.dataset.stage !== lane.dataset.stage;
      const duration = changedLane
        ? laneMoveDuration
        : (animation?.effect.getComputedTiming().endTime ?? 0) - (animation?.currentTime ?? 0);
      if (duration > 0)
        moves.push({ card, changedLane, duration, from: old.getBoundingClientRect() });
    }
  }

  board.replaceChildren(...lanes);
  if (!moves.length) return;
  const bounds = board.getBoundingClientRect();
  for (const move of moves) move.to = move.card.getBoundingClientRect();
  for (const { card, changedLane, duration, from, to } of moves) {
    const x = from.left - to.left;
    const y = from.top - to.top;
    if ((!x && !y) || (!visibleInBoard(from, bounds) && !visibleInBoard(to, bounds))) continue;
    animateMove(card, x, y, duration, changedLane);
  }
}
