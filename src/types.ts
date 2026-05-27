// ─── Anthropic API Types ─────────────────────────────────────────────────────

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  thinking?: {
    type: "enabled"
    budget_tokens?: number
  }
  service_tier?: "auto" | "standard_only"
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
  }
}

// ─── Anthropic Stream Event Types ────────────────────────────────────────────

export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
}

// ─── OpenAI / Chat Completions Types ─────────────────────────────────────────

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

export interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

export interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

export interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}

// ─── Model Types ─────────────────────────────────────────────────────────────

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

export interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

export interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

export interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}

// ─── App Types ───────────────────────────────────────────────────────────────

export interface LockFileContent {
  pid: number
  port: number
  nonce: string
  timestamp: number
  version?: string
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
    [key: string]: string | undefined
  }
  sku?: string
}

export interface CliOptions {
  useAgency: boolean
  resetModels: boolean
  passthroughArgs: string[]
}

// ─── Telemetry Types ──────────────────────────────────────────────────────────

export interface TelemetryEvent {
  // Timing
  timestamp: string
  durationMs: number

  // Identity
  user: string

  // Request metadata
  model: string
  stream: boolean
  messageCount: number
  toolCount: number
  hasThinking: boolean

  // Response metadata
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string

  // Derived insights
  hourOfDay: number
  dayOfWeek: string
  estimatedCostUSD: number

  // Copilot API provenance — proof the response came from GitHub Copilot
  copilotApiUrl?: string
  copilotRequestId?: string
  copilotCompletionId?: string
  copilotModelServed?: string
  systemFingerprint?: string

  // Errors
  success: boolean
  errorType?: string
  errorStatus?: number
}

export interface TelemetryContext {
  githubUsername: string
  copilotSku?: string
  proxyVersion: string
  sessionId: string
}

/**
 * Metadata extracted from GitHub Copilot API response headers.
 * These are server-generated values that prove the response came from GHCP.
 */
export interface CopilotResponseMeta {
  requestId?: string       // x-request-id response header — GitHub's trace ID
}

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheWritePerMillion: number
  cacheReadPerMillion: number
}
