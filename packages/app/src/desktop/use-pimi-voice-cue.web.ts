import { useCallback, useEffect, useRef } from "react";

const POP_DURATION_SECONDS = 0.12;
// Include the next capture segment, which may contain the end of the cue.
const CAPTURE_GUARD_MS = 400;

export function usePimiVoiceCue(enabled: boolean) {
  const contextRef = useRef<AudioContext | null>(null);
  const cueUntil = useRef(0);
  const isPlayingCue = useCallback(() => performance.now() < cueUntil.current, []);

  useEffect(
    () => () => {
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
    },
    [],
  );

  const playCue = useCallback(() => {
    if (!enabled) return;
    const play = async () => {
      const context = (contextRef.current ??= new AudioContext());
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const end = start + POP_DURATION_SECONDS;
      oscillator.frequency.setValueAtTime(760, start);
      oscillator.frequency.exponentialRampToValueAtTime(480, end);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
      cueUntil.current = performance.now() + CAPTURE_GUARD_MS;
      oscillator.start(start);
      oscillator.stop(end);
    };
    void play().catch(() => {
      // Audio output is optional. The transcript and result still show.
    });
  }, [enabled]);
  return { playCue, isPlayingCue };
}
