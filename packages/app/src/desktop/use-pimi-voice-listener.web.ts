// Pimi addition to the Paseo fork. Apache-2.0.
import { useEffect, useRef, useState } from "react";
import {
  DictationStreamSender,
  type DictationStreamClient,
} from "@/dictation/dictation-stream-sender";
import {
  DICTATION_MICROPHONE_TAKEOVER,
  isDictationMicrophoneActive,
  useDictationAudioSource,
} from "@/hooks/use-dictation-audio-source.web";
import { PCM_DICTATION_FORMAT } from "@/hooks/use-dictation.shared";
import { useStableEvent } from "@/hooks/use-stable-event";

const SEGMENT_MS = 250;
const SPEECH_RMS = 0.015;
const PREROLL_SEGMENTS = 2;
const END_SILENCE_MS = 1000;
const MAX_UTTERANCE_MS = 30_000;
const MAX_PENDING_UTTERANCES = 2;

interface ListeningSession {
  client: DictationStreamClient;
  sender: DictationStreamSender | null;
  pending: Set<DictationStreamSender>;
  completed: Promise<void>;
  preroll: string[];
  silenceMs: number;
  releaseLock?: () => void;
}

function cancelStream(sender: DictationStreamSender) {
  try {
    sender.cancel();
  } catch (error) {
    console.warn("Could not cancel voice transcription", error);
  } finally {
    sender.dispose();
  }
}

export function usePimiVoiceListener({
  client,
  unavailable,
  onTranscript,
}: {
  client: DictationStreamClient | null;
  unavailable: string | null;
  onTranscript: (text: string) => void;
}) {
  const current = useRef<ListeningSession | null>(null);
  const transition = useRef<Promise<void> | null>(null);
  const [phase, setPhase] = useState<"off" | "starting" | "listening" | "processing">("off");
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState(0);

  const closeAudio = useStableEvent(() => {
    const closing = audio
      .stop()
      .catch(console.error)
      .finally(() => {
        transition.current = null;
      });
    transition.current = closing;
    return closing;
  });

  const stop = useStableEvent((reason: string = "") => {
    const session = current.current;
    if (!session) return;
    current.current = null;
    for (const sender of session.pending) cancelStream(sender);
    session.pending.clear();
    session.sender = null;
    setPhase("off");
    setMessage(reason);
    setLevel(0);
    if (transition.current) return;
    if (session.releaseLock) void closeAudio().then(session.releaseLock);
  });

  const handleSegment = useStableEvent((segment: string, volume: number = 0) => {
    const session = current.current;
    if (!session) return;
    setLevel(Math.round(Math.min(1, volume * 7) * 16) / 16);
    const isSpeech = volume >= SPEECH_RMS;
    if (!session.sender && !isSpeech) {
      if (session.preroll.length === PREROLL_SEGMENTS) session.preroll.shift();
      session.preroll.push(segment);
      return;
    }
    if (!session.sender) {
      if (session.pending.size >= MAX_PENDING_UTTERANCES) {
        stop("Transcription is backed up. Tap to listen again.");
        return;
      }
      const sender = new DictationStreamSender({
        client: session.client,
        format: PCM_DICTATION_FORMAT,
      });
      session.sender = sender;
      session.pending.add(sender);
      session.silenceMs = 0;
      for (const leading of session.preroll) sender.enqueueSegment(leading);
      session.preroll = [];
      setMessage("");
    }

    const sender = session.sender;
    sender.enqueueSegment(segment);
    session.silenceMs = isSpeech ? 0 : session.silenceMs + SEGMENT_MS;
    if (session.silenceMs < END_SILENCE_MS) {
      if (sender.getSegmentCount() * SEGMENT_MS >= MAX_UTTERANCE_MS) {
        stop("That command was too long. Tap to try a shorter command.");
      }
      return;
    }

    session.sender = null;
    setPhase("processing");
    // Start transcribing immediately. Apply the results in the order the commands were spoken.
    const result = sender.finish(sender.getFinalSeq()).then(
      (value) => ({ text: value.text }),
      (error: unknown) => ({ error }),
    );
    const previous = session.completed;
    session.completed = (async () => {
      await previous;
      const outcome = await result;
      if (current.current !== session) return;
      session.pending.delete(sender);
      if ("error" in outcome) {
        cancelStream(sender);
        stop(outcome.error instanceof Error ? outcome.error.message : "Transcription failed.");
        return;
      }
      sender.dispose();
      if (session.pending.size === 0 || (session.pending.size === 1 && session.sender)) {
        setPhase("listening");
      }
      try {
        if (outcome.text.trim()) onTranscript(outcome.text);
      } catch (error) {
        stop(error instanceof Error ? error.message : "Could not apply that command.");
      }
    })();
  });

  const audio = useDictationAudioSource({
    segmentDurationMs: SEGMENT_MS,
    onPcmSegment: handleSegment,
    onInterruption: () => stop("Microphone disconnected."),
  });
  const { start: startAudio } = audio;

  const toggle = useStableEvent(() => {
    if (current.current) {
      stop();
      return;
    }
    if (transition.current) return;
    if (!client?.isConnected || unavailable || isDictationMicrophoneActive()) {
      setMessage(
        unavailable ??
          (client?.isConnected ? "Finish dictation first." : "Connect to your local host."),
      );
      return;
    }

    // Chromium locks keep multiple Pimi windows from listening at the same time.
    const session: ListeningSession = {
      client,
      sender: null,
      pending: new Set(),
      completed: Promise.resolve(),
      preroll: [],
      silenceMs: 0,
    };
    current.current = session;
    setPhase("starting");
    setMessage("");
    const lifetime = navigator.locks.request(
      "pimi-voice-commands",
      { ifAvailable: true },
      async (lock) => {
        if (current.current !== session) return;
        if (!lock) {
          stop("Voice commands are listening in another Pimi window.");
          return;
        }
        let startError: unknown;
        try {
          transition.current = startAudio();
          await transition.current;
        } catch (error) {
          startError = error;
        } finally {
          transition.current = null;
        }
        if (current.current !== session) {
          await closeAudio();
          return;
        }
        if (startError) {
          stop(startError instanceof Error ? startError.message : "Microphone unavailable.");
          return;
        }
        setPhase("listening");

        // Hold the lock until the capture has stopped.
        await new Promise<void>((resolve) => {
          session.releaseLock = resolve;
        });
      },
    );
    void lifetime.catch((error: unknown) => {
      if (current.current === session)
        stop(error instanceof Error ? error.message : "Could not start voice commands.");
    });
  });

  useEffect(() => {
    if (
      current.current &&
      (!client?.isConnected || unavailable || client !== current.current.client)
    ) {
      stop(unavailable ?? "Voice commands disconnected.");
    }
  }, [client, stop, unavailable]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    const takeover = () => stop();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(DICTATION_MICROPHONE_TAKEOVER, takeover);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(DICTATION_MICROPHONE_TAKEOVER, takeover);
      stop();
    };
  }, [stop]);

  return { phase, message, level, setMessage, stop, toggle };
}
