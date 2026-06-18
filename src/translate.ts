import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ModelSupports,
  Tool,
  ToolCall,
} from "./types.ts"

// ─── Request Translation (Anthropic → OpenAI) ───────────────────────────────

export interface ModelConfig {
  primary: string
  sonnet: string
  haiku: string
  smallFast: string
}

// Canonical effort hierarchy, lowest → highest. Used to clamp Claude Code's
// requested effort into the model-specific set GHCP exposes. Exported so CLI
// option parsing can validate against the same list (plus the "auto" sentinel).
export const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * Clamp a requested effort level into a model's supported set.
 *
 * Rules:
 *   - supported empty/missing → undefined (drop, GHCP uses its default)
 *   - requested not in canonical hierarchy → undefined (drop)
 *   - requested in supported → passthrough
 *   - requested above all supported → highest supported
 *   - requested below all supported → lowest supported
 *   - requested falls in a gap (e.g. supported=[low,high], requested=medium)
 *     → nearest supported, preferring lower (safer/cheaper)
 *
 * Unknown levels in the supported list are ignored, not crashed.
 */
export function clampEffort(
  requested: string | undefined,
  supported: Array<string> | undefined,
): string | undefined {
  if (!requested || !supported || supported.length === 0) return undefined

  const reqIdx = EFFORT_ORDER.indexOf(requested as (typeof EFFORT_ORDER)[number])
  if (reqIdx === -1) return undefined

  if (supported.includes(requested)) return requested

  const ranked = supported
    .map((s) => [s, EFFORT_ORDER.indexOf(s as (typeof EFFORT_ORDER)[number])] as const)
    .filter(([, i]) => i !== -1)
    .sort((a, b) => a[1] - b[1])

  if (ranked.length === 0) return undefined

  const lowest = ranked[0]
  const highest = ranked[ranked.length - 1]

  if (reqIdx > highest[1]) return highest[0]
  if (reqIdx < lowest[1]) return lowest[0]

  // Gap case: nearest, prefer lower (matches "no errors / no over-billing" intent).
  let best = lowest
  for (const candidate of ranked) {
    if (candidate[1] <= reqIdx) {
      best = candidate
    } else {
      break
    }
  }
  return best[0]
}

/**
 * Apply a minimum effort floor. If the requested effort is below the floor
 * (or absent), raise it to the floor. If the floor is invalid or unset,
 * pass through unchanged.
 *
 * This runs BEFORE clampEffort — the floor raises the request, then clamping
 * ensures the result is within the model's supported set.
 *
 * Reads from PROXY_CLAUDE_MIN_EFFORT env var (set via --effort CLI or
 * first-run picker, persisted in ~/.claude/settings.json env block).
 */
export function applyEffortFloor(
  requested: string | undefined,
  floor: string | undefined,
): string | undefined {
  if (!floor) return requested
  const floorIdx = EFFORT_ORDER.indexOf(floor as (typeof EFFORT_ORDER)[number])
  if (floorIdx === -1) return requested // invalid floor value, ignore

  if (!requested) return floor // no request → use floor directly

  const reqIdx = EFFORT_ORDER.indexOf(requested as (typeof EFFORT_ORDER)[number])
  if (reqIdx === -1) return floor // unrecognized request → use floor

  return floorIdx > reqIdx ? floor : requested
}

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  modelConfig?: ModelConfig,
  mappedModelCapabilities?: ModelSupports,
  /**
   * Pre-resolved real GHCP model id. Pass this when the caller has already
   * computed the mapping (e.g. server handler that needs the same id for
   * capability lookup). When omitted, falls back to recomputing via
   * mapModelToCopilot without alias resolution — which is correct only for
   * call sites that don't care about aliasing (translate.ts unit tests).
   */
  mappedModelOverride?: string,
  /**
   * Minimum effort floor. When set, effort below this level is raised to it
   * before clamping to the model's supported set. Passed explicitly by the
   * server (from env var) so unit tests aren't affected by ambient env.
   */
  effortFloor?: string,
): ChatCompletionsPayload {
  const requestedEffort = payload.output_config?.effort
  const effectiveEffort = applyEffortFloor(requestedEffort, effortFloor)
  const reasoningEffort = clampEffort(
    effectiveEffort,
    mappedModelCapabilities?.reasoning_effort,
  )

  const result: ChatCompletionsPayload = {
    model: mappedModelOverride ?? mapModelToCopilot(payload.model, modelConfig),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  }

  if (reasoningEffort !== undefined) {
    result.reasoning_effort = reasoningEffort
  }

  return result
}

/**
 * Strip the literal trailing "[1m]" bracket suffix that Claude Code uses
 * client-side as a context-window hint. The "1m" inside a model id
 * (e.g. "claude-opus-4.7-1m-internal") is preserved.
 */
function stripContextHint(model: string): string {
  return model.replace(/\[1m\]$/, "")
}

const HAIKU_RE = /claude-(?:\d+[-.]\d+[-.])?haiku/i
const SONNET_RE = /claude-(?:\d+[-.]\d+[-.])?sonnet/i
const CLAUDE_RE = /^claude[-.]/i

/**
 * Given a real GHCP Claude model id (dot-versioned, e.g.
 * "claude-opus-4.7-1m-internal"), produce a dash-canonical alias that
 * Claude Code's substring matchers recognize as a Claude model.
 *
 * Returns null for ids that aren't dot-versioned Claude families (those are
 * either already in canonical form, e.g. "claude-opus-4", or aren't Claude at
 * all, e.g. "gpt-4.1"). In both cases the caller should pass the id through
 * unchanged.
 *
 * The `has1m` flag is derived from the *real id's* suffix segment, never from
 * the alias string — keeping that flag independent prevents `[1m]` from being
 * appended twice when the alias itself happens to include "1m" segments.
 *
 * Examples:
 *   "claude-opus-4.7-1m-internal" → { alias: "claude-opus-4-7", has1m: true }
 *   "claude-opus-4.6-1m"          → { alias: "claude-opus-4-6", has1m: true }
 *   "claude-opus-4.6"             → { alias: "claude-opus-4-6", has1m: false }
 *   "claude-sonnet-4.6"           → { alias: "claude-sonnet-4-6", has1m: false }
 *   "claude-haiku-4.5"            → { alias: "claude-haiku-4-5", has1m: false }
 *   "gpt-4.1"                     → null
 *   "claude-opus-4"               → null (no dot in version; already canonical)
 */
export function ghcpIdToAlias(realId: string): { alias: string; has1m: boolean } | null {
  const m = realId.match(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)(?:-(.+))?$/i)
  if (!m) return null
  const [, family, major, minor, suffix] = m
  const alias = `claude-${family.toLowerCase()}-${major}-${minor}`
  const has1m = suffix !== undefined && /(^|[-_.])1m([-_.]|$)/i.test(suffix)
  return { alias, has1m }
}

/**
 * Map incoming Anthropic-style model identifiers to a GHCP model.
 * Claude Code's agent teams override the env-configured model with hard-coded
 * tier names ("haiku", "sonnet", "opus") or canonical Anthropic IDs
 * (e.g. "claude-3-5-haiku-20241022"). GHCP rejects those.
 *
 * Tier routing (fallbacks resolved upstream in main.ts):
 *   - haiku-tier  → smallFast
 *   - sonnet-tier → sonnet
 *   - opus / other claude-* → primary
 *   - non-claude  → unchanged
 *
 * On every return path, the resulting id is alias-resolved via `resolveAlias`
 * (final step). This means model-config tier values can themselves be aliases
 * (which they will be after configureFirstRun writes the canonical settings
 * id), and the request handler always ends up with the *real* GHCP id —
 * never the alias — so capability lookups and the upstream payload stay in
 * sync.
 */
export function mapModelToCopilot(
  incoming: string,
  modelConfig?: ModelConfig,
  resolveAlias?: (alias: string) => string | undefined,
): string {
  const resolveFinal = (id: string): string => {
    const clean = stripContextHint(id)
    return resolveAlias?.(clean) ?? clean
  }

  const clean = stripContextHint(incoming)
  if (!modelConfig) return resolveFinal(clean)

  const lower = clean.toLowerCase()

  if (lower === "haiku" || HAIKU_RE.test(clean)) {
    return resolveFinal(modelConfig.smallFast)
  }

  if (lower === "sonnet" || SONNET_RE.test(clean)) {
    return resolveFinal(modelConfig.sonnet)
  }

  if (lower === "opus" || CLAUDE_RE.test(clean)) {
    return resolveFinal(modelConfig.primary)
  }

  return resolveFinal(clean)
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user"
      ? handleUserMessage(message)
      : handleAssistantMessage(message),
  )

  // GHCP-side validation on some Claude models (notably opus-4.8) rejects
  // requests where the final assistant message content ends with whitespace
  // with: 400 "final assistant content cannot end with trailing whitespace".
  // Anthropic's own API has the same rule. Right-trim the last assistant
  // message to make the request universally acceptable.
  trimFinalAssistantWhitespace(otherMessages)

  // GHCP-side validation on opus-4.8 (and likely other newer Claude models
  // surfaced through GHCP) also rejects requests whose final message is an
  // assistant message with: 400 "This model does not support assistant
  // message prefill. The conversation must end with a user message."
  // Anthropic's native API accepts a trailing assistant message as a prefill
  // hint; GHCP does not. Claude Code occasionally produces conversations
  // ending in an assistant message (e.g. after an interrupted turn). Append
  // a synthetic "continue" user message so the request is universally
  // acceptable. On models that *do* support prefill, this changes behavior
  // from "continue the assistant text" to "respond to a continue prompt" —
  // which matches what Claude Code actually wants in this scenario.
  ensureConversationEndsWithUser(otherMessages)

  return [...systemMessages, ...otherMessages]
}

/**
 * If the final message in the conversation is an assistant message, append a
 * synthetic user message asking it to continue. GHCP's opus-4.8 rejects
 * trailing assistant messages outright; this guards against that.
 *
 * Tool messages (role="tool") are also acceptable terminators in
 * OpenAI/GHCP land — they represent tool results that the model is expected
 * to react to, so we leave those alone.
 */
function ensureConversationEndsWithUser(messages: Array<Message>): void {
  if (messages.length === 0) return
  const last = messages[messages.length - 1]
  if (last.role !== "assistant") return
  messages.push({
    role: "user",
    content: "Please continue.",
  })
}

/**
 * Walk messages from the end; if the last message is an assistant message
 * with string content, right-trim it. Tool-use messages and tool messages
 * aren't affected (they don't carry user-visible trailing whitespace).
 * Array content (multi-modal) is also normalized: the last text part is
 * right-trimmed.
 */
function trimFinalAssistantWhitespace(messages: Array<Message>): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    if (typeof m.content === "string") {
      m.content = m.content.replace(/\s+$/, "")
      // If trimming made content empty AND the message has tool_calls,
      // null is the OpenAI convention. Otherwise keep empty string.
      if (m.content === "" && m.tool_calls && m.tool_calls.length > 0) {
        m.content = null as unknown as string
      }
    } else if (Array.isArray(m.content)) {
      // Find the last text part and trim it.
      for (let j = m.content.length - 1; j >= 0; j--) {
        const part = m.content[j]
        if (part.type === "text") {
          part.text = part.text.replace(/\s+$/, "")
          break
        }
      }
    }
    return // only the last assistant message matters
  }
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    ) as Array<Exclude<AnthropicUserContentBlock, AnthropicToolResultBlock>>

    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0
    ? [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function" as const,
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return (
      content
        .filter(
          (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
            block.type === "text" || block.type === "thinking",
        )
        .map((block) => (block.type === "text" ? block.text : block.thinking))
        .join("\n\n") || null
    )
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })
        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })
        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
        break
      }
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// ─── Response Translation (OpenAI → Anthropic) ──────────────────────────────

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0) -
        (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: string | null,
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }
  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}

// ─── Error Translation (OpenAI → Anthropic) ─────────────────────────────────

/**
 * Parse an OpenAI-format error body and translate it to Anthropic error format.
 * Maps OpenAI error codes/types to the Anthropic error types that Claude Code
 * understands for triggering auto-compaction and other recovery behaviors.
 */
export function translateOpenAIErrorToAnthropic(
  status: number,
  body: string,
): { type: string; message: string } {
  let errorMessage = body
  let errorCode = ""

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string; type?: string }
    }
    if (parsed.error) {
      errorMessage = parsed.error.message ?? body
      errorCode = parsed.error.code ?? parsed.error.type ?? ""
    }
  } catch {
    // Body isn't JSON — use raw string as message
  }

  // Map to Anthropic error types that Claude Code recognizes
  const anthropicType = mapOpenAIErrorToAnthropicType(status, errorCode, errorMessage)

  return { type: anthropicType, message: errorMessage }
}

function mapOpenAIErrorToAnthropicType(
  status: number,
  errorCode: string,
  errorMessage: string,
): string {
  const codeLower = errorCode.toLowerCase()
  const msgLower = errorMessage.toLowerCase()

  // Context length / token limit exceeded → invalid_request_error
  // This is the critical mapping for auto-compaction
  if (
    codeLower === "context_length_exceeded" ||
    codeLower === "max_tokens" ||
    msgLower.includes("context length") ||
    msgLower.includes("maximum context") ||
    msgLower.includes("token limit") ||
    msgLower.includes("too many tokens") ||
    msgLower.includes("max_tokens") ||
    msgLower.includes("reduce the length")
  ) {
    return "invalid_request_error"
  }

  // Map by HTTP status code
  switch (status) {
    case 400:
      return "invalid_request_error"
    case 401:
      return "authentication_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 429:
      return "rate_limit_error"
    case 529:
    case 503:
      return "overloaded_error"
    default:
      return status >= 500 ? "api_error" : "invalid_request_error"
  }
}

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}
