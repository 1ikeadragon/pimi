// Pimi. PolyForm-Noncommercial-1.0.0.
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
const MIN_SPEECH_RMS = 0.002;
const MAX_SPEECH_RMS = 0.015;
const NOISE_MARGIN = 2.5;
const PREROLL_SEGMENTS = 2;
const END_SILENCE_MS = 1000;
const MAX_UTTERANCE_MS = 30_000;
const MAX_PENDING_UTTERANCES = 2;
const FIRST_AUDIO_TIMEOUT_MS = 4_000;

interface ListeningSession {
  client: DictationStreamClient;
  sender: DictationStreamSender | null;
  pending: Set<DictationStreamSender>;
  completed: Promise<void>;
  preroll: string[];
  silenceMs: number;
  noiseRms: number | null;
  heardSpeech: boolean;
  accepting: boolean;
  receivedAudio: boolean;
  firstAudioTimeout?: ReturnType<typeof setTimeout>;
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
  isPlayingCue,
}: {
  client: DictationStreamClient | null;
  unavailable: string | null;
  onTranscript: (text: string) => void;
  isPlayingCue?: () => boolean;
}) {
  const current = useRef<ListeningSession | null>(null);
  const transition = useRef<Promise<void> | null>(null);
  const [phase, setPhase] = useState<
    "off" | "starting" | "listening" | "hearing" | "processing" | "finishing"
  >("off");
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
    clearTimeout(session.firstAudioTimeout);
    for (const sender of session.pending) cancelStream(sender);
    session.pending.clear();
    session.sender = null;
    setPhase("off");
    setMessage(reason);
    setLevel(0);
    if (transition.current) return;
    if (session.accepting && session.releaseLock) void closeAudio().then(session.releaseLock);
  });

  const finishUtterance = useStableEvent((session: ListeningSession) => {
    const sender = session.sender;
    if (!sender) return;
    session.sender = null;
    setPhase(session.accepting ? "processing" : "finishing");
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
      try {
        if (outcome.text.trim()) onTranscript(outcome.text);
        else setMessage("No words recognized. Try saying the command again.");
      } catch (error) {
        stop(error instanceof Error ? error.message : "Could not apply that command.");
      }
      if (current.current !== session) return;
      if (session.sender) {
        if (session.accepting) setPhase("hearing");
      } else if (session.pending.size === 0) {
        if (session.accepting) setPhase("listening");
        else {
          current.current = null;
          setPhase("off");
        }
      }
    })();
  });

  const handleSegment = useStableEvent((segment: string, volume: number = 0) => {
    const session = current.current;
    if (!session) return;
    if (!session.accepting) {
      // The audio source flushes its final partial PCM segment on stop.
      session.sender?.enqueueSegment(segment);
      return;
    }
    session.receivedAudio = true;
    clearTimeout(session.firstAudioTimeout);
    setLevel(Math.round(Math.min(1, volume * 7) * 16) / 16);
    if (!session.sender && isPlayingCue?.()) {
      session.preroll = [];
      return;
    }
    const noiseRms = session.noiseRms ?? Math.min(volume, MAX_SPEECH_RMS);
    const onset = Math.max(MIN_SPEECH_RMS, Math.min(MAX_SPEECH_RMS, noiseRms * NOISE_MARGIN));
    const isSpeech = volume >= (session.sender ? onset * 0.7 : onset);
    if (!session.sender && !isSpeech) {
      session.noiseRms = noiseRms * 0.8 + volume * 0.2;
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
      session.heardSpeech = true;
      session.silenceMs = 0;
      for (const leading of session.preroll) sender.enqueueSegment(leading);
      session.preroll = [];
      setPhase("hearing");
      setMessage("");
    }

    const sender = session.sender;
    sender.enqueueSegment(segment);
    session.silenceMs = isSpeech ? 0 : session.silenceMs + SEGMENT_MS;
    if (session.silenceMs >= END_SILENCE_MS) finishUtterance(session);
    else if (sender.getSegmentCount() * SEGMENT_MS >= MAX_UTTERANCE_MS) {
      stop("That command was too long. Tap to try a shorter command.");
    }
  });

  const audio = useDictationAudioSource({
    segmentDurationMs: SEGMENT_MS,
    onPcmSegment: handleSegment,
    onInterruption: () => stop("Microphone disconnected."),
  });
  const { start: startAudio } = audio;

  const finishListening = useStableEvent((session: ListeningSession) => {
    if (!session.accepting) return;
    if (session.pending.size === 0) {
      stop(
        session.receivedAudio && !session.heardSpeech ? "No speech heard. Tap to try again." : "",
      );
      return;
    }
    session.accepting = false;
    setLevel(0);
    setPhase("finishing");
    const closeCapture = async () => {
      await closeAudio();
      session.releaseLock?.();
      if (current.current === session) finishUtterance(session);
    };
    void closeCapture();
  });

  const toggle = useStableEvent(() => {
    if (current.current) {
      finishListening(current.current);
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
      noiseRms: null,
      heardSpeech: false,
      accepting: true,
      receivedAudio: false,
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
        if (!session.receivedAudio) {
          session.firstAudioTimeout = setTimeout(() => {
            if (current.current === session && !session.receivedAudio) {
              stop("No audio from the microphone. Check your input and try again.");
            }
          }, FIRST_AUDIO_TIMEOUT_MS);
        }

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
