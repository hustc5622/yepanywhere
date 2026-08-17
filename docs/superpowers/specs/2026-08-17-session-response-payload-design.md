# Session Response Payload Design

## Goal

Reduce the initial browser session response from tens of megabytes to a small metadata-and-text payload without changing provider context, persisted session files, user attachments, or the existing click-to-open local image flow.

The production reproduction used the latest 100 messages from session `01a00ced-6cbb-7253-ac80-6d9b2dacbe5f`. Its uncompressed JSON response was 62,463,479 bytes. Within the top-level message list, raw tool-result content occupied 15,632,494 bytes and the parsed `toolUseResult` representation occupied another 15,577,112 bytes. The route then serialized the same messages again inside `session.messages`.

## Scope

This phase changes only the browser-facing session response and ordinary HTTP JSON compression. It does not modify session reading, provider normalization, provider resume behavior, or data persisted by Codex, Claude, Gemini, or OpenCode.

## Approaches Considered

### Browser response projection

Create a dedicated response projection at the session API boundary. It removes redundant and non-rendered data while leaving the domain `Session` intact. This is the selected approach because it isolates display transport from model context.

### Opt-in compact query mode

Add a `compact=true` query parameter and retain the old response by default. This would preserve an unused external contract but leave two response shapes to maintain. The only supported consumer is Yep Anywhere's browser client, so this extra compatibility path is not justified.

### Global normalization changes

Remove embedded image data while normalizing provider sessions. This is smaller at the route level but risks changing internal consumers and provider resume behavior. It is rejected because transport optimization must not alter model-visible session data.

## Architecture

Add a pure browser-response projection between the normalized domain session and `c.json(...)`. The projection must not mutate its input.

The response contract becomes:

- `session`: session metadata without a `messages` property;
- `messages`: the single browser-facing message list;
- existing ownership, runtime, pending-input, slash-command, and pagination fields unchanged.

The client models the metadata object separately from a full server-side `Session`. No compatibility field containing an empty or stale `session.messages` array is retained.

## Tool Result Projection

Sanitization is limited to result messages. User-authored `input_image` attachments, generated-image paths, `ViewImage` tool inputs, ordinary URLs, and local file paths remain unchanged.

For `tool_result` content and its associated `toolUseResult`:

1. Recursively copy arrays and plain JSON objects.
2. When an `input_image.image_url` is a `data:image/*;base64,...` URL, remove `image_url` and add an `omitted_image` object containing the MIME type and decoded binary byte size.
3. Preserve sibling text, status, detail, error, and other structured fields.
4. When the raw tool-result content parses as a JSON object or array, sanitize that parsed value independently. If at least one image is omitted, serialize the sanitized value back into the content field so the raw string cannot retain a second base64 copy.
5. When raw tool-result content is not valid JSON, preserve it unchanged. Do not use broad regular-expression rewriting on arbitrary tool output.

This projection does not add a new image renderer or image endpoint. The current clickable file reference continues to load through `/api/local-image` only after the user opens it. Embedded images returned by generic `exec` results remain intentionally unavailable in the browser because the current renderer does not consume them.

## Data Flow

1. The provider writes the complete tool output, including image data, to its original session record.
2. Yep Anywhere reads and normalizes the complete session exactly as it does today.
3. The session route applies the browser projection to the paginated messages.
4. The route returns session metadata once and projected messages once.
5. The browser downloads and parses the compact response.
6. A user clicking an existing local image reference triggers the existing image request independently.

## HTTP Compression

Enable Hono's negotiated gzip or deflate compression for ordinary HTTP JSON responses above the middleware's minimum useful size. WebSocket upgrades and streaming responses are excluded. Clients that do not advertise a supported encoding continue to receive valid uncompressed JSON.

Compression is defense in depth after structural duplication is removed; it is not a substitute for response projection because base64 image data compresses poorly and still consumes browser parse memory.

## Error Handling

- Projection operates only on JSON-compatible values already accepted by the session response.
- Unexpected primitive values pass through unchanged.
- Invalid raw JSON content remains unchanged rather than making the session unavailable.
- Projection failures must not mutate or rewrite the persisted session.
- The response must never silently fall back to returning a second `session.messages` copy.

## Non-goals

- Do not remove image data from JSONL or provider context.
- Do not change how providers resume or reconstruct conversations.
- Do not remove or defer user-authored image attachments.
- Do not build a renderer for images nested inside generic `exec` results.
- Do not change FRP, authentication, or public network configuration.
- Do not address the React hook-order, stale module chunk, or process-supervisor defects in this phase.

## Verification

Implementation follows test-driven development at the real response boundary.

- Projection unit tests verify nested data URLs are replaced, adjacent text and metadata survive, and input objects are unchanged.
- Tests verify user-authored images, normal URLs, generated-image paths, and `ViewImage` inputs are preserved.
- A route integration test verifies `session.messages` is absent and projected messages appear only at the top level.
- A route fixture containing large generic `exec` image results verifies the serialized response contains no hidden tool-result data URL and stays within a fixed compact size budget.
- Client tests verify the new session metadata contract, transcript rendering, user attachments, and existing click-to-open images.
- Compression tests verify negotiated encoding for ordinary JSON and no interference with WebSocket or streaming paths.
- The original production reproduction must return the latest 100 messages in less than 1 MiB uncompressed, down from 62,463,479 bytes.
- A follow-up turn must resume successfully with prior image-informed provider context intact.
- Loading the response must leave the source session JSONL byte-for-byte unchanged. After the explicit follow-up turn, the file may append new entries, but its pre-turn byte prefix must remain unchanged.

## Delivery Boundary

This document covers only phase 1. After it is implemented and verified, the next independent design phase addresses the `SessionPage` React hook-order crash.
