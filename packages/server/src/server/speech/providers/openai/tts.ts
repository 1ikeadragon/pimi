import type pino from "pino";
import type { OpenAI } from "openai";
import { Readable } from "node:stream";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export interface TTSConfig {
  apiKey: string;
  baseUrl?: string;
  model?: "tts-1" | "tts-1-hd" | (string & {});
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | (string & {});
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export class OpenAITTS implements TextToSpeechProvider {
  private openaiClient: Promise<OpenAI> | null = null;
  private readonly config: TTSConfig;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: TTSConfig, parentLogger: pino.Logger) {
    this.config = {
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      ...ttsConfig,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "tts" });

    this.logger.info(
      { voice: this.config.voice, model: this.config.model, format: this.config.responseFormat },
      "TTS (OpenAI) initialized",
    );
  }

  // The SDK is large and speech defaults to local providers, so load it on first request.
  private getClient(): Promise<OpenAI> {
    this.openaiClient ??= import("openai").then(
      ({ OpenAI }) =>
        new OpenAI({
          apiKey: this.config.apiKey,
          ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        }),
    );
    return this.openaiClient;
  }

  public getConfig(): TTSConfig {
    return this.config;
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { textLength: text.length, preview: text.substring(0, 50) },
        "Synthesizing speech",
      );

      const response = await (
        await this.getClient()
      ).audio.speech.create({
        model: this.config.model!,
        voice: this.config.voice!,
        input: text,
        response_format: this.config.responseFormat as
          | "mp3"
          | "opus"
          | "aac"
          | "flac"
          | "wav"
          | "pcm",
      });

      // Prefetched speech can wait through playback of an earlier sentence. Consume
      // the response here so fetch cannot collect it and cancel its unread body.
      const audioStream = Readable.from([Buffer.from(await response.arrayBuffer())]);

      const duration = Date.now() - startTime;
      this.logger.debug({ duration }, "Speech synthesis stream ready");

      return {
        stream: audioStream,
        format: this.config.responseFormat || "mp3",
      };
    } catch (error) {
      this.logger.error({ err: error }, "Speech synthesis error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TTS synthesis failed: ${message}`, { cause: error });
    }
  }
}
