export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export type ChatEndpoint =
  | "chat"
  | "chat-draft"
  | "context-helper"
  | "context-extract"
  | "context-planner";

/**
 * Tool-call event passed to the onToolCall callback. AG-UI streams tool calls
 * as a START event (with name + id) followed by ARGS deltas (JSON text streamed
 * piece by piece) followed by an END event. ChatService buffers the args
 * internally and only invokes the callback at the right phase.
 *
 * Phases:
 *   "start" — TOOL_CALL_START seen. args is null. Use this if you want to show
 *             a "calling X..." chip immediately.
 *   "end"   — TOOL_CALL_END seen. args is the parsed JSON object built from
 *             all the ARGS deltas. This is when the frontend should actually
 *             execute the tool's side effect.
 */
export type ToolCallStatus = "start" | "end";

export class ChatService {
  private threadId: string;

  constructor() {
    this.threadId = crypto.randomUUID();
  }

  /**
   * Sends messages to the backend and streams the response.
   * onToken: text chunks from the assistant
   * onToolCall: tool execution steps (searching, retrieving)
   * onDone: stream complete
   * onError: something broke
   * endpoint: "chat" (default, multi-agent orchestrator) or
   *           "chat-draft" (drafting agent, plain text only, no JSON)
   */
  async sendMessage(
    messages: ChatMessage[],
    onToken: (text: string) => void,
    onDone: () => void,
    onError: (err: string) => void,
    onToolCall?: (
      name: string,
      status: ToolCallStatus,
      args?: Record<string, unknown>,
    ) => void,
    endpoint: ChatEndpoint = "chat",
  ): Promise<void> {
    const body = {
      threadId: this.threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      tools: [],
      context: [],
      forwardedProps: {},
    };

    try {
      const res = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        onError(`Server error: ${res.status}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onError("No response stream");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      // ── Tool-call buffering ──────────────────────────────────────────
      // AG-UI streams a tool call as START → ARGS deltas → END. We buffer
      // the (name, accumulated-args-text) per tool_call_id and parse on END.
      // toolCalls[id] = { name, argsText }
      const toolCalls: Record<string, { name: string; argsText: string }> = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const event = JSON.parse(jsonStr);

            switch (event.type) {
              case "TEXT_MESSAGE_CONTENT":
                onToken(event.delta || "");
                break;
              case "TEXT_MESSAGE_CHUNK":
                onToken(event.value || "");
                break;
              case "TOOL_CALL_START": {
                // AG-UI: { type, tool_call_id, tool_call_name, ... }
                const id = event.tool_call_id || event.toolCallId || event.id || "";
                const name = event.tool_call_name || event.toolCallName || event.name || "tool";
                if (id) toolCalls[id] = { name, argsText: "" };
                onToolCall?.(name, "start");
                break;
              }
              case "TOOL_CALL_ARGS": {
                // AG-UI: { type, tool_call_id, delta }  — delta is a chunk of
                // the tool's argument JSON streamed piece by piece. We append.
                const id = event.tool_call_id || event.toolCallId || "";
                const delta = event.delta || "";
                if (id && toolCalls[id]) {
                  toolCalls[id].argsText += delta;
                }
                break;
              }
              case "TOOL_CALL_CHUNK": {
                // Some adapters emit a single CHUNK event combining name + args.
                const id = event.tool_call_id || event.toolCallId || "";
                const name = event.tool_call_name || event.toolCallName || "";
                const delta = event.delta || "";
                if (id) {
                  if (!toolCalls[id]) toolCalls[id] = { name: name || "tool", argsText: "" };
                  if (name && !toolCalls[id].name) toolCalls[id].name = name;
                  toolCalls[id].argsText += delta;
                }
                break;
              }
              case "TOOL_CALL_END": {
                const id = event.tool_call_id || event.toolCallId || event.id || "";
                const buffered = id ? toolCalls[id] : undefined;
                let parsed: Record<string, unknown> | undefined;
                if (buffered?.argsText) {
                  try {
                    parsed = JSON.parse(buffered.argsText);
                  } catch (e) {
                    console.error("Failed to parse tool args JSON:", buffered.argsText, e);
                  }
                }
                const name = buffered?.name || event.tool_call_name || event.name || "tool";
                onToolCall?.(name, "end", parsed);
                if (id) delete toolCalls[id];
                break;
              }
              case "RUN_ERROR":
                onError(event.message || "Agent error");
                return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Network error");
    }
  }
}
