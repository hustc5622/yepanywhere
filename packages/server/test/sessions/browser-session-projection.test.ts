import { describe, expect, it } from "vitest";
import {
  createBrowserSessionProjection,
  projectBrowserMessages,
} from "../../src/sessions/browser-session-projection.js";
import type { Message } from "../../src/supervisor/types.js";

describe("projectBrowserMessages", () => {
  it("omits data images recursively only inside tool results", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`;
    const messages: Message[] = [
      {
        type: "user",
        uuid: "user-1",
        message: {
          content: [{ type: "input_image", image_url: dataUrl }],
        },
      },
      {
        type: "user",
        uuid: "tool-result-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: JSON.stringify({
                output: [{ type: "input_image", image_url: dataUrl }],
              }),
            },
          ],
        },
        toolUseResult: {
          output: [{ type: "input_image", image_url: dataUrl }],
        },
      },
    ];

    const projected = projectBrowserMessages(messages);

    expect(JSON.stringify(projected[0])).toContain(dataUrl);
    expect(JSON.stringify(projected[1])).not.toContain("data:image/png;base64");
    expect(projected[1]?.toolUseResult).toMatchObject({
      output: [
        {
          type: "input_image",
          omitted_image: { mimeType: "image/png", byteLength: 11 },
        },
      ],
    });
    expect(messages[1]?.toolUseResult).toMatchObject({
      output: [{ image_url: dataUrl }],
    });
  });

  it("leaves invalid tool-result JSON byte-for-byte unchanged", () => {
    const invalidJson = ' {"output": [} \r\n';
    const message: Message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-invalid",
            content: invalidJson,
          },
        ],
      },
    };

    const [projected] = projectBrowserMessages([message]);
    const content = projected?.message?.content;

    expect(Array.isArray(content) ? content[0]?.content : undefined).toBe(
      invalidJson,
    );
    expect(projected).toBe(message);
  });

  it("leaves HTTP image URLs unchanged", () => {
    const imageUrl = "https://example.com/image.png";
    const rawContent = JSON.stringify({
      output: [{ type: "input_image", image_url: imageUrl }],
    });
    const message: Message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-http",
            content: rawContent,
          },
        ],
      },
      toolUseResult: {
        output: [{ type: "input_image", image_url: imageUrl }],
      },
    };

    const [projected] = projectBrowserMessages([message]);

    expect(projected).toBe(message);
    expect(JSON.stringify(projected)).toContain(imageUrl);
  });

  it("passes primitives through tool results unchanged", () => {
    const primitives = [null, true, 42, "plain text"];
    const rawContent = JSON.stringify(primitives);
    const message: Message = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-primitives",
            content: rawContent,
          },
        ],
      },
      toolUseResult: primitives,
    };

    const [projected] = projectBrowserMessages([message]);

    expect(projected).toBe(message);
    expect(projected?.toolUseResult).toBe(primitives);
    const content = projected?.message?.content;
    expect(Array.isArray(content) ? content[0]?.content : undefined).toBe(
      rawContent,
    );
  });

  it("retains object identity for messages without omissions", () => {
    const messages: Message[] = [
      {
        type: "user",
        uuid: "plain-user",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "assistant",
        uuid: "plain-assistant",
        message: { content: "plain response" },
      },
    ];

    const projected = projectBrowserMessages(messages);

    expect(projected[0]).toBe(messages[0]);
    expect(projected[1]).toBe(messages[1]);
  });
});

describe("createBrowserSessionProjection", () => {
  it("removes embedded messages from the session projection", () => {
    const projection = createBrowserSessionProjection(
      { id: "session", messages: [], title: "Session" },
      [],
    );

    expect(projection).toEqual({
      session: { id: "session", title: "Session" },
      messages: [],
    });
  });

  it("keeps large duplicated tool-result images below the payload budget", () => {
    const messages: Message[] = Array.from({ length: 30 }, (_, index) => {
      const dataUrl = `data:image/png;base64,${Buffer.alloc(
        512 * 1024,
        index + 1,
      ).toString("base64")}`;
      return {
        type: "user",
        uuid: `tool-result-${index}`,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${index}`,
              content: JSON.stringify({
                output: [{ type: "input_image", image_url: dataUrl }],
              }),
            },
          ],
        },
        toolUseResult: {
          output: [{ type: "input_image", image_url: dataUrl }],
        },
      };
    });

    const projection = createBrowserSessionProjection(
      { id: "large", messages, title: "Large session" },
      messages,
    );
    const encoded = JSON.stringify(projection);

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(1024 * 1024);
    expect(encoded).not.toContain("data:image/");
    expect(projection.session).not.toHaveProperty("messages");
  });
});
