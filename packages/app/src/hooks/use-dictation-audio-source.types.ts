export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string, volume?: number) => void;
  /** Short streaming segments and input levels for command end-of-speech detection. */
  segmentDurationMs?: number;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  volume: number;
  isPaused: boolean;
}
