// Yep-owned Feishu tool contracts; retained names/actions for existing sessions.
function resolveTokenMode(toolName, action) {
  const mode2 = TOOL_TOKEN_MODES[toolName];
  if (!mode2) return "auto";
  if (typeof mode2 === "string") return mode2;
  if (action && mode2[action]) return mode2[action];
  return mode2._default ?? "auto";
}
const OAPI_TOOLS = [
  // ── Calendar ──
  {
    name: "lark_calendar_event",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u65E5\u7A0B\u7BA1\u7406\u5DE5\u5177\u3002Actions: create\uFF08\u521B\u5EFA\u65E5\u5386\u4E8B\u4EF6\uFF09, list\uFF08\u67E5\u8BE2\u65F6\u95F4\u8303\u56F4\u5185\u7684\u65E5\u7A0B\uFF0C\u81EA\u52A8\u5C55\u5F00\u91CD\u590D\u65E5\u7A0B\uFF09, get\uFF08\u83B7\u53D6\u65E5\u7A0B\u8BE6\u60C5\uFF09, patch\uFF08\u66F4\u65B0\u65E5\u7A0B\uFF09, delete\uFF08\u5220\u9664\u65E5\u7A0B\uFF09, search\uFF08\u641C\u7D22\u65E5\u7A0B\uFF09, reply\uFF08\u56DE\u590D\u65E5\u7A0B\u9080\u8BF7\uFF09, instances\uFF08\u83B7\u53D6\u91CD\u590D\u65E5\u7A0B\u7684\u5B9E\u4F8B\u5217\u8868\uFF09, instance_view\uFF08\u67E5\u770B\u5C55\u5F00\u540E\u7684\u65E5\u7A0B\u5217\u8868\uFF09\u3002\u3010\u91CD\u8981\u3011create \u65F6\u5FC5\u987B\u4F20 user_open_id \u53C2\u6570\uFF08ou_xxx\uFF09\uFF0C\u5426\u5219\u65E5\u7A0B\u53EA\u5728\u5E94\u7528\u65E5\u5386\u4E0A\uFF0C\u7528\u6237\u770B\u4E0D\u5230\u3002\u65F6\u95F4\u53C2\u6570\u4F7F\u7528ISO 8601\u683C\u5F0F\uFF08\u5305\u542B\u65F6\u533A\uFF09\uFF0C\u4F8B\u5982 '2024-01-01T00:00:00+08:00'\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "get",
            "patch",
            "delete",
            "search",
            "reply",
            "instances",
            "instance_view",
          ],
          description: "Action to perform",
        },
        calendar_id: {
          type: "string",
          description:
            "Calendar ID (optional; primary calendar used if omitted)",
        },
        event_id: {
          type: "string",
          description:
            "Event ID (required for get/patch/delete/reply/instances)",
        },
        summary: { type: "string", description: "\u65E5\u7A0B\u6807\u9898" },
        description: {
          type: "string",
          description: "\u65E5\u7A0B\u63CF\u8FF0",
        },
        start_time: {
          type: "string",
          description:
            "\u5F00\u59CB\u65F6\u95F4\uFF08ISO 8601\u683C\u5F0F\uFF0C\u5982 2024-01-01T00:00:00+08:00\uFF09",
        },
        end_time: {
          type: "string",
          description:
            "\u7ED3\u675F\u65F6\u95F4\uFF08ISO 8601\u683C\u5F0F\uFF09",
        },
        user_open_id: {
          type: "string",
          description:
            "\u5F53\u524D\u7528\u6237\u7684 open_id\uFF08ou_xxx\uFF09\u3002create \u65F6\u5F3A\u70C8\u5EFA\u8BAE\u63D0\u4F9B\uFF0C\u786E\u4FDD\u7528\u6237\u80FD\u770B\u5230\u65E5\u7A0B\u3002",
        },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["user", "chat", "resource", "third_party"],
              },
              id: { type: "string" },
            },
            required: ["type", "id"],
          },
          description: "\u53C2\u4F1A\u4EBA\u5217\u8868",
        },
        location: {
          type: "object",
          properties: { name: { type: "string" }, address: { type: "string" } },
          description: "\u5730\u70B9\u4FE1\u606F",
        },
        need_notification: {
          type: "boolean",
          description:
            "\u662F\u5426\u901A\u77E5\u53C2\u4F1A\u4EBA\uFF08delete\u65F6\u4F7F\u7528\uFF09",
        },
        query: {
          type: "string",
          description:
            "\u641C\u7D22\u5173\u952E\u8BCD\uFF08search action\uFF09",
        },
        rsvp_status: {
          type: "string",
          enum: ["accept", "decline", "tentative"],
          description: "\u56DE\u590D\u72B6\u6001\uFF08reply action\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_calendar_freebusy",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u65E5\u5386\u5FD9\u95F2\u67E5\u8BE2\u5DE5\u5177\u3002\u67E5\u8BE2\u67D0\u65F6\u95F4\u6BB5\u5185\u67D0\u4EBA\u662F\u5426\u7A7A\u95F2\u3002\u652F\u6301\u6279\u91CF\u67E5\u8BE2 1-10 \u4E2A\u7528\u6237\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list"],
          description: 'Action (only "list")',
        },
        time_min: {
          type: "string",
          description:
            "\u67E5\u8BE2\u8D77\u59CB\u65F6\u95F4\uFF08ISO 8601\u683C\u5F0F\uFF09",
        },
        time_max: {
          type: "string",
          description:
            "\u67E5\u8BE2\u7ED3\u675F\u65F6\u95F4\uFF08ISO 8601\u683C\u5F0F\uFF09",
        },
        user_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "\u7528\u6237 open_id \u5217\u8868\uFF081-10 \u4E2A\uFF09",
        },
      },
      required: ["action", "time_min", "time_max", "user_ids"],
    },
  },
  // ── Task ──
  {
    name: "lark_task",
    description:
      '\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u4EFB\u52A1\u7BA1\u7406\u5DE5\u5177\u3002Actions: create\uFF08\u521B\u5EFA\u4EFB\u52A1\uFF09, get\uFF08\u83B7\u53D6\u4EFB\u52A1\u8BE6\u60C5\uFF09, list\uFF08\u67E5\u8BE2\u4EFB\u52A1\u5217\u8868\uFF09, patch\uFF08\u66F4\u65B0\u4EFB\u52A1/\u5B8C\u6210\u4EFB\u52A1\uFF09\u3002\u5B8C\u6210\u4EFB\u52A1\uFF1Apatch + completed_at="2026-01-01 15:00:00"\uFF1B\u53CD\u5B8C\u6210\uFF1Acompleted_at="0"\u3002\u65F6\u95F4\u4F7F\u7528ISO 8601\u683C\u5F0F\u3002',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "list", "patch"],
          description: "Action",
        },
        task_guid: {
          type: "string",
          description: "\u4EFB\u52A1 GUID\uFF08get/patch \u5FC5\u586B\uFF09",
        },
        summary: {
          type: "string",
          description:
            "\u4EFB\u52A1\u6807\u9898\uFF08create \u5FC5\u586B\uFF09",
        },
        description: {
          type: "string",
          description: "\u4EFB\u52A1\u63CF\u8FF0",
        },
        current_user_id: {
          type: "string",
          description:
            "\u5F53\u524D\u7528\u6237 open_id\uFF08ou_xxx\uFF09\uFF0C\u5F3A\u70C8\u5EFA\u8BAE\u63D0\u4F9B",
        },
        due: {
          type: "object",
          properties: {
            timestamp: { type: "string" },
            is_all_day: { type: "boolean" },
          },
          description: "\u622A\u6B62\u65F6\u95F4",
        },
        start: {
          type: "object",
          properties: {
            timestamp: { type: "string" },
            is_all_day: { type: "boolean" },
          },
          description: "\u5F00\u59CB\u65F6\u95F4",
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              role: { type: "string", enum: ["assignee", "follower"] },
            },
            required: ["id"],
          },
          description: "\u4EFB\u52A1\u6210\u5458",
        },
        completed_at: {
          type: "string",
          description:
            '\u5B8C\u6210\u65F6\u95F4\uFF08ISO 8601\u683C\u5F0F\uFF09\uFF0C\u8BBE\u4E3A "0" \u8868\u793A\u53CD\u5B8C\u6210',
        },
        completed: {
          type: "boolean",
          description: "\u662F\u5426\u5B8C\u6210\uFF08list \u8FC7\u6EE4\uFF09",
        },
        tasklists: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tasklist_guid: { type: "string" },
              section_guid: { type: "string" },
            },
          },
          description: "\u5F52\u5C5E\u4EFB\u52A1\u6E05\u5355",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_tasklist",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u4EFB\u52A1\u6E05\u5355\u7BA1\u7406\u5DE5\u5177\u3002Actions: create\uFF08\u521B\u5EFA\u6E05\u5355\uFF09, list\uFF08\u67E5\u8BE2\u6E05\u5355\u5217\u8868\uFF09, get\uFF08\u83B7\u53D6\u6E05\u5355\u8BE6\u60C5\uFF09, tasks\uFF08\u67E5\u770B\u6E05\u5355\u5185\u7684\u4EFB\u52A1\uFF09, add_members\uFF08\u6DFB\u52A0\u6E05\u5355\u6210\u5458\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "get", "tasks", "add_members"],
          description: "Action",
        },
        tasklist_guid: {
          type: "string",
          description:
            "\u6E05\u5355 GUID\uFF08get/tasks/add_members \u5FC5\u586B\uFF09",
        },
        name: {
          type: "string",
          description:
            "\u6E05\u5355\u540D\u79F0\uFF08create \u5FC5\u586B\uFF09",
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              role: { type: "string", enum: ["editor", "viewer"] },
              type: { type: "string", enum: ["user", "chat"] },
            },
            required: ["id"],
          },
          description: "\u6E05\u5355\u6210\u5458",
        },
        completed: {
          type: "boolean",
          description: "\u662F\u5426\u5B8C\u6210\uFF08tasks \u8FC7\u6EE4\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Bitable ──
  {
    name: "lark_bitable_record",
    description:
      '\u98DE\u4E66\u591A\u7EF4\u8868\u683C\u8BB0\u5F55\u7BA1\u7406\u5DE5\u5177\u3002Actions: create\uFF08\u521B\u5EFA\u5355\u6761\u8BB0\u5F55\uFF09, list\uFF08\u67E5\u8BE2\u8BB0\u5F55\uFF0C\u652F\u6301\u9AD8\u7EA7\u7B5B\u9009\uFF09, update\uFF08\u66F4\u65B0\u8BB0\u5F55\uFF09, delete\uFF08\u5220\u9664\u8BB0\u5F55\uFF09, batch_create\uFF08\u6279\u91CF\u521B\u5EFA\u2264500\u6761\uFF09, batch_update\uFF08\u6279\u91CF\u66F4\u65B0\u2264500\u6761\uFF09, batch_delete\uFF08\u6279\u91CF\u5220\u9664\u2264500\u6761\uFF09\u3002\u3010\u91CD\u8981\u3011\u5199\u5165\u524D\u5148\u7528 lark_bitable_field.list \u83B7\u53D6\u5B57\u6BB5\u7C7B\u578B\u3002\u4EBA\u5458\u5B57\u6BB5\uFF1A[{id:"ou_xxx"}]\uFF1B\u65E5\u671F\u5B57\u6BB5\uFF1A\u6BEB\u79D2\u65F6\u95F4\u6233\uFF1B\u5355\u9009\uFF1A\u5B57\u7B26\u4E32\uFF1B\u591A\u9009\uFF1A\u5B57\u7B26\u4E32\u6570\u7EC4\u3002',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "update",
            "delete",
            "batch_create",
            "batch_update",
            "batch_delete",
          ],
          description: "Action",
        },
        app_token: {
          type: "string",
          description: "\u591A\u7EF4\u8868\u683C token",
        },
        table_id: { type: "string", description: "\u6570\u636E\u8868 ID" },
        record_id: {
          type: "string",
          description: "\u8BB0\u5F55 ID\uFF08update/delete\uFF09",
        },
        fields: {
          type: "object",
          additionalProperties: true,
          description: "\u8BB0\u5F55\u5B57\u6BB5",
        },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fields: { type: "object", additionalProperties: true },
              record_id: { type: "string" },
            },
          },
          description:
            "\u6279\u91CF\u64CD\u4F5C\u7684\u8BB0\u5F55\u5217\u8868\uFF08\u2264500\u6761\uFF09",
        },
        record_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "\u6279\u91CF\u5220\u9664\u7684\u8BB0\u5F55 ID \u5217\u8868",
        },
        filter: {
          type: "object",
          properties: {
            conjunction: { type: "string", enum: ["and", "or"] },
            conditions: { type: "array", items: { type: "object" } },
          },
          description: "\u7B5B\u9009\u6761\u4EF6\uFF08list\uFF09",
        },
        sort: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field_name: { type: "string" },
              desc: { type: "boolean" },
            },
          },
          description: "\u6392\u5E8F\uFF08list\uFF09",
        },
        field_names: {
          type: "array",
          items: { type: "string" },
          description:
            "\u8FD4\u56DE\u5B57\u6BB5\u540D\u5217\u8868\uFF08list\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "app_token", "table_id"],
    },
  },
  {
    name: "lark_bitable_field",
    description:
      "\u98DE\u4E66\u591A\u7EF4\u8868\u683C\u5B57\u6BB5\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u67E5\u8BE2\u5B57\u6BB5\u5217\u8868\uFF09, create\uFF08\u521B\u5EFA\u5B57\u6BB5\uFF09\u3002\u5199\u5165\u8BB0\u5F55\u524D\u5FC5\u987B\u5148 list \u5B57\u6BB5\u83B7\u53D6 type \u548C ui_type\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Action",
        },
        app_token: {
          type: "string",
          description: "\u591A\u7EF4\u8868\u683C token",
        },
        table_id: { type: "string", description: "\u6570\u636E\u8868 ID" },
        field_name: {
          type: "string",
          description: "\u5B57\u6BB5\u540D\u79F0\uFF08create\uFF09",
        },
        type: {
          type: "number",
          description: "\u5B57\u6BB5\u7C7B\u578B\uFF08create\uFF09",
        },
        property: {
          type: "object",
          additionalProperties: true,
          description: "\u5B57\u6BB5\u5C5E\u6027\u914D\u7F6E\uFF08create\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "app_token", "table_id"],
    },
  },
  {
    name: "lark_bitable_table",
    description:
      "\u98DE\u4E66\u591A\u7EF4\u8868\u683C\u6570\u636E\u8868\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u67E5\u8BE2\u6570\u636E\u8868\u5217\u8868\uFF09, create\uFF08\u521B\u5EFA\u6570\u636E\u8868\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Action",
        },
        app_token: {
          type: "string",
          description: "\u591A\u7EF4\u8868\u683C token",
        },
        name: {
          type: "string",
          description: "\u6570\u636E\u8868\u540D\u79F0\uFF08create\uFF09",
        },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field_name: { type: "string" },
              type: { type: "number" },
              property: { type: "object", additionalProperties: true },
            },
            required: ["field_name", "type"],
          },
          description:
            "\u5B57\u6BB5\u5217\u8868\uFF08create\uFF0C\u53EF\u9009\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "app_token"],
    },
  },
  {
    name: "lark_bitable_app",
    description:
      "\u98DE\u4E66\u591A\u7EF4\u8868\u683C App \u7BA1\u7406\u5DE5\u5177\u3002Actions: create\uFF08\u521B\u5EFA\u591A\u7EF4\u8868\u683C\u5E94\u7528\uFF09, get\uFF08\u83B7\u53D6\u5E94\u7528\u4FE1\u606F\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "get"],
          description: "Action",
        },
        app_token: {
          type: "string",
          description:
            "\u591A\u7EF4\u8868\u683C token\uFF08get \u5FC5\u586B\uFF09",
        },
        name: {
          type: "string",
          description:
            "\u591A\u7EF4\u8868\u683C\u540D\u79F0\uFF08create \u5FC5\u586B\uFF09",
        },
        folder_token: {
          type: "string",
          description:
            "\u6587\u4EF6\u5939 token\uFF08create\uFF0C\u53EF\u9009\uFF09",
        },
      },
      required: ["action"],
    },
  },
  // ── Search ──
  {
    name: "lark_search",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u6587\u6863\u641C\u7D22\u5DE5\u5177\u3002\u641C\u7D22\u4E91\u6587\u6863\u548C\u77E5\u8BC6\u5E93\u3002\u652F\u6301\u6309\u6587\u6863\u7C7B\u578B\u3001\u65F6\u95F4\u8303\u56F4\u3001\u7A7A\u95F4\u7B49\u6761\u4EF6\u8FC7\u6EE4\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search"],
          description: 'Action (only "search")',
        },
        query: {
          type: "string",
          description:
            "\u641C\u7D22\u5173\u952E\u8BCD\uFF08\u53EF\u9009\uFF0C\u4E0D\u4F20\u8868\u793A\u7A7A\u641C\uFF09",
        },
        filter: {
          type: "object",
          properties: {
            doc_types: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "DOC",
                  "SHEET",
                  "BITABLE",
                  "MINDNOTE",
                  "FILE",
                  "WIKI",
                  "DOCX",
                  "FOLDER",
                  "SLIDES",
                ],
              },
              description: "\u6587\u6863\u7C7B\u578B\u8FC7\u6EE4",
            },
            create_time: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: "string" },
              },
              description:
                "\u521B\u5EFA\u65F6\u95F4\u8303\u56F4\uFF08ISO 8601\uFF09",
            },
            update_time: {
              type: "object",
              properties: {
                start: { type: "string" },
                end: { type: "string" },
              },
              description:
                "\u66F4\u65B0\u65F6\u95F4\u8303\u56F4\uFF08ISO 8601\uFF09",
            },
          },
          description: "\u8FC7\u6EE4\u6761\u4EF6",
        },
        sort_type: {
          type: "string",
          enum: ["DEFAULT_TYPE", "EDIT_TIME", "CREATE_TIME"],
          description: "\u6392\u5E8F\u65B9\u5F0F",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Sheets ──
  {
    name: "lark_sheet",
    description:
      "\u98DE\u4E66\u7535\u5B50\u8868\u683C\u5DE5\u5177\u3002Actions: info\uFF08\u83B7\u53D6\u8868\u683C\u4FE1\u606F+\u5DE5\u4F5C\u8868\u5217\u8868\uFF09, read\uFF08\u8BFB\u53D6\u5DE5\u4F5C\u8868\u6570\u636E\uFF09, write\uFF08\u5199\u5165\u6570\u636E\uFF09, append\uFF08\u8FFD\u52A0\u884C\u6570\u636E\uFF09, find\uFF08\u67E5\u627E\u5185\u5BB9\uFF09, create\uFF08\u521B\u5EFA\u7535\u5B50\u8868\u683C\uFF09\u3002\u652F\u6301 URL \u6216 spreadsheet_token\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["info", "read", "write", "append", "find", "create"],
          description: "Action",
        },
        spreadsheet_token: {
          type: "string",
          description: "\u7535\u5B50\u8868\u683C token \u6216 URL",
        },
        sheet_id: { type: "string", description: "\u5DE5\u4F5C\u8868 ID" },
        range: {
          type: "string",
          description: "\u8303\u56F4\uFF08\u5982 A1:D10\uFF09",
        },
        values: {
          type: "array",
          items: { type: "array" },
          description:
            "\u5199\u5165/\u8FFD\u52A0\u7684\u6570\u636E\uFF08\u4E8C\u7EF4\u6570\u7EC4\uFF09",
        },
        find: {
          type: "string",
          description: "\u67E5\u627E\u5185\u5BB9\uFF08find action\uFF09",
        },
        title: {
          type: "string",
          description: "\u8868\u683C\u6807\u9898\uFF08create action\uFF09",
        },
        folder_token: {
          type: "string",
          description: "\u6587\u4EF6\u5939 token\uFF08create action\uFF09",
        },
        headers: {
          type: "array",
          items: { type: "string" },
          description: "\u8868\u5934\uFF08create action\uFF09",
        },
      },
      required: ["action"],
    },
  },
  // ── Wiki ──
  {
    name: "lark_wiki_node",
    description:
      "\u98DE\u4E66\u77E5\u8BC6\u5E93\u8282\u70B9\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u5217\u51FA\u5B50\u8282\u70B9\uFF09, get\uFF08\u83B7\u53D6\u8282\u70B9\u4FE1\u606F\uFF0C\u542B obj_type/obj_token\uFF09\u3002get \u7528\u4E8E\u89E3\u6790 wiki URL \u7684\u5B9E\u9645\u6587\u6863\u7C7B\u578B\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: "Action",
        },
        space_id: {
          type: "string",
          description: "\u7A7A\u95F4 ID\uFF08list \u5FC5\u586B\uFF09",
        },
        token: {
          type: "string",
          description: "\u8282\u70B9 token\uFF08get \u5FC5\u586B\uFF09",
        },
        parent_node_token: {
          type: "string",
          description:
            "\u7236\u8282\u70B9 token\uFF08list\uFF0C\u53EF\u9009\uFF09",
        },
        obj_type: {
          type: "string",
          enum: [
            "doc",
            "sheet",
            "mindnote",
            "bitable",
            "file",
            "docx",
            "slides",
            "wiki",
          ],
          description:
            "\u5BF9\u8C61\u7C7B\u578B\uFF08get\uFF0C\u53EF\u9009\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Common ──
  {
    name: "lark_get_user",
    description:
      "\u83B7\u53D6\u7528\u6237\u4FE1\u606F\u3002\u4E0D\u4F20 user_id \u65F6\u83B7\u53D6\u5F53\u524D\u7528\u6237\u81EA\u5DF1\u7684\u4FE1\u606F\uFF1B\u4F20 user_id \u65F6\u83B7\u53D6\u6307\u5B9A\u7528\u6237\u7684\u4FE1\u606F\u3002\u8FD4\u56DE\u7528\u6237\u59D3\u540D\u3001\u5934\u50CF\u3001\u90AE\u7BB1\u3001\u624B\u673A\u53F7\u3001\u90E8\u95E8\u7B49\u3002",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "string",
          description:
            "\u7528\u6237 ID\uFF08ou_xxx\uFF09\u3002\u4E0D\u4F20\u5219\u83B7\u53D6\u5F53\u524D\u7528\u6237\u4FE1\u606F\u3002",
        },
        user_id_type: {
          type: "string",
          enum: ["open_id", "union_id", "user_id"],
          description:
            "\u7528\u6237 ID \u7C7B\u578B\uFF08\u9ED8\u8BA4 open_id\uFF09",
        },
      },
    },
  },
  {
    name: "lark_search_user",
    description:
      "\u641C\u7D22/\u67E5\u627E\u7528\u6237\u3002\u901A\u8FC7\u90AE\u7BB1\u6216\u624B\u673A\u53F7\u67E5\u627E\u7528\u6237\u7684 open_id\u3002",
    inputSchema: {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "string" },
          description: "\u90AE\u7BB1\u5217\u8868",
        },
        mobiles: {
          type: "array",
          items: { type: "string" },
          description: "\u624B\u673A\u53F7\u5217\u8868",
        },
      },
    },
  },
  // ── IM Messages ──
  {
    name: "lark_im_message",
    description:
      "\u3010\u4EE5 Bot \u8EAB\u4EFD\u3011\u98DE\u4E66 IM \u6D88\u606F\u53D1\u9001/\u56DE\u590D\u5DE5\u5177\u3002Actions: send\uFF08\u53D1\u9001\u6D88\u606F\u5230\u79C1\u804A\u6216\u7FA4\u804A\uFF09, reply\uFF08\u56DE\u590D\u6307\u5B9A\u6D88\u606F\uFF09\u3002\u3010\u5B89\u5168\u8BF4\u660E\u3011\u6B64\u5DE5\u5177\u4EE5 Bot \u8EAB\u4EFD\u53D1\u9001\u6D88\u606F\uFF0C\u5BF9\u65B9\u770B\u5230\u7684\u53D1\u9001\u8005\u662F Bot\u3002\u8C03\u7528\u524D\u5FC5\u987B\u5148\u5411\u7528\u6237\u786E\u8BA4\uFF1A1) \u53D1\u9001\u5BF9\u8C61 2) \u6D88\u606F\u5185\u5BB9\u3002\u7981\u6B62\u5728\u7528\u6237\u672A\u660E\u786E\u540C\u610F\u7684\u60C5\u51B5\u4E0B\u81EA\u884C\u53D1\u9001\u6D88\u606F\u3002\u3010\u786E\u8BA4\u65B9\u5F0F\u3011\u5FC5\u987B\u901A\u8FC7\u53D1\u9001 interactive \u7C7B\u578B\u7684\u786E\u8BA4\u5361\u7247\u7ED9\u7528\u6237\uFF08\u800C\u975E\u7EAF\u6587\u672C\u786E\u8BA4\uFF09\uFF0C\u5361\u7247\u5E94\u5305\u542B\uFF1A\u53D1\u9001\u5BF9\u8C61\u3001\u6D88\u606F\u7C7B\u578B\u3001\u6D88\u606F\u5185\u5BB9\u9884\u89C8\u3001Bot \u8EAB\u4EFD\u63D0\u793A\uFF0C\u4EE5\u53CA\u300C\u2705 \u786E\u8BA4\u53D1\u9001\u300D\u548C\u300C\u274C \u53D6\u6D88\u300D\u6309\u94AE\uFF08\u6309\u94AE\u4EC5\u505A\u5C55\u793A\uFF0C\u7528\u6237\u56DE\u590D\u6587\u5B57\u786E\u8BA4\u5373\u53EF\uFF09\u3002\u7528\u6237\u660E\u786E\u786E\u8BA4\u540E\u518D\u8C03\u7528\u672C\u5DE5\u5177\u53D1\u9001\u3002content \u5FC5\u987B\u662F\u5408\u6CD5 JSON \u5B57\u7B26\u4E32\uFF0C\u683C\u5F0F\u53D6\u51B3\u4E8E msg_type\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send", "reply"],
          description: "Action",
        },
        receive_id_type: {
          type: "string",
          enum: ["open_id", "chat_id"],
          description:
            "\u63A5\u6536\u8005 ID \u7C7B\u578B\uFF08send \u5FC5\u586B\uFF09\uFF1Aopen_id\uFF08\u79C1\u804A\uFF09\u6216 chat_id\uFF08\u7FA4\u804A\uFF09",
        },
        receive_id: {
          type: "string",
          description:
            "\u63A5\u6536\u8005 ID\uFF08send \u5FC5\u586B\uFF09\uFF0C\u4E0E receive_id_type \u5BF9\u5E94",
        },
        message_id: {
          type: "string",
          description:
            "\u88AB\u56DE\u590D\u6D88\u606F\u7684 ID\uFF08reply \u5FC5\u586B\uFF0Com_xxx \u683C\u5F0F\uFF09",
        },
        msg_type: {
          type: "string",
          enum: [
            "text",
            "post",
            "image",
            "file",
            "interactive",
            "share_chat",
            "share_user",
          ],
          description: "\u6D88\u606F\u7C7B\u578B",
        },
        content: {
          type: "string",
          description: `\u6D88\u606F\u5185\u5BB9\uFF08JSON \u5B57\u7B26\u4E32\uFF09\u3002text \u2192 '{"text":"\u4F60\u597D"}', image \u2192 '{"image_key":"img_xxx"}', post \u2192 '{"zh_cn":{"title":"\u6807\u9898","content":[[{"tag":"text","text":"\u6B63\u6587"}]]}}'`,
        },
        reply_in_thread: {
          type: "boolean",
          description:
            "\u662F\u5426\u4EE5\u8BDD\u9898\u5F62\u5F0F\u56DE\u590D\uFF08reply action\uFF09",
        },
        uuid: {
          type: "string",
          description:
            "\u5E42\u7B49\u552F\u4E00\u6807\u8BC6\uFF0C1\u5C0F\u65F6\u5185\u540C uuid \u53EA\u53D1\u4E00\u6761",
        },
      },
      required: ["action", "msg_type", "content"],
    },
  },
  {
    name: "lark_im_upload_image",
    description:
      "\u3010\u4EE5 Bot \u8EAB\u4EFD\u3011\u4E0A\u4F20\u56FE\u7247\u5230\u98DE\u4E66\uFF0C\u83B7\u53D6 image_key\u3002\u7528\u4E8E\u53D1\u9001\u56FE\u7247\u6D88\u606F\u524D\u7684\u51C6\u5907\u6B65\u9AA4\uFF1A\u5148\u7528\u672C\u5DE5\u5177\u4E0A\u4F20\u56FE\u7247\u83B7\u53D6 image_key\uFF0C\u518D\u7528 lark_im_message \u53D1\u9001 msg_type=image \u7684\u6D88\u606F\u3002\u652F\u6301\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\u3002\u9650\u5236\uFF1A\u4E0D\u8D85\u8FC7 10MB\uFF0C\u652F\u6301 PNG/JPEG/GIF/BMP/TIFF/WEBP\u3002",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "\u672C\u5730\u56FE\u7247\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "lark_im_file",
    description:
      "\u3010\u4EE5 Bot \u8EAB\u4EFD\u3011\u98DE\u4E66 IM \u6587\u4EF6\u4E0A\u4F20/\u4E0B\u8F7D\u5DE5\u5177\u3002Actions: upload\uFF08\u4E0A\u4F20\u672C\u5730\u6587\u4EF6\u5230\u98DE\u4E66\u83B7\u53D6 file_key\uFF0C\u7528\u4E8E\u53D1\u9001\u6587\u4EF6\u6D88\u606F\uFF09, download\uFF08\u901A\u8FC7 file_key \u4E0B\u8F7D Bot \u4E0A\u4F20\u7684\u6587\u4EF6\u5230\u672C\u5730\uFF09\u3002\u652F\u6301\u6240\u6709\u6587\u4EF6\u683C\u5F0F\uFF1Aopus/mp4/pdf/doc/xls/ppt \u4EE5\u53CA\u5176\u4ED6\u4EFB\u610F\u683C\u5F0F\uFF08\u81EA\u52A8\u5F52\u4E3A stream \u7C7B\u578B\uFF09\u3002\u4E0A\u4F20\u9650\u5236 30MB\uFF0C\u4E0B\u8F7D\u9650\u5236 100MB\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["upload", "download"],
          description: "Action",
        },
        file_path: {
          type: "string",
          description:
            "\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\uFF08upload \u5FC5\u586B\uFF09",
        },
        file_key: {
          type: "string",
          description:
            "\u6587\u4EF6 Key\uFF08download \u5FC5\u586B\uFF0Cfile_xxx \u683C\u5F0F\uFF09",
        },
        output_path: {
          type: "string",
          description:
            "\u4E0B\u8F7D\u4FDD\u5B58\u8DEF\u5F84\uFF08download\uFF0C\u4E0D\u63D0\u4F9B\u5219\u81EA\u52A8\u4FDD\u5B58\u5230\u5DE5\u4F5C\u76EE\u5F55\uFF09",
        },
        duration: {
          type: "number",
          description:
            "\u97F3\u89C6\u9891\u65F6\u957F\uFF08\u6BEB\u79D2\uFF0Cupload \u53EF\u9009\uFF0C\u4EC5 opus/mp4\uFF09",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_im_get_messages",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u83B7\u53D6\u7FA4\u804A\u6216\u5355\u804A\u7684\u5386\u53F2\u6D88\u606F\u3002\u901A\u8FC7 chat_id \u83B7\u53D6\u7FA4\u804A/\u5355\u804A\u6D88\u606F\uFF0C\u6216\u901A\u8FC7 open_id \u83B7\u53D6\u4E0E\u6307\u5B9A\u7528\u6237\u7684\u5355\u804A\u6D88\u606F\u3002\u652F\u6301\u65F6\u95F4\u8303\u56F4\u8FC7\u6EE4\u548C\u5206\u9875\u3002",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "\u4F1A\u8BDD ID\uFF08oc_xxx\uFF09\uFF0C\u4E0E open_id \u4E92\u65A5",
        },
        open_id: {
          type: "string",
          description:
            "\u7528\u6237 open_id\uFF08ou_xxx\uFF09\uFF0C\u83B7\u53D6\u4E0E\u8BE5\u7528\u6237\u7684\u5355\u804A\u6D88\u606F\uFF0C\u4E0E chat_id \u4E92\u65A5",
        },
        start_time: {
          type: "string",
          description:
            "\u8D77\u59CB\u65F6\u95F4\uFF08ISO 8601 \u683C\u5F0F\uFF09",
        },
        end_time: {
          type: "string",
          description:
            "\u7ED3\u675F\u65F6\u95F4\uFF08ISO 8601 \u683C\u5F0F\uFF09",
        },
        sort_rule: {
          type: "string",
          enum: ["create_time_asc", "create_time_desc"],
          description:
            "\u6392\u5E8F\u65B9\u5F0F\uFF08\u9ED8\u8BA4 create_time_desc\uFF09",
        },
        page_size: {
          type: "number",
          description:
            "\u6BCF\u9875\u6D88\u606F\u6570\uFF081-50\uFF0C\u9ED8\u8BA4 50\uFF09",
        },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
    },
  },
  {
    name: "lark_im_search_messages",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u8DE8\u4F1A\u8BDD\u641C\u7D22\u98DE\u4E66\u6D88\u606F\u3002\u6309\u5173\u952E\u8BCD\u3001\u53D1\u9001\u8005\u3001\u88AB@\u7528\u6237\u3001\u6D88\u606F\u7C7B\u578B\u3001\u65F6\u95F4\u8303\u56F4\u7B49\u6761\u4EF6\u641C\u7D22\u3002\u6240\u6709\u53C2\u6570\u5747\u53EF\u9009\uFF0C\u4F46\u81F3\u5C11\u5E94\u63D0\u4F9B\u4E00\u4E2A\u8FC7\u6EE4\u6761\u4EF6\u3002",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "\u641C\u7D22\u5173\u952E\u8BCD",
        },
        sender_ids: {
          type: "array",
          items: { type: "string" },
          description: "\u53D1\u9001\u8005 open_id \u5217\u8868",
        },
        chat_id: {
          type: "string",
          description:
            "\u9650\u5B9A\u641C\u7D22\u8303\u56F4\u7684\u4F1A\u8BDD ID\uFF08oc_xxx\uFF09",
        },
        message_type: {
          type: "string",
          enum: ["file", "image", "media"],
          description: "\u6D88\u606F\u7C7B\u578B\u8FC7\u6EE4",
        },
        start_time: {
          type: "string",
          description: "\u8D77\u59CB\u65F6\u95F4\uFF08ISO 8601\uFF09",
        },
        end_time: {
          type: "string",
          description: "\u7ED3\u675F\u65F6\u95F4\uFF08ISO 8601\uFF09",
        },
        page_size: {
          type: "number",
          description: "\u6BCF\u9875\u6570\uFF081-50\uFF09",
        },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
    },
  },
  {
    name: "lark_im_fetch_resource",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u4E0B\u8F7D\u98DE\u4E66 IM \u6D88\u606F\u4E2D\u7684\u6587\u4EF6\u6216\u56FE\u7247\u8D44\u6E90\u5230\u672C\u5730\u3002\u4ECE\u6D88\u606F\u5217\u8868/\u641C\u7D22\u83B7\u53D6\u5230 message_id \u548C file_key \u540E\u4F7F\u7528\u3002\u6587\u4EF6\u4FDD\u5B58\u5230 /tmp\uFF0C\u8FD4\u56DE saved_path\u3002\u9650\u5236\uFF1A\u4E0D\u8D85\u8FC7 100MB\u3002",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "\u6D88\u606F ID\uFF08om_xxx \u683C\u5F0F\uFF09",
        },
        file_key: {
          type: "string",
          description:
            "\u8D44\u6E90 Key\u3002\u56FE\u7247\u7528 image_key\uFF08img_xxx\uFF09\uFF0C\u6587\u4EF6\u7528 file_key\uFF08file_xxx\uFF09",
        },
        type: {
          type: "string",
          enum: ["image", "file"],
          description:
            "\u8D44\u6E90\u7C7B\u578B\uFF1Aimage\uFF08\u56FE\u7247\u6D88\u606F\u4E2D\u7684\u56FE\u7247\uFF09\u6216 file\uFF08\u6587\u4EF6/\u97F3\u9891/\u89C6\u9891\uFF09",
        },
      },
      required: ["message_id", "file_key", "type"],
    },
  },
  // ── Chat ──
  {
    name: "lark_chat",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u7FA4\u804A\u7BA1\u7406\u5DE5\u5177\u3002Actions: search\uFF08\u641C\u7D22\u7FA4\u5217\u8868\uFF0C\u652F\u6301\u5173\u952E\u8BCD\u5339\u914D\u7FA4\u540D\u79F0\u3001\u7FA4\u6210\u5458\uFF09, get\uFF08\u83B7\u53D6\u6307\u5B9A\u7FA4\u7684\u8BE6\u7EC6\u4FE1\u606F\uFF0C\u5305\u62EC\u7FA4\u540D\u79F0\u3001\u63CF\u8FF0\u3001\u7FA4\u4E3B\u3001\u6743\u9650\u914D\u7F6E\u7B49\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "get"],
          description: "Action",
        },
        query: {
          type: "string",
          description:
            "\u641C\u7D22\u5173\u952E\u8BCD\uFF08search \u5FC5\u586B\uFF09",
        },
        chat_id: {
          type: "string",
          description:
            "\u7FA4 ID\uFF08get \u5FC5\u586B\uFF0Coc_xxx \u683C\u5F0F\uFF09",
        },
        page_size: {
          type: "number",
          description: "\u5206\u9875\u5927\u5C0F\uFF08\u9ED8\u8BA4 20\uFF09",
        },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_chat_members",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u83B7\u53D6\u6307\u5B9A\u7FA4\u7EC4\u7684\u6210\u5458\u5217\u8868\u3002\u8FD4\u56DE\u6210\u5458 ID\u3001\u59D3\u540D\u7B49\u3002\u6CE8\u610F\uFF1A\u4E0D\u8FD4\u56DE\u7FA4\u7EC4\u5185\u7684\u673A\u5668\u4EBA\u6210\u5458\u3002",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "\u7FA4 ID\uFF08oc_xxx \u683C\u5F0F\uFF09",
        },
        member_id_type: {
          type: "string",
          enum: ["open_id", "union_id", "user_id"],
          description:
            "\u6210\u5458 ID \u7C7B\u578B\uFF08\u9ED8\u8BA4 open_id\uFF09",
        },
        page_size: {
          type: "number",
          description: "\u5206\u9875\u5927\u5C0F\uFF08\u9ED8\u8BA4 20\uFF09",
        },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["chat_id"],
    },
  },
  // ── Drive ──
  {
    name: "lark_drive_file",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u4E91\u7A7A\u95F4\u6587\u4EF6\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u5217\u51FA\u6587\u4EF6\u5939\u6587\u4EF6\uFF09, get_meta\uFF08\u6279\u91CF\u83B7\u53D6\u5143\u6570\u636E\uFF09, copy\uFF08\u590D\u5236\uFF09, move\uFF08\u79FB\u52A8\uFF09, delete\uFF08\u5220\u9664\uFF09, upload\uFF08\u4E0A\u4F20\u672C\u5730\u6587\u4EF6\u5230\u4E91\u7A7A\u95F4\uFF0C\u226415MB \u4E00\u6B21\u4E0A\u4F20\uFF0C>15MB \u5206\u7247\u4E0A\u4F20\uFF09, download\uFF08\u4E0B\u8F7D\u6587\u4EF6\u5230\u672C\u5730\u6216\u8FD4\u56DE base64\uFF09\u3002\u6D88\u606F\u4E2D\u7684\u6587\u4EF6\u8BFB\u5199\u7981\u6B62\u4F7F\u7528\u6B64\u5DE5\u5177\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "get_meta",
            "copy",
            "move",
            "delete",
            "upload",
            "download",
          ],
          description: "Action",
        },
        folder_token: {
          type: "string",
          description:
            "\u6587\u4EF6\u5939 token\uFF08list/copy \u76EE\u6807/create\uFF09",
        },
        file_token: {
          type: "string",
          description:
            "\u6587\u4EF6 token\uFF08get_meta/copy/move/delete/download \u5FC5\u586B\uFF09",
        },
        type: {
          type: "string",
          enum: [
            "doc",
            "sheet",
            "file",
            "bitable",
            "docx",
            "folder",
            "mindnote",
            "slides",
          ],
          description:
            "\u6587\u6863\u7C7B\u578B\uFF08copy/move/delete \u5FC5\u586B\uFF09",
        },
        name: {
          type: "string",
          description:
            "\u76EE\u6807\u6587\u4EF6\u540D\uFF08copy \u5FC5\u586B\uFF09",
        },
        request_docs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              doc_token: { type: "string" },
              doc_type: { type: "string" },
            },
            required: ["doc_token", "doc_type"],
          },
          description:
            "\u6279\u91CF\u67E5\u8BE2\u6587\u6863\u5217\u8868\uFF08get_meta\uFF0C\u226450 \u4E2A\uFF09",
        },
        file_path: {
          type: "string",
          description:
            "\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\uFF08upload \u4F18\u5148\u4F7F\u7528\uFF09",
        },
        file_name: {
          type: "string",
          description:
            "\u6587\u4EF6\u540D\uFF08upload\uFF0Cfile_path \u81EA\u52A8\u63D0\u53D6\uFF09",
        },
        output_path: {
          type: "string",
          description:
            "\u4E0B\u8F7D\u4FDD\u5B58\u8DEF\u5F84\uFF08download\uFF0C\u4E0D\u63D0\u4F9B\u5219\u8FD4\u56DE base64\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_doc_media",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u6587\u6863\u5A92\u4F53\u7BA1\u7406\u5DE5\u5177\u3002Actions: insert\uFF08\u5728\u98DE\u4E66\u6587\u6863\u672B\u5C3E\u63D2\u5165\u672C\u5730\u56FE\u7247\u6216\u6587\u4EF6\uFF0C3\u6B65\u6D41\u7A0B\uFF1A\u521B\u5EFABlock\u2192\u4E0A\u4F20\u7D20\u6750\u2192\u66F4\u65B0Block\uFF09, download\uFF08\u4E0B\u8F7D\u6587\u6863\u7D20\u6750\u6216\u753B\u677F\u7F29\u7565\u56FE\u5230\u672C\u5730\uFF09\u3002insert \u4EC5\u652F\u6301\u672C\u5730\u6587\u4EF6\u8DEF\u5F84\uFF0C\u6700\u5927 20MB\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["insert", "download"],
          description: "Action",
        },
        doc_id: {
          type: "string",
          description:
            "\u6587\u6863 ID \u6216 URL\uFF08insert \u5FC5\u586B\uFF09",
        },
        file_path: {
          type: "string",
          description:
            "\u672C\u5730\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF08insert \u5FC5\u586B\uFF09",
        },
        type: {
          type: "string",
          enum: ["image", "file"],
          description:
            "\u5A92\u4F53\u7C7B\u578B\uFF08insert\uFF0C\u9ED8\u8BA4 image\uFF09",
        },
        align: {
          type: "string",
          enum: ["left", "center", "right"],
          description:
            "\u5BF9\u9F50\u65B9\u5F0F\uFF08insert\uFF0C\u4EC5\u56FE\u7247\uFF0C\u9ED8\u8BA4 center\uFF09",
        },
        caption: {
          type: "string",
          description:
            "\u56FE\u7247\u63CF\u8FF0\uFF08insert\uFF0C\u4EC5\u56FE\u7247\uFF09",
        },
        resource_token: {
          type: "string",
          description:
            "\u8D44\u6E90\u6807\u8BC6\uFF08download \u5FC5\u586B\uFF09",
        },
        resource_type: {
          type: "string",
          enum: ["media", "whiteboard"],
          description:
            "\u8D44\u6E90\u7C7B\u578B\uFF08download \u5FC5\u586B\uFF09",
        },
        output_path: {
          type: "string",
          description:
            "\u4FDD\u5B58\u8DEF\u5F84\uFF08download \u5FC5\u586B\uFF09",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_doc_comments",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u7BA1\u7406\u4E91\u6587\u6863\u8BC4\u8BBA\u3002Actions: list\uFF08\u83B7\u53D6\u8BC4\u8BBA\u5217\u8868\u542B\u5B8C\u6574\u56DE\u590D\uFF09, create\uFF08\u6DFB\u52A0\u5168\u6587\u8BC4\u8BBA\uFF0C\u652F\u6301\u6587\u672C\u3001@\u7528\u6237\u3001\u8D85\u94FE\u63A5\uFF09, patch\uFF08\u89E3\u51B3/\u6062\u590D\u8BC4\u8BBA\uFF09\u3002\u652F\u6301 wiki token \u81EA\u52A8\u8F6C\u6362\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "patch"],
          description: "Action",
        },
        file_token: {
          type: "string",
          description:
            "\u4E91\u6587\u6863 token \u6216 wiki \u8282\u70B9 token",
        },
        file_type: {
          type: "string",
          enum: ["doc", "docx", "sheet", "file", "slides", "wiki"],
          description: "\u6587\u6863\u7C7B\u578B",
        },
        is_whole: {
          type: "boolean",
          description:
            "\u662F\u5426\u53EA\u83B7\u53D6\u5168\u6587\u8BC4\u8BBA\uFF08list\uFF09",
        },
        is_solved: {
          type: "boolean",
          description:
            "\u662F\u5426\u53EA\u83B7\u53D6\u5DF2\u89E3\u51B3\u8BC4\u8BBA\uFF08list\uFF09",
        },
        elements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text", "mention", "link"] },
              text: { type: "string" },
              open_id: { type: "string" },
              url: { type: "string" },
            },
            required: ["type"],
          },
          description:
            "\u8BC4\u8BBA\u5185\u5BB9\u5143\u7D20\uFF08create \u5FC5\u586B\uFF09",
        },
        comment_id: {
          type: "string",
          description: "\u8BC4\u8BBA ID\uFF08patch \u5FC5\u586B\uFF09",
        },
        is_solved_value: {
          type: "boolean",
          description:
            "\u89E3\u51B3\u72B6\u6001\uFF1Atrue=\u89E3\u51B3 false=\u6062\u590D\uFF08patch \u5FC5\u586B\uFF09",
        },
        page_size: { type: "number", description: "\u5206\u9875\u5927\u5C0F" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "file_token", "file_type"],
    },
  },
  // ── Calendar Attendee ──
  {
    name: "lark_calendar_attendee",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u65E5\u7A0B\u53C2\u4F1A\u4EBA\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u67E5\u770B\u53C2\u4F1A\u4EBA\u5217\u8868\uFF09, add\uFF08\u6DFB\u52A0\u53C2\u4F1A\u4EBA\uFF09, remove\uFF08\u79FB\u9664\u53C2\u4F1A\u4EBA\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove"],
          description: "Action",
        },
        calendar_id: {
          type: "string",
          description: "\u65E5\u5386 ID\uFF08\u9ED8\u8BA4 primary\uFF09",
        },
        event_id: {
          type: "string",
          description: "\u65E5\u7A0B ID\uFF08\u5FC5\u586B\uFF09",
        },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["user", "chat", "resource", "third_party"],
              },
              id: { type: "string" },
            },
            required: ["type", "id"],
          },
          description:
            "\u53C2\u4F1A\u4EBA\u5217\u8868\uFF08add/remove \u5FC5\u586B\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "event_id"],
    },
  },
  // ── Task extensions ──
  {
    name: "lark_task_comment",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u4EFB\u52A1\u8BC4\u8BBA\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u4EFB\u52A1\u8BC4\u8BBA\u5217\u8868\uFF09, create\uFF08\u6DFB\u52A0\u8BC4\u8BBA\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Action",
        },
        task_guid: {
          type: "string",
          description: "\u4EFB\u52A1 GUID\uFF08\u5FC5\u586B\uFF09",
        },
        content: {
          type: "string",
          description:
            "\u8BC4\u8BBA\u5185\u5BB9\uFF08create \u5FC5\u586B\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "task_guid"],
    },
  },
  {
    name: "lark_task_subtask",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u4EFB\u52A1\u5B50\u4EFB\u52A1\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u5B50\u4EFB\u52A1\u5217\u8868\uFF09, create\uFF08\u521B\u5EFA\u5B50\u4EFB\u52A1\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Action",
        },
        task_guid: {
          type: "string",
          description: "\u7236\u4EFB\u52A1 GUID\uFF08\u5FC5\u586B\uFF09",
        },
        summary: {
          type: "string",
          description:
            "\u5B50\u4EFB\u52A1\u6807\u9898\uFF08create \u5FC5\u586B\uFF09",
        },
        description: {
          type: "string",
          description: "\u5B50\u4EFB\u52A1\u63CF\u8FF0\uFF08create\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "task_guid"],
    },
  },
  // ── Bitable View ──
  {
    name: "lark_bitable_view",
    description:
      "\u98DE\u4E66\u591A\u7EF4\u8868\u683C\u89C6\u56FE\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u89C6\u56FE\u5217\u8868\uFF09, create\uFF08\u521B\u5EFA\u89C6\u56FE\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Action",
        },
        app_token: {
          type: "string",
          description: "\u591A\u7EF4\u8868\u683C token",
        },
        table_id: { type: "string", description: "\u6570\u636E\u8868 ID" },
        view_name: {
          type: "string",
          description:
            "\u89C6\u56FE\u540D\u79F0\uFF08create \u5FC5\u586B\uFF09",
        },
        view_type: {
          type: "string",
          enum: ["grid", "kanban", "calendar", "gallery", "gantt", "form"],
          description:
            "\u89C6\u56FE\u7C7B\u578B\uFF08create \u5FC5\u586B\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action", "app_token", "table_id"],
    },
  },
  // ── Wiki Space ──
  {
    name: "lark_wiki_space",
    description:
      "\u98DE\u4E66\u77E5\u8BC6\u7A7A\u95F4\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u77E5\u8BC6\u7A7A\u95F4\u5217\u8868\uFF09, get\uFF08\u83B7\u53D6\u77E5\u8BC6\u7A7A\u95F4\u8BE6\u60C5\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: "Action",
        },
        space_id: {
          type: "string",
          description: "\u7A7A\u95F4 ID\uFF08get \u5FC5\u586B\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Sheet Export ──
  {
    name: "lark_sheet_export",
    description:
      "\u98DE\u4E66\u7535\u5B50\u8868\u683C\u5BFC\u51FA\u5DE5\u5177\u3002\u5C06\u7535\u5B50\u8868\u683C\u5BFC\u51FA\u4E3A xlsx/csv \u6587\u4EF6\u5E76\u4E0B\u8F7D\u5230\u672C\u5730\u3002\u5F02\u6B65\u64CD\u4F5C\uFF1A\u5148\u521B\u5EFA\u5BFC\u51FA\u4EFB\u52A1\uFF0C\u518D\u8F6E\u8BE2\u72B6\u6001\uFF0C\u6700\u540E\u4E0B\u8F7D\u6587\u4EF6\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "query", "download"],
          description:
            "Action: create\uFF08\u521B\u5EFA\u5BFC\u51FA\u4EFB\u52A1\uFF09, query\uFF08\u67E5\u8BE2\u4EFB\u52A1\u72B6\u6001\uFF09, download\uFF08\u4E0B\u8F7D\u5BFC\u51FA\u6587\u4EF6\uFF09",
        },
        spreadsheet_token: {
          type: "string",
          description:
            "\u7535\u5B50\u8868\u683C token\uFF08create/query \u5FC5\u586B\uFF09",
        },
        file_extension: {
          type: "string",
          enum: ["xlsx", "csv"],
          description:
            "\u5BFC\u51FA\u683C\u5F0F\uFF08create\uFF0C\u9ED8\u8BA4 xlsx\uFF09",
        },
        ticket: {
          type: "string",
          description:
            "\u5BFC\u51FA\u4EFB\u52A1 ticket\uFF08query \u5FC5\u586B\uFF09",
        },
        file_token: {
          type: "string",
          description:
            "\u5BFC\u51FA\u6587\u4EF6 token\uFF08download \u5FC5\u586B\uFF0C\u4ECE query \u8FD4\u56DE\u83B7\u53D6\uFF09",
        },
        output_path: {
          type: "string",
          description:
            "\u672C\u5730\u4FDD\u5B58\u8DEF\u5F84\uFF08download\uFF0C\u4E0D\u63D0\u4F9B\u8FD4\u56DE base64\uFF09",
        },
      },
      required: ["action"],
    },
  },
  // ── Mail ──
  {
    name: "lark_mail",
    description:
      "\u3010\u4EE5\u7528\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u90AE\u4EF6\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u90AE\u4EF6\u5217\u8868\uFF09, get\uFF08\u83B7\u53D6\u90AE\u4EF6\u8BE6\u60C5\uFF0C\u542B\u6B63\u6587\u548C\u9644\u4EF6\u4FE1\u606F\uFF09, send\uFF08\u53D1\u9001\u90AE\u4EF6\uFF0C\u652F\u6301 HTML \u6B63\u6587\u548C\u9644\u4EF6\uFF09\u3002\u53D1\u9001\u90AE\u4EF6\u524D\u5FC5\u987B\u5411\u7528\u6237\u786E\u8BA4\u6536\u4EF6\u4EBA\u548C\u90AE\u4EF6\u5185\u5BB9\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "send"],
          description: "Action",
        },
        mailbox_id: {
          type: "string",
          description:
            "\u90AE\u7BB1 ID\uFF08\u901A\u5E38\u4E3A me\uFF0C\u8868\u793A\u5F53\u524D\u7528\u6237\u90AE\u7BB1\uFF09",
        },
        message_id: {
          type: "string",
          description: "\u90AE\u4EF6 ID\uFF08get \u5FC5\u586B\uFF09",
        },
        subject: {
          type: "string",
          description: "\u90AE\u4EF6\u4E3B\u9898\uFF08send \u5FC5\u586B\uFF09",
        },
        to: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mail_address: { type: "string" },
              name: { type: "string" },
            },
            required: ["mail_address"],
          },
          description:
            "\u6536\u4EF6\u4EBA\u5217\u8868\uFF08send \u5FC5\u586B\uFF09",
        },
        cc: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mail_address: { type: "string" },
              name: { type: "string" },
            },
            required: ["mail_address"],
          },
          description:
            "\u6284\u9001\u4EBA\u5217\u8868\uFF08send\uFF0C\u53EF\u9009\uFF09",
        },
        body_html: {
          type: "string",
          description:
            "\u90AE\u4EF6\u6B63\u6587 HTML\uFF08send \u5FC5\u586B\uFF09",
        },
        body_plain_text: {
          type: "string",
          description:
            "\u90AE\u4EF6\u7EAF\u6587\u672C\u6B63\u6587\uFF08send\uFF0C\u53EF\u9009\u964D\u7EA7\uFF09",
        },
        _user_confirmed: {
          type: "boolean",
          description:
            "\u7528\u6237\u5DF2\u901A\u8FC7 AskUserQuestion \u786E\u8BA4\u64CD\u4F5C\uFF08send \u5FC5\u987B\u5148\u786E\u8BA4\uFF09",
        },
        page_size: {
          type: "number",
          description: "\u6BCF\u9875\u6570\u91CF\uFF08list\uFF09",
        },
        page_token: {
          type: "string",
          description: "\u5206\u9875\u6807\u8BB0\uFF08list\uFF09",
        },
      },
      required: ["action"],
    },
  },
  // ── Approval ──
  {
    name: "lark_approval",
    description:
      "\u3010\u4EE5 Bot/\u79DF\u6237\u8EAB\u4EFD\u3011\u98DE\u4E66\u5BA1\u6279\u7BA1\u7406\u5DE5\u5177\u3002Actions: get_definition\uFF08\u83B7\u53D6\u5BA1\u6279\u5B9A\u4E49/\u8868\u5355\u7ED3\u6784\uFF09, list_instances\uFF08\u67E5\u8BE2\u5BA1\u6279\u5B9E\u4F8B\u5217\u8868\uFF09, get_instance\uFF08\u83B7\u53D6\u5BA1\u6279\u5B9E\u4F8B\u8BE6\u60C5\uFF0C\u542B\u5BA1\u6279\u5386\u53F2\u548C\u8868\u5355\u503C\uFF09, create\uFF08\u53D1\u8D77\u5BA1\u6279\u5B9E\u4F8B\uFF09\u3002\u6240\u6709\u64CD\u4F5C\u5747\u4F7F\u7528\u79DF\u6237\u8EAB\u4EFD\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_definition", "list_instances", "get_instance", "create"],
          description: "Action",
        },
        approval_code: {
          type: "string",
          description:
            "\u5BA1\u6279\u5B9A\u4E49 code\uFF08get_definition/list_instances/create \u5FC5\u586B\uFF09",
        },
        instance_id: {
          type: "string",
          description:
            "\u5BA1\u6279\u5B9E\u4F8B ID\uFF08get_instance \u5FC5\u586B\uFF09",
        },
        start_time: {
          type: "string",
          description:
            "\u8D77\u59CB\u65F6\u95F4\uFF08list_instances\uFF0CUnix \u6BEB\u79D2\u65F6\u95F4\u6233\uFF09",
        },
        end_time: {
          type: "string",
          description:
            "\u7ED3\u675F\u65F6\u95F4\uFF08list_instances\uFF0CUnix \u6BEB\u79D2\u65F6\u95F4\u6233\uFF09",
        },
        open_id: {
          type: "string",
          description:
            "\u53D1\u8D77\u4EBA open_id\uFF08create \u5FC5\u586B\uFF09",
        },
        form: {
          type: "string",
          description:
            "\u8868\u5355\u5185\u5BB9 JSON \u5B57\u7B26\u4E32\uFF08create \u5FC5\u586B\uFF09\uFF0C\u683C\u5F0F\u53C2\u89C1\u5BA1\u6279\u5B9A\u4E49\u7684 form \u5B57\u6BB5",
        },
        node_approver_open_id_list: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "array", items: { type: "string" } },
            },
            required: ["key", "value"],
          },
          description:
            "\u5BA1\u6279\u8282\u70B9\u5BA1\u6279\u4EBA\uFF08create\uFF0C\u53EF\u9009\uFF09",
        },
        _user_confirmed: {
          type: "boolean",
          description:
            "\u7528\u6237\u5DF2\u901A\u8FC7 AskUserQuestion \u786E\u8BA4\u64CD\u4F5C\uFF08create \u5FC5\u987B\u5148\u786E\u8BA4\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Contact Department ──
  {
    name: "lark_contact_department",
    description:
      '\u98DE\u4E66\u7EC4\u7EC7\u67B6\u6784\u90E8\u95E8\u7BA1\u7406\u5DE5\u5177\u3002Actions: list\uFF08\u83B7\u53D6\u5B50\u90E8\u95E8\u5217\u8868\uFF09, get_users\uFF08\u83B7\u53D6\u90E8\u95E8\u76F4\u5C5E\u6210\u5458\u5217\u8868\uFF09\u3002\u9ED8\u8BA4\u4F7F\u7528\u79DF\u6237\u8EAB\u4EFD\uFF08\u5168\u5C40\u89C6\u89D2\uFF09\uFF0C\u53EF\u964D\u7EA7\u4E3A\u7528\u6237\u8EAB\u4EFD\u3002\u6839\u90E8\u95E8 ID \u4E3A "0"\u3002',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get_users"],
          description: "Action",
        },
        department_id: {
          type: "string",
          description:
            '\u90E8\u95E8 ID\uFF08\u9ED8\u8BA4 "0" \u8868\u793A\u6839\u90E8\u95E8\uFF09',
        },
        department_id_type: {
          type: "string",
          enum: ["department_id", "open_department_id"],
          description:
            "\u90E8\u95E8 ID \u7C7B\u578B\uFF08\u9ED8\u8BA4 open_department_id\uFF09",
        },
        fetch_child: {
          type: "boolean",
          description:
            "\u662F\u5426\u9012\u5F52\u83B7\u53D6\u5B50\u90E8\u95E8\uFF08list\uFF0C\u9ED8\u8BA4 false\uFF09",
        },
        page_size: { type: "number", description: "\u6BCF\u9875\u6570\u91CF" },
        page_token: { type: "string", description: "\u5206\u9875\u6807\u8BB0" },
      },
      required: ["action"],
    },
  },
  // ── Speech Recognition (ASR) ──
  {
    name: "lark_speech_recognize",
    description:
      "\u98DE\u4E66\u8BED\u97F3\u8BC6\u522B (ASR) \u5DE5\u5177\u3002\u5C06\u8BED\u97F3\u6587\u4EF6\u8F6C\u4E3A\u6587\u5B57\u3002\u652F\u6301\u4E24\u79CD\u8F93\u5165\u65B9\u5F0F\uFF1A(1) message_id + file_key \u4ECE\u6D88\u606F\u4E0B\u8F7D\u8BED\u97F3\u6587\u4EF6\uFF1B(2) file_path \u4ECE\u672C\u5730\u6587\u4EF6\u8BFB\u53D6\u3002\u9650\u5236\uFF1A60 \u79D2\u4EE5\u5185\u97F3\u9891\u3002\u9700\u8981 ffmpeg \u5DF2\u5B89\u88C5\u3002",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description:
            "\u6D88\u606F ID\uFF08om_xxx\uFF09\uFF0C\u4E0E file_key \u914D\u5408\u4F7F\u7528",
        },
        file_key: {
          type: "string",
          description:
            "\u8BED\u97F3\u6587\u4EF6 key\uFF08file_xxx\uFF09\uFF0C\u4E0E message_id \u914D\u5408\u4F7F\u7528",
        },
        file_path: {
          type: "string",
          description:
            "\u672C\u5730\u8BED\u97F3\u6587\u4EF6\u8DEF\u5F84\uFF08\u66FF\u4EE3 message_id + file_key\uFF09",
        },
      },
    },
  },
];
const MCP_DOC_TOOLS = [
  {
    name: "lark_fetch_doc",
    description:
      "\u83B7\u53D6\u98DE\u4E66\u4E91\u6587\u6863\u5185\u5BB9\u3002\u8FD4\u56DE Markdown \u683C\u5F0F\u7684\u6587\u6863\u5185\u5BB9\u3002doc_id \u652F\u6301\u76F4\u63A5\u4F20 URL \u6216 token\u3002\u77E5\u8BC6\u5E93 URL\uFF08/wiki/TOKEN\uFF09\u9700\u5148\u7528 lark_wiki_node.get \u89E3\u6790\u5B9E\u9645\u6587\u6863\u7C7B\u578B\u3002",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "\u6587\u6863 ID \u6216 URL\uFF08\u5FC5\u586B\uFF09",
        },
        offset: {
          type: "number",
          description: "\u5B57\u7B26\u504F\u79FB\u91CF\uFF08\u53EF\u9009\uFF09",
        },
        limit: {
          type: "number",
          description:
            "\u8FD4\u56DE\u7684\u6700\u5927\u5B57\u7B26\u6570\uFF08\u53EF\u9009\uFF09",
        },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "lark_create_doc",
    description:
      "\u521B\u5EFA\u98DE\u4E66\u4E91\u6587\u6863\u3002\u4ECE Lark-flavored Markdown \u5185\u5BB9\u521B\u5EFA\u65B0\u6587\u6863\u3002\u652F\u6301\u6307\u5B9A\u6587\u4EF6\u5939(folder_token)\u3001\u77E5\u8BC6\u5E93\u8282\u70B9(wiki_node)\u6216\u77E5\u8BC6\u7A7A\u95F4(wiki_space)\u3002",
    inputSchema: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description:
            "\u6587\u6863 Markdown \u5185\u5BB9\uFF08Lark-flavored\u683C\u5F0F\uFF0C\u5FC5\u586B\uFF09",
        },
        title: {
          type: "string",
          description: "\u6587\u6863\u6807\u9898\uFF08\u53EF\u9009\uFF09",
        },
        folder_token: {
          type: "string",
          description: "\u7236\u6587\u4EF6\u5939 token\uFF08\u53EF\u9009\uFF09",
        },
        wiki_node: {
          type: "string",
          description:
            "\u77E5\u8BC6\u5E93\u8282\u70B9 token\uFF08\u53EF\u9009\uFF0C\u4E0E folder_token/wiki_space \u4E92\u65A5\uFF09",
        },
        wiki_space: {
          type: "string",
          description:
            "\u77E5\u8BC6\u7A7A\u95F4 ID\uFF08\u53EF\u9009\uFF0C\u7279\u6B8A\u503C my_library \u8868\u793A\u4E2A\u4EBA\u77E5\u8BC6\u5E93\uFF09",
        },
      },
      required: ["markdown"],
    },
  },
  {
    name: "lark_update_doc",
    description:
      "\u66F4\u65B0\u98DE\u4E66\u4E91\u6587\u6863\u3002\u652F\u6301 7 \u79CD\u6A21\u5F0F\uFF1Aappend\uFF08\u8FFD\u52A0\u5230\u672B\u5C3E\uFF09, overwrite\uFF08\u5168\u6587\u8986\u76D6\uFF09, replace_range\uFF08\u5B9A\u4F4D\u66FF\u6362\uFF09, replace_all\uFF08\u5168\u6587\u66FF\u6362\uFF09, insert_before\uFF08\u524D\u63D2\u5165\uFF09, insert_after\uFF08\u540E\u63D2\u5165\uFF09, delete_range\uFF08\u5220\u9664\u5185\u5BB9\uFF09\u3002\u5B9A\u4F4D\u65B9\u5F0F\u652F\u6301 selection_with_ellipsis\uFF08\u5185\u5BB9\u5B9A\u4F4D\uFF09\u548C selection_by_title\uFF08\u6807\u9898\u5B9A\u4F4D\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "\u6587\u6863 ID \u6216 URL\uFF08\u5FC5\u586B\uFF09",
        },
        mode: {
          type: "string",
          enum: [
            "append",
            "overwrite",
            "replace_range",
            "replace_all",
            "insert_before",
            "insert_after",
            "delete_range",
          ],
          description: "\u66F4\u65B0\u6A21\u5F0F\uFF08\u5FC5\u586B\uFF09",
        },
        markdown: {
          type: "string",
          description: "\u65B0\u5185\u5BB9\uFF08Markdown\uFF09",
        },
        selection_with_ellipsis: {
          type: "string",
          description:
            '\u5185\u5BB9\u5B9A\u4F4D\uFF08\u5982 "\u5F00\u5934\u5185\u5BB9...\u7ED3\u5C3E\u5185\u5BB9"\uFF09',
        },
        selection_by_title: {
          type: "string",
          description:
            '\u6807\u9898\u5B9A\u4F4D\uFF08\u5982 "## \u7AE0\u8282\u6807\u9898"\uFF09',
        },
        new_title: {
          type: "string",
          description: "\u65B0\u6587\u6863\u6807\u9898\uFF08\u53EF\u9009\uFF09",
        },
        task_id: {
          type: "string",
          description:
            "\u5F02\u6B65\u4EFB\u52A1 ID\uFF08\u67E5\u8BE2\u5F02\u6B65\u4EFB\u52A1\u72B6\u6001\uFF09",
        },
      },
      required: ["doc_id", "mode"],
    },
  },
];
const TOOL_TOKEN_MODES = {
  // -- IM tools: send/reply MUST be tenant (bot identity) --
  lark_im_message: {
    send: "tenant",
    // Bot sends messages, never impersonate user
    reply: "tenant",
    // Bot replies, never impersonate user
    _default: "tenant",
  },
  lark_im_get_messages: "user",
  // Reading message history requires user permission
  lark_im_search_messages: "user",
  // Searching messages requires user permission
  lark_im_upload_image: "tenant",
  // Bot uploads images for sending
  lark_im_file: "tenant",
  // Bot uploads/downloads files
  lark_im_fetch_resource: "auto",
  // Bot-received resources use TAT, user message resources use UAT
  // -- Calendar: all UAT --
  lark_calendar_event: "user",
  lark_calendar_freebusy: "user",
  lark_calendar_attendee: "user",
  // -- Task: all UAT --
  lark_task: "user",
  lark_tasklist: "user",
  lark_task_comment: "user",
  lark_task_subtask: "user",
  // -- Bitable: all UAT --
  lark_bitable_record: "user",
  lark_bitable_field: "user",
  lark_bitable_table: "user",
  lark_bitable_app: "user",
  lark_bitable_view: "user",
  // -- Search/Docs: all UAT --
  lark_search: "user",
  lark_drive_file: "user",
  lark_doc_media: "user",
  lark_doc_comments: "user",
  // -- Wiki/Sheet: all UAT --
  lark_wiki_node: "user",
  lark_wiki_space: "user",
  lark_sheet: "user",
  lark_sheet_export: "user",
  // -- Chat: read with user --
  lark_chat: "user",
  lark_chat_members: "user",
  // -- Mail --
  lark_mail: {
    list: "user",
    get: "user",
    send: "user",
    _default: "user",
  },
  // -- Approval --
  lark_approval: "tenant",
  // Approval APIs use tenant token (admin-level access)
  // -- Contact Department --
  lark_contact_department: "auto",
  // Tenant preferred (global view), user fallback
  // -- Speech Recognition --
  lark_speech_recognize: "tenant",
  // ASR API uses tenant token
  // -- Common --
  lark_get_user: "auto",
  lark_search_user: "user",
  // -- MCP Doc relay: always UAT (MCP endpoint needs user identity) --
  lark_fetch_doc: "user",
  lark_create_doc: "user",
  lark_update_doc: "user",
  // -- Generic lark_api: path-based auto detection --
  lark_api: "auto",
};
const ALL_TOOLS = [...OAPI_TOOLS, ...MCP_DOC_TOOLS];
const OAPI_TOOL_NAMES = new Set(OAPI_TOOLS.map((t2) => t2.name));
const MCP_DOC_TOOL_NAMES = new Set(MCP_DOC_TOOLS.map((t2) => t2.name));

export { ALL_TOOLS, OAPI_TOOL_NAMES, MCP_DOC_TOOL_NAMES, resolveTokenMode };
