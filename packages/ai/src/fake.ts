// Deterministic fake model (docs/ai-architecture.md §6): scripted responses for
// every engine-side AI test. CI never calls a live provider — this is the only
// model the deterministic suites use.
import { ChatError, type ChatModel, type ChatRequest, type ChatResult } from "./types.js";

export type FakeReply =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "delay"; readonly ms: number; readonly text: string };

export class FakeChatModel implements ChatModel {
  readonly id: string;
  readonly calls: ChatRequest[] = [];
  private readonly replies: FakeReply[];
  private cursor = 0;

  constructor(replies: readonly FakeReply[], id = "fake:scripted") {
    this.id = id;
    this.replies = [...replies];
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    this.calls.push(request);
    const reply = this.replies[Math.min(this.cursor, this.replies.length - 1)];
    this.cursor += 1;
    if (reply === undefined) {
      throw new ChatError("AI-NO-SCRIPT", "FakeChatModel has no scripted reply");
    }
    if (reply.kind === "error") {
      throw new ChatError(reply.code, reply.message);
    }
    if (reply.kind === "delay") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new ChatError("AI-ABORTED", "request aborted"));
        });
      });
      return {
        text: reply.text,
        usage: { inputTokens: null, outputTokens: null, usd: null },
      };
    }
    return {
      text: reply.text,
      usage: {
        inputTokens: reply.inputTokens ?? null,
        outputTokens: reply.outputTokens ?? null,
        usd: null,
      },
    };
  }
}
