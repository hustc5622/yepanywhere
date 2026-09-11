// Yep-owned SDK tool handlers. Authorization is supplied by the caller, never read from disk.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const fileContext = new AsyncLocalStorage();
export function executeTool(sdk, name, args, opts, context) {
  return fileContext.run(context, () => executeOapiTool(sdk, name, args, opts));
}
async function convertAudioToPcm(input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let size = 0;
    let errorText = "";
    const timer = setTimeout(() => child.kill(), 30000);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 40 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 2000) errorText += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Audio conversion failed: ${errorText}`));
      else resolveResult(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
function assertAllowedFilePath(filePath) {
  const resolved = resolve(filePath);
  let ancestor = resolved;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Invalid file path");
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  const realPath = join(realpathSync(ancestor), ...suffix);
  const roots = fileContext.getStore()?.roots ?? [];
  if (
    !roots.some((root) => realPath === root || realPath.startsWith(`${root}/`))
  ) {
    throw new Error("File path is outside the configured workspace roots.");
  }
  return realPath;
}
function parseTimeToTimestamp(input) {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);
    if (hasTimezone) {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1e3).toString();
    }
    const normalized = trimmed.replace("T", " ");
    const match = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1e3).toString();
    }
    const [, year, month, day, hour, minute, second] = match;
    const utcDate = new Date(
      Date.UTC(
        Number.parseInt(year),
        Number.parseInt(month) - 1,
        Number.parseInt(day),
        Number.parseInt(hour) - TZ_OFFSET_HOURS,
        Number.parseInt(minute),
        Number.parseInt(second ?? "0"),
      ),
    );
    return Math.floor(utcDate.getTime() / 1e3).toString();
  } catch {
    return null;
  }
}
function parseTimeToTimestampMs(input) {
  const ts2 = parseTimeToTimestamp(input);
  if (!ts2) return null;
  return (Number.parseInt(ts2, 10) * 1e3).toString();
}
function parseTimeToRFC3339(input) {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);
    if (hasTimezone) {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return null;
      return trimmed;
    }
    const normalized = trimmed.replace("T", " ");
    const match = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) {
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return null;
      return trimmed.includes("T") ? `${trimmed}${TZ_OFFSET_STRING}` : trimmed;
    }
    const [, year, month, day, hour, minute, second] = match;
    const sec = second ?? "00";
    return `${year}-${month}-${day}T${hour}:${minute}:${sec}${TZ_OFFSET_STRING}`;
  } catch {
    return null;
  }
}
function validatePathParam(value, name) {
  const s = String(value ?? "");
  if (!s || !/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(
      `Invalid ${name}: "${s}". Expected alphanumeric characters, underscores, or hyphens.`,
    );
  }
  return s;
}
async function executeOapiTool(sdk, toolName, args, opts) {
  switch (toolName) {
    case "lark_calendar_event":
      return executeCalendarEvent(sdk, args, opts);
    case "lark_calendar_freebusy":
      return executeCalendarFreebusy(sdk, args, opts);
    case "lark_task":
      return executeTask(sdk, args, opts);
    case "lark_tasklist":
      return executeTasklist(sdk, args, opts);
    case "lark_bitable_record":
      return executeBitableRecord(sdk, args, opts);
    case "lark_bitable_field":
      return executeBitableField(sdk, args, opts);
    case "lark_bitable_table":
      return executeBitableTable(sdk, args, opts);
    case "lark_bitable_app":
      return executeBitableApp(sdk, args, opts);
    case "lark_search":
      return executeSearch(sdk, args, opts);
    case "lark_sheet":
      return executeSheet(sdk, args, opts);
    case "lark_wiki_node":
      return executeWikiNode(sdk, args, opts);
    case "lark_get_user":
      return executeGetUser(sdk, args, opts);
    case "lark_search_user":
      return executeSearchUser(sdk, args, opts);
    case "lark_im_message":
      return executeImMessage(sdk, args, opts);
    case "lark_im_upload_image":
      return executeImUploadImage(sdk, args, opts);
    case "lark_im_file":
      return executeImFile(sdk, args, opts);
    case "lark_im_get_messages":
      return executeImGetMessages(sdk, args, opts);
    case "lark_im_search_messages":
      return executeImSearchMessages(sdk, args, opts);
    case "lark_im_fetch_resource":
      return executeImFetchResource(sdk, args, opts);
    case "lark_chat":
      return executeChat(sdk, args, opts);
    case "lark_chat_members":
      return executeChatMembers(sdk, args, opts);
    case "lark_drive_file":
      return executeDriveFile(sdk, args, opts);
    case "lark_doc_media":
      return executeDocMedia(sdk, args, opts);
    case "lark_doc_comments":
      return executeDocComments(sdk, args, opts);
    case "lark_calendar_attendee":
      return executeCalendarAttendee(sdk, args, opts);
    case "lark_task_comment":
      return executeTaskComment(sdk, args, opts);
    case "lark_task_subtask":
      return executeTaskSubtask(sdk, args, opts);
    case "lark_bitable_view":
      return executeBitableView(sdk, args, opts);
    case "lark_wiki_space":
      return executeWikiSpace(sdk, args, opts);
    case "lark_sheet_export":
      return executeSheetExport(sdk, args, opts);
    case "lark_mail":
      return executeMail(sdk, args, opts);
    case "lark_approval":
      return executeApproval(sdk, args, opts);
    case "lark_contact_department":
      return executeContactDepartment(sdk, args, opts);
    case "lark_speech_recognize":
      return executeSpeechRecognize(sdk, args, opts);
    default:
      throw new Error(`Unknown OAPI tool: ${toolName}`);
  }
}
async function executeCalendarEvent(sdk, args, opts) {
  const calendarId = args.calendar_id || "primary";
  switch (args.action) {
    case "create": {
      const startTs = parseTimeToTimestamp(args.start_time);
      const endTs = parseTimeToTimestamp(args.end_time);
      if (!startTs || !endTs)
        throw new Error(
          "\u65F6\u95F4\u683C\u5F0F\u9519\u8BEF\uFF01\u5FC5\u987B\u4F7F\u7528ISO 8601\u683C\u5F0F\uFF0C\u4F8B\u5982 2024-01-01T00:00:00+08:00",
        );
      const eventData = {
        summary: args.summary,
        start_time: { timestamp: startTs },
        end_time: { timestamp: endTs },
        need_notification: true,
        attendee_ability: "can_modify_event",
      };
      if (args.description) eventData.description = args.description;
      if (args.location) eventData.location = args.location;
      const res = await sdk.calendar.calendarEvent.create(
        {
          path: { calendar_id: calendarId },
          data: eventData,
        },
        opts,
      );
      const attendees = [...(args.attendees || [])];
      if (args.user_open_id) {
        const already = attendees.some(
          (a) => a.type === "user" && a.id === args.user_open_id,
        );
        if (!already) attendees.push({ type: "user", id: args.user_open_id });
      }
      let attendeeWarning;
      if (attendees.length > 0 && res?.data?.event?.event_id) {
        const operateId =
          args.user_open_id ?? attendees.find((a) => a.type === "user")?.id;
        const attendeeData = attendees.map((a) => ({
          type: a.type,
          user_id: a.type === "user" ? a.id : void 0,
          chat_id: a.type === "chat" ? a.id : void 0,
          room_id: a.type === "resource" ? a.id : void 0,
          third_party_email: a.type === "third_party" ? a.id : void 0,
          operate_id: operateId,
        }));
        try {
          await sdk.calendar.calendarEventAttendee.create(
            {
              path: {
                calendar_id: calendarId,
                event_id: res.data.event.event_id,
              },
              params: { user_id_type: "open_id" },
              data: { attendees: attendeeData, need_notification: true },
            },
            opts,
          );
        } catch (err) {
          attendeeWarning = `\u65E5\u7A0B\u5DF2\u521B\u5EFA\uFF0C\u4F46\u6DFB\u52A0\u53C2\u4F1A\u4EBA\u5931\u8D25\uFF1A${err.message}`;
        }
      }
      const result = { event: res?.data?.event, attendees };
      if (attendeeWarning) result.warning = attendeeWarning;
      else if (attendees.length === 0)
        result.note =
          "\u672A\u6DFB\u52A0\u53C2\u4F1A\u4EBA\uFF0C\u7528\u6237\u53EF\u80FD\u770B\u4E0D\u5230\u65E5\u7A0B\u3002\u5EFA\u8BAE\u4F20\u5165 user_open_id \u53C2\u6570\u3002";
      return result;
    }
    case "list": {
      if (!args.start_time || !args.end_time)
        throw new Error("start_time and end_time are required for list action");
      const startTs = parseTimeToTimestamp(args.start_time);
      const endTs = parseTimeToTimestamp(args.end_time);
      if (!startTs || !endTs)
        throw new Error(
          "\u65F6\u95F4\u683C\u5F0F\u9519\u8BEF\uFF01\u5FC5\u987B\u4F7F\u7528ISO 8601\u683C\u5F0F\u3002",
        );
      const res = await sdk.calendar.calendarEvent.instanceView(
        {
          path: { calendar_id: calendarId },
          params: {
            start_time: startTs,
            end_time: endTs,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        events: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.event_id) throw new Error("event_id is required");
      const res = await sdk.calendar.calendarEvent.get(
        {
          path: { calendar_id: calendarId, event_id: args.event_id },
        },
        opts,
      );
      return { event: res?.data?.event };
    }
    case "patch": {
      if (!args.event_id) throw new Error("event_id is required");
      const updateData = {};
      if (args.summary) updateData.summary = args.summary;
      if (args.description) updateData.description = args.description;
      if (args.start_time) {
        const ts2 = parseTimeToTimestamp(args.start_time);
        if (!ts2) throw new Error("start_time \u683C\u5F0F\u9519\u8BEF");
        updateData.start_time = { timestamp: ts2 };
      }
      if (args.end_time) {
        const ts2 = parseTimeToTimestamp(args.end_time);
        if (!ts2) throw new Error("end_time \u683C\u5F0F\u9519\u8BEF");
        updateData.end_time = { timestamp: ts2 };
      }
      if (args.location)
        updateData.location =
          typeof args.location === "string"
            ? { name: args.location }
            : args.location;
      const res = await sdk.calendar.calendarEvent.patch(
        {
          path: { calendar_id: calendarId, event_id: args.event_id },
          data: updateData,
        },
        opts,
      );
      return { event: res?.data?.event };
    }
    case "delete": {
      if (!args.event_id) throw new Error("event_id is required");
      await sdk.calendar.calendarEvent.delete(
        {
          path: { calendar_id: calendarId, event_id: args.event_id },
          params: { need_notification: args.need_notification ?? true },
        },
        opts,
      );
      return { success: true, event_id: args.event_id };
    }
    case "search": {
      if (!args.query) throw new Error("query is required");
      const res = await sdk.calendar.calendarEvent.search(
        {
          path: { calendar_id: calendarId },
          params: { page_size: args.page_size, page_token: args.page_token },
          data: { query: args.query },
        },
        opts,
      );
      return {
        events: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "reply": {
      if (!args.event_id) throw new Error("event_id is required");
      if (!args.rsvp_status) throw new Error("rsvp_status is required");
      await sdk.calendar.calendarEvent.reply(
        {
          path: { calendar_id: calendarId, event_id: args.event_id },
          data: { rsvp_status: args.rsvp_status },
        },
        opts,
      );
      return {
        success: true,
        event_id: args.event_id,
        rsvp_status: args.rsvp_status,
      };
    }
    case "instances": {
      if (!args.event_id) throw new Error("event_id is required");
      if (!args.start_time || !args.end_time)
        throw new Error(
          "start_time and end_time are required for instances action",
        );
      const startTs = parseTimeToTimestamp(args.start_time);
      const endTs = parseTimeToTimestamp(args.end_time);
      if (!startTs || !endTs)
        throw new Error("start_time and end_time format error (ISO 8601)");
      const res = await sdk.calendar.calendarEvent.instances(
        {
          path: { calendar_id: calendarId, event_id: args.event_id },
          params: {
            start_time: startTs,
            end_time: endTs,
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        instances: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "instance_view": {
      const startTs = parseTimeToTimestamp(args.start_time);
      const endTs = parseTimeToTimestamp(args.end_time);
      if (!startTs || !endTs)
        throw new Error("start_time and end_time are required (ISO 8601)");
      const res = await sdk.calendar.calendarEvent.instanceView(
        {
          path: { calendar_id: calendarId },
          params: {
            start_time: startTs,
            end_time: endTs,
            user_id_type: "open_id",
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        events: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    default:
      throw new Error(`Unknown calendar event action: ${args.action}`);
  }
}
async function executeCalendarFreebusy(sdk, args, opts) {
  const timeMin = parseTimeToRFC3339(args.time_min);
  const timeMax = parseTimeToRFC3339(args.time_max);
  if (!timeMin || !timeMax)
    throw new Error(
      "\u65F6\u95F4\u683C\u5F0F\u9519\u8BEF\uFF01\u5FC5\u987B\u4F7F\u7528ISO 8601\u683C\u5F0F\u3002",
    );
  const userIds = args.user_ids;
  if (!userIds || userIds.length === 0)
    throw new Error("user_ids is required (1-10 users)");
  const res = await sdk.calendar.freebusy.batch(
    {
      data: {
        time_min: timeMin,
        time_max: timeMax,
        user_ids: userIds,
        include_external_calendar: true,
        only_busy: true,
      },
    },
    opts,
  );
  return { freebusy_lists: res?.data?.freebusy_lists ?? [] };
}
async function executeTask(sdk, args, opts) {
  switch (args.action) {
    case "create": {
      if (!args.summary) throw new Error("summary is required");
      const taskData = { summary: args.summary };
      if (args.description) taskData.description = args.description;
      if (args.due) {
        const due = args.due;
        const ts2 = parseTimeToTimestampMs(due.timestamp);
        if (!ts2) throw new Error("due.timestamp \u683C\u5F0F\u9519\u8BEF");
        taskData.due = { timestamp: ts2, is_all_day: due.is_all_day ?? false };
      }
      if (args.start) {
        const start = args.start;
        const ts2 = parseTimeToTimestampMs(start.timestamp);
        if (!ts2) throw new Error("start.timestamp \u683C\u5F0F\u9519\u8BEF");
        taskData.start = {
          timestamp: ts2,
          is_all_day: start.is_all_day ?? false,
        };
      }
      if (args.members) {
        taskData.members = args.members.map((m) => ({
          id: m.id,
          type: "user",
          role: m.role || "assignee",
        }));
      }
      if (args.tasklists) taskData.tasklists = args.tasklists;
      const res = await sdk.request(
        {
          method: "POST",
          url: "/open-apis/task/v2/tasks",
          data: taskData,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      const task = res?.data?.task;
      if (args.current_user_id && task?.guid) {
        const memberIds = (args.members || []).map((m) => m.id);
        if (!memberIds.includes(args.current_user_id)) {
          try {
            await sdk.request(
              {
                method: "POST",
                url: `/open-apis/task/v2/tasks/${task.guid}/add_members`,
                data: {
                  members: [
                    {
                      id: args.current_user_id,
                      type: "user",
                      role: "follower",
                    },
                  ],
                },
                params: { user_id_type: "open_id" },
              },
              opts,
            );
          } catch {}
        }
      }
      return { task };
    }
    case "get": {
      if (!args.task_guid) throw new Error("task_guid is required");
      const guid = validatePathParam(args.task_guid, "task_guid");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/task/v2/tasks/${guid}`,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { task: res?.data?.task };
    }
    case "list": {
      const params = { user_id_type: "open_id" };
      if (args.page_size) params.page_size = args.page_size;
      if (args.page_token) params.page_token = args.page_token;
      if (args.completed !== void 0) params.completed = String(args.completed);
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/task/v2/tasks",
          params,
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "patch": {
      if (!args.task_guid) throw new Error("task_guid is required");
      const patchGuid = validatePathParam(args.task_guid, "task_guid");
      const updateData = {};
      if (args.summary) updateData.summary = args.summary;
      if (args.description !== void 0)
        updateData.description = args.description;
      if (args.completed_at !== void 0) {
        const cat = args.completed_at;
        if (cat === "0") {
          updateData.completed_at = "0";
        } else {
          const ts2 = parseTimeToTimestampMs(cat);
          updateData.completed_at = ts2 || cat;
        }
      }
      if (args.due) {
        const due = args.due;
        const ts2 = parseTimeToTimestampMs(due.timestamp);
        if (!ts2) throw new Error("due.timestamp \u683C\u5F0F\u9519\u8BEF");
        updateData.due = {
          timestamp: ts2,
          is_all_day: due.is_all_day ?? false,
        };
      }
      const res = await sdk.request(
        {
          method: "PATCH",
          url: `/open-apis/task/v2/tasks/${patchGuid}`,
          data: { task: updateData },
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { task: res?.data?.task };
    }
    default:
      throw new Error(`Unknown task action: ${args.action}`);
  }
}
async function executeTasklist(sdk, args, opts) {
  switch (args.action) {
    case "create": {
      if (!args.name) throw new Error("name is required");
      const data3 = { name: args.name };
      if (args.members) data3.members = args.members;
      const res = await sdk.request(
        {
          method: "POST",
          url: "/open-apis/task/v2/tasklists",
          data: data3,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { tasklist: res?.data?.tasklist };
    }
    case "list": {
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/task/v2/tasklists",
          params: {
            user_id_type: "open_id",
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.tasklist_guid) throw new Error("tasklist_guid is required");
      const tlGuid = validatePathParam(args.tasklist_guid, "tasklist_guid");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/task/v2/tasklists/${tlGuid}`,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { tasklist: res?.data?.tasklist };
    }
    case "tasks": {
      if (!args.tasklist_guid) throw new Error("tasklist_guid is required");
      const tasksGuid = validatePathParam(args.tasklist_guid, "tasklist_guid");
      const params = { user_id_type: "open_id" };
      if (args.page_size) params.page_size = args.page_size;
      if (args.page_token) params.page_token = args.page_token;
      if (args.completed !== void 0) params.completed = String(args.completed);
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/task/v2/tasklists/${tasksGuid}/tasks`,
          params,
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "add_members": {
      if (!args.tasklist_guid) throw new Error("tasklist_guid is required");
      if (!args.members) throw new Error("members is required");
      const addGuid = validatePathParam(args.tasklist_guid, "tasklist_guid");
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/task/v2/tasklists/${addGuid}/add_members`,
          data: { members: args.members },
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { tasklist: res?.data?.tasklist };
    }
    default:
      throw new Error(`Unknown tasklist action: ${args.action}`);
  }
}
async function executeBitableRecord(sdk, args, opts) {
  const appToken = args.app_token;
  const tableId = args.table_id;
  switch (args.action) {
    case "create": {
      if (!args.fields) throw new Error("fields is required");
      const res = await sdk.bitable.appTableRecord.create(
        {
          path: { app_token: appToken, table_id: tableId },
          data: { fields: args.fields },
        },
        opts,
      );
      return { record: res?.data?.record };
    }
    case "list": {
      const data3 = {};
      if (args.filter) data3.filter = args.filter;
      if (args.sort) data3.sort = args.sort;
      if (args.field_names) data3.field_names = args.field_names;
      if (args.page_size) data3.page_size = args.page_size;
      if (args.page_token) data3.page_token = args.page_token;
      const res = await sdk.bitable.appTableRecord.search(
        {
          path: { app_token: appToken, table_id: tableId },
          data: data3,
        },
        opts,
      );
      return {
        items: res?.data?.items,
        total: res?.data?.total,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "update": {
      if (!args.record_id) throw new Error("record_id is required");
      if (!args.fields) throw new Error("fields is required");
      const res = await sdk.bitable.appTableRecord.update(
        {
          path: {
            app_token: appToken,
            table_id: tableId,
            record_id: args.record_id,
          },
          data: { fields: args.fields },
        },
        opts,
      );
      return { record: res?.data?.record };
    }
    case "delete": {
      if (!args.record_id) throw new Error("record_id is required");
      await sdk.bitable.appTableRecord.delete(
        {
          path: {
            app_token: appToken,
            table_id: tableId,
            record_id: args.record_id,
          },
        },
        opts,
      );
      return { success: true, record_id: args.record_id };
    }
    case "batch_create": {
      if (!args.records) throw new Error("records is required");
      const res = await sdk.bitable.appTableRecord.batchCreate(
        {
          path: { app_token: appToken, table_id: tableId },
          data: { records: args.records },
        },
        opts,
      );
      return { records: res?.data?.records };
    }
    case "batch_update": {
      if (!args.records) throw new Error("records is required");
      const res = await sdk.bitable.appTableRecord.batchUpdate(
        {
          path: { app_token: appToken, table_id: tableId },
          data: { records: args.records },
        },
        opts,
      );
      return { records: res?.data?.records };
    }
    case "batch_delete": {
      if (!args.record_ids) throw new Error("record_ids is required");
      await sdk.bitable.appTableRecord.batchDelete(
        {
          path: { app_token: appToken, table_id: tableId },
          data: { records: args.record_ids },
        },
        opts,
      );
      return { success: true };
    }
    default:
      throw new Error(`Unknown bitable record action: ${args.action}`);
  }
}
async function executeBitableField(sdk, args, opts) {
  const appToken = args.app_token;
  const tableId = args.table_id;
  switch (args.action) {
    case "list": {
      const res = await sdk.bitable.appTableField.list(
        {
          path: { app_token: appToken, table_id: tableId },
          params: { page_size: args.page_size, page_token: args.page_token },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.field_name) throw new Error("field_name is required");
      if (args.type === void 0) throw new Error("type is required");
      const data3 = { field_name: args.field_name, type: args.type };
      if (args.property) data3.property = args.property;
      const res = await sdk.bitable.appTableField.create(
        {
          path: { app_token: appToken, table_id: tableId },
          data: data3,
        },
        opts,
      );
      return { field: res?.data?.field };
    }
    default:
      throw new Error(`Unknown bitable field action: ${args.action}`);
  }
}
async function executeBitableTable(sdk, args, opts) {
  const appToken = args.app_token;
  switch (args.action) {
    case "list": {
      const res = await sdk.bitable.appTable.list(
        {
          path: { app_token: appToken },
          params: { page_size: args.page_size, page_token: args.page_token },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.name) throw new Error("name is required");
      const table = { name: args.name };
      if (args.fields) table.fields = args.fields;
      const res = await sdk.bitable.appTable.create(
        {
          path: { app_token: appToken },
          data: { table },
        },
        opts,
      );
      return { table: res?.data };
    }
    default:
      throw new Error(`Unknown bitable table action: ${args.action}`);
  }
}
async function executeBitableApp(sdk, args, opts) {
  switch (args.action) {
    case "create": {
      if (!args.name) throw new Error("name is required");
      const data3 = { name: args.name };
      if (args.folder_token) data3.folder_token = args.folder_token;
      const res = await sdk.bitable.app.create({ data: data3 }, opts);
      return { app: res?.data?.app };
    }
    case "get": {
      if (!args.app_token) throw new Error("app_token is required");
      const res = await sdk.bitable.app.get(
        {
          path: { app_token: args.app_token },
        },
        opts,
      );
      return { app: res?.data?.app };
    }
    default:
      throw new Error(`Unknown bitable app action: ${args.action}`);
  }
}
async function executeSearch(sdk, args, opts) {
  const data3 = {};
  if (args.query) data3.query = args.query;
  if (args.filter) {
    const filter = args.filter;
    if (filter.doc_types) data3.docs_types = filter.doc_types;
    if (filter.create_time) {
      const cr = filter.create_time;
      data3.create_time_range = {};
      if (cr.start) {
        const ts2 = parseTimeToTimestamp(cr.start);
        if (ts2) data3.create_time_range.start = Number.parseInt(ts2, 10);
      }
      if (cr.end) {
        const ts2 = parseTimeToTimestamp(cr.end);
        if (ts2) data3.create_time_range.end = Number.parseInt(ts2, 10);
      }
    }
    if (filter.update_time) {
      const ur = filter.update_time;
      data3.update_time_range = {};
      if (ur.start) {
        const ts2 = parseTimeToTimestamp(ur.start);
        if (ts2) data3.update_time_range.start = Number.parseInt(ts2, 10);
      }
      if (ur.end) {
        const ts2 = parseTimeToTimestamp(ur.end);
        if (ts2) data3.update_time_range.end = Number.parseInt(ts2, 10);
      }
    }
  }
  if (args.sort_type) data3.sort_type = args.sort_type;
  const res = await sdk.request(
    {
      method: "POST",
      url: "/open-apis/search/v2/doc_wiki/search",
      data: data3,
      params: {
        page_size: args.page_size,
        page_token: args.page_token,
        user_id_type: "open_id",
      },
    },
    opts,
  );
  return {
    items: res?.data?.items,
    has_more: res?.data?.has_more,
    page_token: res?.data?.page_token,
  };
}
async function executeSheet(sdk, args, opts) {
  let spreadsheetToken = args.spreadsheet_token;
  if (spreadsheetToken?.startsWith("http")) {
    try {
      const u = new URL(spreadsheetToken);
      const match = u.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
      if (match) spreadsheetToken = match[1];
    } catch {}
  }
  if (spreadsheetToken)
    spreadsheetToken = validatePathParam(spreadsheetToken, "spreadsheet_token");
  switch (args.action) {
    case "info": {
      if (!spreadsheetToken) throw new Error("spreadsheet_token is required");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}`,
        },
        opts,
      );
      const sheetsRes = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
        },
        opts,
      );
      return {
        spreadsheet: res?.data?.spreadsheet,
        sheets: sheetsRes?.data?.sheets,
      };
    }
    case "read": {
      if (!spreadsheetToken) throw new Error("spreadsheet_token is required");
      const sheetId = args.sheet_id;
      const range = args.range;
      let fullRange;
      if (sheetId && range) fullRange = `${sheetId}!${range}`;
      else if (sheetId) fullRange = sheetId;
      else if (range) fullRange = range;
      else {
        const sheetsRes = await sdk.request(
          {
            method: "GET",
            url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
          },
          opts,
        );
        const firstSheet = sheetsRes?.data?.sheets?.[0];
        fullRange = firstSheet?.sheet_id || "Sheet1";
      }
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${fullRange}`,
        },
        opts,
      );
      return { data: res?.data };
    }
    case "write": {
      if (!spreadsheetToken) throw new Error("spreadsheet_token is required");
      if (!args.range)
        throw new Error("range is required (e.g. sheet_id!A1:D10)");
      if (!args.values) throw new Error("values is required");
      const res = await sdk.request(
        {
          method: "PUT",
          url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
          data: {
            valueRange: {
              range: args.range,
              values: args.values,
            },
          },
        },
        opts,
      );
      return { data: res?.data };
    }
    case "append": {
      if (!spreadsheetToken) throw new Error("spreadsheet_token is required");
      if (!args.range) throw new Error("range is required");
      if (!args.values) throw new Error("values is required");
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_append`,
          data: {
            valueRange: {
              range: args.range,
              values: args.values,
            },
          },
        },
        opts,
      );
      return { data: res?.data };
    }
    case "find": {
      if (!spreadsheetToken) throw new Error("spreadsheet_token is required");
      if (!args.find) throw new Error("find is required");
      const findSheetId = validatePathParam(
        args.sheet_id || (await getFirstSheetId(sdk, spreadsheetToken, opts)),
        "sheet_id",
      );
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/${findSheetId}/find`,
          data: {
            find_condition: {
              range: args.range || findSheetId,
              match_case: false,
              match_entire_cell: false,
              search_by_regex: false,
              include_formulas: false,
            },
            find: args.find,
          },
        },
        opts,
      );
      return { data: res?.data };
    }
    case "create": {
      if (!args.title) throw new Error("title is required");
      const data3 = { title: args.title };
      if (args.folder_token) data3.folder_token = args.folder_token;
      const res = await sdk.request(
        {
          method: "POST",
          url: "/open-apis/sheets/v3/spreadsheets",
          data: { spreadsheet: data3 },
        },
        opts,
      );
      const newToken = res?.data?.spreadsheet?.spreadsheet_token;
      if (args.headers && newToken) {
        const headerRow = args.headers;
        const sheetId = await getFirstSheetId(sdk, newToken, opts);
        await sdk.request(
          {
            method: "PUT",
            url: `/open-apis/sheets/v2/spreadsheets/${newToken}/values`,
            data: {
              valueRange: {
                range: `${sheetId}!A1:${String.fromCharCode(64 + headerRow.length)}1`,
                values: [headerRow],
              },
            },
          },
          opts,
        );
      }
      return { spreadsheet: res?.data?.spreadsheet };
    }
    default:
      throw new Error(`Unknown sheet action: ${args.action}`);
  }
}
async function getFirstSheetId(sdk, token, opts) {
  const res = await sdk.request(
    {
      method: "GET",
      url: `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`,
    },
    opts,
  );
  return res?.data?.sheets?.[0]?.sheet_id || "Sheet1";
}
async function executeWikiNode(sdk, args, opts) {
  switch (args.action) {
    case "list": {
      if (!args.space_id) throw new Error("space_id is required");
      const spaceId = validatePathParam(args.space_id, "space_id");
      const params = { page_size: args.page_size, page_token: args.page_token };
      if (args.parent_node_token)
        params.parent_node_token = args.parent_node_token;
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
          params,
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.token) throw new Error("token is required");
      const params = { token: args.token };
      if (args.obj_type) params.obj_type = args.obj_type;
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/wiki/v2/spaces/get_node",
          params,
        },
        opts,
      );
      return { node: res?.data?.node };
    }
    default:
      throw new Error(`Unknown wiki node action: ${args.action}`);
  }
}
async function executeGetUser(sdk, args, opts) {
  if (!args.user_id) {
    const res2 = await sdk.request(
      {
        method: "GET",
        url: "/open-apis/authen/v1/user_info",
      },
      opts,
    );
    return { user: res2?.data };
  }
  const userId = validatePathParam(args.user_id, "user_id");
  const userIdType = args.user_id_type || "open_id";
  const res = await sdk.request(
    {
      method: "GET",
      url: `/open-apis/contact/v3/users/${userId}`,
      params: { user_id_type: userIdType },
    },
    opts,
  );
  return { user: res?.data?.user };
}
async function executeSearchUser(sdk, args, opts) {
  const data3 = {};
  if (args.emails) data3.emails = args.emails;
  if (args.mobiles) data3.mobiles = args.mobiles;
  if (!data3.emails && !data3.mobiles)
    throw new Error("emails or mobiles is required");
  const res = await sdk.request(
    {
      method: "POST",
      url: "/open-apis/contact/v3/users/batch_get_id",
      data: data3,
      params: { user_id_type: "open_id" },
    },
    opts,
  );
  return { user_list: res?.data?.user_list };
}
async function executeImUploadImage(sdk, args, opts) {
  const filePath = args.file_path;
  if (!filePath) throw new Error("file_path is required");
  const safePath = assertAllowedFilePath(filePath);
  const ext = extname(safePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext))
    throw new Error(
      `Unsupported image format: ${ext || "(none)"}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(", ")}`,
    );
  const stat = statSync(safePath);
  if (stat.size > 10 * 1024 * 1024)
    throw new Error(
      `Image ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`,
    );
  const imageBuffer = readFileSync(safePath);
  const res = await sdk.im.image.create(
    {
      data: { image_type: "message", image: imageBuffer },
    },
    opts,
  );
  const r = res;
  const imageKey = r?.image_key ?? r?.data?.image_key;
  if (!imageKey) {
    const code = r?.code ?? r?.data?.code ?? "unknown";
    const msg = r?.msg ?? r?.data?.msg ?? JSON.stringify(r?.data ?? r);
    throw new Error(`Failed to upload image: code=${code}, msg=${msg}`);
  }
  return { image_key: imageKey };
}
async function executeImFile(sdk, args, opts) {
  switch (args.action) {
    case "upload": {
      if (!args.file_path) throw new Error("file_path is required for upload");
      const safePath = assertAllowedFilePath(args.file_path);
      const stat = statSync(safePath);
      if (stat.size === 0) throw new Error("Cannot upload empty file");
      if (stat.size > MAX_IM_FILE_UPLOAD)
        throw new Error(
          `File ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 30MB limit`,
        );
      const fileName = basename(safePath);
      const ext = extname(safePath).toLowerCase();
      const fileType = EXT_TO_IM_FILE_TYPE[ext] || "stream";
      const fileBuffer = readFileSync(safePath);
      const data3 = {
        file_type: fileType,
        file_name: fileName,
        file: fileBuffer,
      };
      if (args.duration && (fileType === "opus" || fileType === "mp4")) {
        data3.duration = String(args.duration);
      }
      const res = await sdk.im.v1.file.create({ data: data3 }, opts);
      const r = res;
      const fileKey = r?.file_key ?? r?.data?.file_key;
      if (!fileKey) {
        const code = r?.code ?? r?.data?.code ?? "unknown";
        const msg = r?.msg ?? r?.data?.msg ?? JSON.stringify(r?.data ?? r);
        throw new Error(`Failed to upload file: code=${code}, msg=${msg}`);
      }
      return {
        file_key: fileKey,
        file_name: fileName,
        file_type: fileType,
        size_bytes: stat.size,
      };
    }
    case "download": {
      if (!args.file_key) throw new Error("file_key is required for download");
      const fileKey = validatePathParam(args.file_key, "file_key");
      const res = await sdk.im.v1.file.get(
        { path: { file_key: fileKey } },
        opts,
      );
      const stream2 = res.getReadableStream();
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of stream2) {
        totalSize += chunk.length;
        if (totalSize > MAX_IM_FILE_DOWNLOAD)
          throw new Error("Downloaded file exceeds 100MB limit");
        chunks.push(chunk);
      }
      const buffer2 = Buffer.concat(chunks);
      let savePath;
      if (args.output_path) {
        savePath = assertAllowedFilePath(args.output_path);
      } else {
        const downloadsDir = join(
          fileContext.getStore()?.workspace || tmpdir(),
          "downloads",
        );
        mkdirSync(downloadsDir, { recursive: true });
        savePath = join(
          downloadsDir,
          `${fileKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`,
        );
      }
      writeFileSync(savePath, buffer2);
      return {
        file_key: fileKey,
        size_bytes: buffer2.length,
        saved_path: savePath,
      };
    }
    default:
      throw new Error(`Unknown im_file action: ${args.action}`);
  }
}
async function executeImMessage(sdk, args, opts) {
  switch (args.action) {
    case "send": {
      if (!args.receive_id_type)
        throw new Error("receive_id_type is required for send");
      if (!args.receive_id) throw new Error("receive_id is required for send");
      const res = await sdk.im.v1.message.create(
        {
          params: { receive_id_type: args.receive_id_type },
          data: {
            receive_id: args.receive_id,
            msg_type: args.msg_type,
            content: args.content,
            uuid: args.uuid,
          },
        },
        opts,
      );
      const data3 = res?.data;
      return {
        message_id: data3?.message_id,
        chat_id: data3?.chat_id,
        create_time: data3?.create_time,
      };
    }
    case "reply": {
      if (!args.message_id) throw new Error("message_id is required for reply");
      const msgId = validatePathParam(args.message_id, "message_id");
      const res = await sdk.im.v1.message.reply(
        {
          path: { message_id: msgId },
          data: {
            content: args.content,
            msg_type: args.msg_type,
            reply_in_thread: args.reply_in_thread,
            uuid: args.uuid,
          },
        },
        opts,
      );
      const data3 = res?.data;
      return {
        message_id: data3?.message_id,
        chat_id: data3?.chat_id,
        create_time: data3?.create_time,
      };
    }
    default:
      throw new Error(`Unknown im_message action: ${args.action}`);
  }
}
async function executeImGetMessages(sdk, args, opts) {
  if (!args.chat_id && !args.open_id)
    throw new Error("chat_id or open_id is required");
  if (args.chat_id && args.open_id)
    throw new Error("chat_id and open_id are mutually exclusive");
  let chatId = args.chat_id ?? "";
  if (args.open_id) {
    const p2pRes = await sdk.request(
      {
        method: "POST",
        url: "/open-apis/im/v1/chat_p2p/batch_query",
        data: { chatter_ids: [args.open_id] },
        params: { user_id_type: "open_id" },
      },
      opts,
    );
    const chats = p2pRes?.data?.p2p_chats;
    if (!chats?.length)
      throw new Error(`No P2P chat found for open_id=${args.open_id}`);
    chatId = chats[0].chat_id;
  }
  const startTs = args.start_time
    ? parseTimeToTimestamp(args.start_time)
    : void 0;
  const endTs = args.end_time ? parseTimeToTimestamp(args.end_time) : void 0;
  const sortType =
    args.sort_rule === "create_time_asc"
      ? "ByCreateTimeAsc"
      : "ByCreateTimeDesc";
  const res = await sdk.im.v1.message.list(
    {
      params: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: startTs ?? void 0,
        end_time: endTs ?? void 0,
        sort_type: sortType,
        page_size: args.page_size ?? 50,
        page_token: args.page_token,
      },
    },
    opts,
  );
  return {
    items: res?.data?.items,
    has_more: res?.data?.has_more,
    page_token: res?.data?.page_token,
  };
}
async function executeImSearchMessages(sdk, args, opts) {
  const startTs = args.start_time
    ? parseTimeToTimestamp(args.start_time)
    : void 0;
  const endTs = args.end_time ? parseTimeToTimestamp(args.end_time) : void 0;
  const searchData = {
    query: args.query || "",
    start_time: startTs || "978307200",
    // 2001-01-01 as default
    end_time: endTs || Math.floor(Date.now() / 1e3).toString(),
  };
  if (args.sender_ids) searchData.from_ids = args.sender_ids;
  if (args.chat_id) searchData.chat_ids = [args.chat_id];
  if (args.message_type) searchData.message_type = args.message_type;
  const res = await sdk.search.message.create(
    {
      data: searchData,
      params: {
        user_id_type: "open_id",
        page_size: args.page_size ?? 50,
        page_token: args.page_token,
      },
    },
    opts,
  );
  const messageIds = res?.data?.items ?? [];
  const hasMore = res?.data?.has_more ?? false;
  const pageToken = res?.data?.page_token;
  if (messageIds.length === 0) {
    return { messages: [], has_more: hasMore, page_token: pageToken };
  }
  const queryStr = messageIds
    .map((id) => `message_ids=${encodeURIComponent(id)}`)
    .join("&");
  const mgetRes = await sdk.request(
    {
      method: "GET",
      url: `/open-apis/im/v1/messages/mget?${queryStr}`,
      params: { user_id_type: "open_id" },
    },
    opts,
  );
  return {
    items: mgetRes?.data?.items,
    has_more: hasMore,
    page_token: pageToken,
  };
}
async function executeImFetchResource(sdk, args, opts) {
  const msgId = validatePathParam(args.message_id, "message_id");
  const fileKey = validatePathParam(args.file_key, "file_key");
  const res = await sdk.im.v1.messageResource.get(
    {
      params: { type: args.type },
      path: { message_id: msgId, file_key: fileKey },
    },
    opts,
  );
  const stream2 = res.getReadableStream();
  const chunks = [];
  for await (const chunk of stream2) {
    chunks.push(chunk);
  }
  const buffer2 = Buffer.concat(chunks);
  const contentType = res?.headers?.["content-type"] || "";
  const mimeType2 = contentType ? contentType.split(";")[0].trim() : "";
  const ext =
    (mimeType2 ? MIME_TO_EXT[mimeType2] : void 0) ||
    (args.type === "image" ? ".png" : ".bin");
  const tempPath = join(
    tmpdir(),
    `yep-feishu-${randomBytes(4).toString("hex")}${ext}`,
  );
  writeFileSync(tempPath, buffer2);
  return {
    message_id: args.message_id,
    file_key: args.file_key,
    type: args.type,
    size_bytes: buffer2.length,
    content_type: contentType,
    saved_path: tempPath,
  };
}
async function executeChat(sdk, args, opts) {
  switch (args.action) {
    case "search": {
      if (!args.query) throw new Error("query is required for search");
      const res = await sdk.im.v1.chat.search(
        {
          params: {
            user_id_type: "open_id",
            query: args.query,
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.chat_id) throw new Error("chat_id is required for get");
      const chatId = validatePathParam(args.chat_id, "chat_id");
      const res = await sdk.im.v1.chat.get(
        {
          path: { chat_id: chatId },
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { chat: res?.data };
    }
    default:
      throw new Error(`Unknown chat action: ${args.action}`);
  }
}
async function executeChatMembers(sdk, args, opts) {
  if (!args.chat_id) throw new Error("chat_id is required");
  const chatId = validatePathParam(args.chat_id, "chat_id");
  const res = await sdk.im.v1.chatMembers.get(
    {
      path: { chat_id: chatId },
      params: {
        member_id_type: args.member_id_type || "open_id",
        page_size: args.page_size,
        page_token: args.page_token,
      },
    },
    opts,
  );
  return {
    items: res?.data?.items,
    has_more: res?.data?.has_more,
    page_token: res?.data?.page_token,
    member_total: res?.data?.member_total,
  };
}
async function executeDriveFile(sdk, args, opts) {
  switch (args.action) {
    case "list": {
      const res = await sdk.drive.file.list(
        {
          params: {
            folder_token: args.folder_token,
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        files: res?.data?.files,
        has_more: res?.data?.has_more,
        page_token: res?.data?.next_page_token,
      };
    }
    case "get_meta": {
      if (!args.request_docs || !Array.isArray(args.request_docs))
        throw new Error(
          "request_docs is required (array of {doc_token, doc_type})",
        );
      const res = await sdk.drive.meta.batchQuery(
        {
          data: { request_docs: args.request_docs },
        },
        opts,
      );
      return { metas: res?.data?.metas ?? [] };
    }
    case "copy": {
      if (!args.file_token) throw new Error("file_token is required");
      if (!args.name) throw new Error("name is required");
      if (!args.type) throw new Error("type is required");
      const fileToken = validatePathParam(args.file_token, "file_token");
      const res = await sdk.drive.file.copy(
        {
          path: { file_token: fileToken },
          data: {
            name: args.name,
            type: args.type,
            folder_token: args.folder_token || void 0,
          },
        },
        opts,
      );
      return { file: res?.data?.file };
    }
    case "move": {
      if (!args.file_token) throw new Error("file_token is required");
      if (!args.type) throw new Error("type is required");
      if (!args.folder_token) throw new Error("folder_token is required");
      const mvToken = validatePathParam(args.file_token, "file_token");
      const res = await sdk.drive.file.move(
        {
          path: { file_token: mvToken },
          data: { type: args.type, folder_token: args.folder_token },
        },
        opts,
      );
      return { success: true, task_id: res?.data?.task_id };
    }
    case "delete": {
      if (!args.file_token) throw new Error("file_token is required");
      if (!args.type) throw new Error("type is required");
      const delToken = validatePathParam(args.file_token, "file_token");
      const res = await sdk.drive.file.delete(
        {
          path: { file_token: delToken },
          params: { type: args.type },
        },
        opts,
      );
      return { success: true, task_id: res?.data?.task_id };
    }
    case "upload": {
      if (!args.file_path) throw new Error("file_path is required for upload");
      const filePath = assertAllowedFilePath(args.file_path);
      const fileBuffer = readFileSync(filePath);
      const fileName = args.file_name || basename(filePath);
      const fileSize = fileBuffer.length;
      if (fileSize <= SMALL_FILE_THRESHOLD) {
        const res = await sdk.drive.file.uploadAll(
          {
            data: {
              file_name: fileName,
              parent_type: "explorer",
              parent_node: args.folder_token || "",
              size: fileSize,
              file: fileBuffer,
            },
          },
          opts,
        );
        return {
          file_token: res?.data?.file_token,
          file_name: fileName,
          size: fileSize,
        };
      }
      const prepRes = await sdk.drive.file.uploadPrepare(
        {
          data: {
            file_name: fileName,
            parent_type: "explorer",
            parent_node: args.folder_token || "",
            size: fileSize,
          },
        },
        opts,
      );
      const { upload_id, block_size, block_num } = prepRes.data;
      for (let seq = 0; seq < block_num; seq++) {
        const start = seq * block_size;
        const end = Math.min(start + block_size, fileSize);
        await sdk.drive.file.uploadPart(
          {
            data: {
              upload_id: String(upload_id),
              seq: Number(seq),
              size: Number(end - start),
              file: fileBuffer.subarray(start, end),
            },
          },
          opts,
        );
      }
      const finishRes = await sdk.drive.file.uploadFinish(
        {
          data: { upload_id, block_num },
        },
        opts,
      );
      return {
        file_token: finishRes?.data?.file_token,
        file_name: fileName,
        size: fileSize,
        upload_method: "chunked",
      };
    }
    case "download": {
      if (!args.file_token) throw new Error("file_token is required");
      const dlToken = validatePathParam(args.file_token, "file_token");
      const res = await sdk.drive.file.download(
        {
          path: { file_token: dlToken },
        },
        opts,
      );
      const stream2 = res.getReadableStream();
      const chunks = [];
      for await (const chunk of stream2) {
        chunks.push(chunk);
      }
      const buffer2 = Buffer.concat(chunks);
      if (args.output_path) {
        const outPath = assertAllowedFilePath(args.output_path);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer2);
        return { saved_path: outPath, size: buffer2.length };
      }
      return {
        file_content_base64: buffer2.toString("base64"),
        size: buffer2.length,
      };
    }
    default:
      throw new Error(`Unknown drive_file action: ${args.action}`);
  }
}
function extractDocumentId(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}
async function executeDocMedia(sdk, args, opts) {
  switch (args.action) {
    case "insert": {
      if (!args.doc_id) throw new Error("doc_id is required");
      if (!args.file_path) throw new Error("file_path is required");
      const documentId = extractDocumentId(args.doc_id);
      const filePath = assertAllowedFilePath(args.file_path);
      const mediaType = args.type || "image";
      const stat = statSync(filePath);
      if (stat.size > 20 * 1024 * 1024)
        throw new Error(
          `File ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`,
        );
      const fileName = basename(filePath);
      const blockType = mediaType === "image" ? 27 : 23;
      const blockData =
        mediaType === "image" ? { image: {} } : { file: { token: "" } };
      const createRes = await sdk.docx.documentBlockChildren.create(
        {
          path: { document_id: documentId, block_id: documentId },
          data: { children: [{ block_type: blockType, ...blockData }] },
          params: { document_revision_id: -1 },
        },
        opts,
      );
      let blockId;
      if (mediaType === "file") {
        blockId = createRes?.data?.children?.[0]?.children?.[0];
      } else {
        blockId = createRes?.data?.children?.[0]?.block_id;
      }
      if (!blockId) throw new Error("Failed to create media block");
      const parentType = mediaType === "image" ? "docx_image" : "docx_file";
      const uploadRes = await sdk.drive.v1.media.uploadAll(
        {
          data: {
            file_name: fileName,
            parent_type: parentType,
            parent_node: blockId,
            size: stat.size,
            file: readFileSync(filePath),
            extra: JSON.stringify({ drive_route_token: documentId }),
          },
        },
        opts,
      );
      const fileToken = uploadRes?.file_token ?? uploadRes?.data?.file_token;
      if (!fileToken) throw new Error("Upload failed: no file_token returned");
      const patchRequest = { block_id: blockId };
      if (mediaType === "image") {
        const alignMap = { left: 1, center: 2, right: 3 };
        patchRequest.replace_image = {
          token: fileToken,
          align: alignMap[args.align ?? "center"],
          ...(args.caption ? { caption: { content: args.caption } } : {}),
        };
      } else {
        patchRequest.replace_file = { token: fileToken };
      }
      await sdk.docx.documentBlock.batchUpdate(
        {
          path: { document_id: documentId },
          data: { requests: [patchRequest] },
          params: { document_revision_id: -1 },
        },
        opts,
      );
      return {
        success: true,
        type: mediaType,
        document_id: documentId,
        block_id: blockId,
        file_token: fileToken,
        file_name: fileName,
      };
    }
    case "download": {
      if (!args.resource_token) throw new Error("resource_token is required");
      if (!args.resource_type) throw new Error("resource_type is required");
      if (!args.output_path) throw new Error("output_path is required");
      const resToken = validatePathParam(args.resource_token, "resource_token");
      let res;
      if (args.resource_type === "media") {
        res = await sdk.drive.v1.media.download(
          { path: { file_token: resToken } },
          opts,
        );
      } else {
        res = await sdk.board.v1.whiteboard.downloadAsImage(
          { path: { whiteboard_id: resToken } },
          opts,
        );
      }
      const stream2 = res.getReadableStream();
      const chunks = [];
      for await (const chunk of stream2) {
        chunks.push(chunk);
      }
      const buffer2 = Buffer.concat(chunks);
      const contentType = res?.headers?.["content-type"] || "";
      let finalPath = assertAllowedFilePath(args.output_path);
      const currentExt = extname(finalPath);
      if (!currentExt && contentType) {
        const mimeType2 = contentType.split(";")[0].trim();
        const defaultExt =
          args.resource_type === "whiteboard" ? ".png" : void 0;
        const suggestedExt = MIME_TO_EXT[mimeType2] || defaultExt;
        if (suggestedExt) finalPath = finalPath + suggestedExt;
      }
      mkdirSync(dirname(finalPath), { recursive: true });
      writeFileSync(finalPath, buffer2);
      return {
        resource_type: args.resource_type,
        resource_token: args.resource_token,
        size_bytes: buffer2.length,
        content_type: contentType,
        saved_path: finalPath,
      };
    }
    default:
      throw new Error(`Unknown doc_media action: ${args.action}`);
  }
}
async function executeDocComments(sdk, args, opts) {
  let fileToken = args.file_token;
  let fileType = args.file_type;
  if (fileType === "wiki") {
    const wikiRes = await sdk.request(
      {
        method: "GET",
        url: "/open-apis/wiki/v2/spaces/get_node",
        params: { token: fileToken, obj_type: "wiki" },
      },
      opts,
    );
    const node = wikiRes?.data?.node;
    if (!node?.obj_token || !node?.obj_type)
      throw new Error(
        `Cannot resolve wiki token "${fileToken}" to actual document`,
      );
    fileToken = node.obj_token;
    fileType = node.obj_type;
  }
  switch (args.action) {
    case "list": {
      const res = await sdk.drive.v1.fileComment.list(
        {
          path: { file_token: fileToken },
          params: {
            file_type: fileType,
            is_whole: args.is_whole,
            is_solved: args.is_solved,
            page_size: args.page_size,
            page_token: args.page_token,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.elements || !Array.isArray(args.elements))
        throw new Error(
          "elements is required (array of {type, text/open_id/url})",
        );
      const sdkElements = args.elements.map((el) => {
        if (el.type === "text")
          return { type: "text_run", text_run: { text: el.text } };
        if (el.type === "mention")
          return { type: "person", person: { user_id: el.open_id } };
        if (el.type === "link")
          return { type: "docs_link", docs_link: { url: el.url } };
        return { type: "text_run", text_run: { text: "" } };
      });
      const res = await sdk.drive.v1.fileComment.create(
        {
          path: { file_token: fileToken },
          params: { file_type: fileType, user_id_type: "open_id" },
          data: {
            reply_list: { replies: [{ content: { elements: sdkElements } }] },
          },
        },
        opts,
      );
      return res?.data;
    }
    case "patch": {
      if (!args.comment_id) throw new Error("comment_id is required");
      if (args.is_solved_value === void 0)
        throw new Error("is_solved_value is required");
      const commentId = validatePathParam(args.comment_id, "comment_id");
      await sdk.drive.v1.fileComment.patch(
        {
          path: { file_token: fileToken, comment_id: commentId },
          params: { file_type: fileType },
          data: { is_solved: args.is_solved_value },
        },
        opts,
      );
      return { success: true };
    }
    default:
      throw new Error(`Unknown doc_comments action: ${args.action}`);
  }
}
async function executeCalendarAttendee(sdk, args, opts) {
  const calendarId = args.calendar_id || "primary";
  if (!args.event_id) throw new Error("event_id is required");
  const eventId = validatePathParam(args.event_id, "event_id");
  switch (args.action) {
    case "list": {
      const res = await sdk.calendar.calendarEventAttendee.list(
        {
          path: { calendar_id: calendarId, event_id: eventId },
          params: {
            user_id_type: "open_id",
            page_size: args.page_size,
            page_token: args.page_token,
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "add": {
      if (!args.attendees) throw new Error("attendees is required");
      const attendeeData = args.attendees.map((a) => ({
        type: a.type,
        user_id: a.type === "user" ? a.id : void 0,
        chat_id: a.type === "chat" ? a.id : void 0,
        room_id: a.type === "resource" ? a.id : void 0,
        third_party_email: a.type === "third_party" ? a.id : void 0,
      }));
      const res = await sdk.calendar.calendarEventAttendee.create(
        {
          path: { calendar_id: calendarId, event_id: eventId },
          params: { user_id_type: "open_id" },
          data: { attendees: attendeeData, need_notification: true },
        },
        opts,
      );
      return { attendees: res?.data?.attendees };
    }
    case "remove": {
      if (!args.attendees) throw new Error("attendees is required");
      const removeIds = args.attendees.map((a) => ({
        type: a.type,
        user_id: a.type === "user" ? a.id : void 0,
        chat_id: a.type === "chat" ? a.id : void 0,
        room_id: a.type === "resource" ? a.id : void 0,
        third_party_email: a.type === "third_party" ? a.id : void 0,
      }));
      await sdk.calendar.calendarEventAttendee.batchDelete(
        {
          path: { calendar_id: calendarId, event_id: eventId },
          data: { attendees: removeIds, need_notification: true },
        },
        opts,
      );
      return { success: true };
    }
    default:
      throw new Error(`Unknown calendar_attendee action: ${args.action}`);
  }
}
async function executeTaskComment(sdk, args, opts) {
  if (!args.task_guid) throw new Error("task_guid is required");
  const taskGuid = validatePathParam(args.task_guid, "task_guid");
  switch (args.action) {
    case "list": {
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/task/v2/tasks/${taskGuid}/comments`,
          params: {
            page_size: args.page_size,
            page_token: args.page_token,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.content) throw new Error("content is required");
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/task/v2/tasks/${taskGuid}/comments`,
          data: { content: args.content },
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { comment: res?.data?.comment };
    }
    default:
      throw new Error(`Unknown task_comment action: ${args.action}`);
  }
}
async function executeTaskSubtask(sdk, args, opts) {
  if (!args.task_guid) throw new Error("task_guid is required");
  const taskGuid = validatePathParam(args.task_guid, "task_guid");
  switch (args.action) {
    case "list": {
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/task/v2/tasks/${taskGuid}/subtasks`,
          params: {
            page_size: args.page_size,
            page_token: args.page_token,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.summary) throw new Error("summary is required");
      const subtaskData = { summary: args.summary };
      if (args.description) subtaskData.description = args.description;
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/task/v2/tasks/${taskGuid}/subtasks`,
          data: subtaskData,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { subtask: res?.data?.subtask };
    }
    default:
      throw new Error(`Unknown task_subtask action: ${args.action}`);
  }
}
async function executeBitableView(sdk, args, opts) {
  const appToken = args.app_token;
  const tableId = args.table_id;
  switch (args.action) {
    case "list": {
      const res = await sdk.bitable.appTableView.list(
        {
          path: { app_token: appToken, table_id: tableId },
          params: { page_size: args.page_size, page_token: args.page_token },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "create": {
      if (!args.view_name) throw new Error("view_name is required");
      if (!args.view_type) throw new Error("view_type is required");
      const res = await sdk.bitable.appTableView.create(
        {
          path: { app_token: appToken, table_id: tableId },
          data: { view_name: args.view_name, view_type: args.view_type },
        },
        opts,
      );
      return { view: res?.data?.view };
    }
    default:
      throw new Error(`Unknown bitable_view action: ${args.action}`);
  }
}
async function executeWikiSpace(sdk, args, opts) {
  switch (args.action) {
    case "list": {
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/wiki/v2/spaces",
          params: { page_size: args.page_size, page_token: args.page_token },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.space_id) throw new Error("space_id is required");
      const spId = validatePathParam(args.space_id, "space_id");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/wiki/v2/spaces/${spId}`,
        },
        opts,
      );
      return { space: res?.data?.space };
    }
    default:
      throw new Error(`Unknown wiki_space action: ${args.action}`);
  }
}
async function executeSheetExport(sdk, args, opts) {
  switch (args.action) {
    case "create": {
      if (!args.spreadsheet_token)
        throw new Error("spreadsheet_token is required");
      const token = validatePathParam(
        args.spreadsheet_token,
        "spreadsheet_token",
      );
      const fileExtension = args.file_extension === "csv" ? "csv" : "xlsx";
      const res = await sdk.drive.v1.exportTask.create(
        {
          data: { file_extension: fileExtension, token, type: "sheet" },
        },
        opts,
      );
      return { ticket: res?.data?.ticket };
    }
    case "query": {
      if (!args.ticket) throw new Error("ticket is required");
      if (!args.spreadsheet_token)
        throw new Error("spreadsheet_token is required");
      const ticket = validatePathParam(args.ticket, "ticket");
      const token = validatePathParam(
        args.spreadsheet_token,
        "spreadsheet_token",
      );
      const res = await sdk.drive.v1.exportTask.get(
        {
          path: { ticket },
          params: { token },
        },
        opts,
      );
      const result = res?.data?.result;
      return {
        status: result?.job_status,
        job_status: result?.job_status,
        job_error_msg: result?.job_error_msg,
        file_token: result?.file_token,
        file_size: result?.file_size,
        file_name: result?.file_name,
        file_extension: result?.file_extension,
        type: result?.type,
      };
    }
    case "download": {
      if (!args.file_token) throw new Error("file_token is required");
      const fileToken = validatePathParam(args.file_token, "file_token");
      const res = await sdk.drive.v1.exportTask.download(
        {
          path: { file_token: fileToken },
        },
        opts,
      );
      const stream2 = res.getReadableStream();
      const chunks = [];
      for await (const chunk of stream2) {
        chunks.push(chunk);
      }
      const buffer2 = Buffer.concat(chunks);
      if (args.output_path) {
        const outPath = assertAllowedFilePath(args.output_path);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer2);
        return { saved_path: outPath, size: buffer2.length };
      }
      return {
        file_content_base64: buffer2.toString("base64"),
        size: buffer2.length,
      };
    }
    default:
      throw new Error(`Unknown sheet_export action: ${args.action}`);
  }
}
async function executeMail(sdk, args, opts) {
  const mailboxId = args.mailbox_id || "me";
  switch (args.action) {
    case "list": {
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/mail/v1/mailboxes/${validatePathParam(mailboxId, "mailbox_id")}/messages`,
          params: {
            page_size: args.page_size,
            page_token: args.page_token,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get": {
      if (!args.message_id) throw new Error("message_id is required");
      const msgId = validatePathParam(args.message_id, "message_id");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/mail/v1/mailboxes/${validatePathParam(mailboxId, "mailbox_id")}/messages/${msgId}`,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { message: res?.data };
    }
    case "send": {
      if (!args._user_confirmed) {
        const toList = Array.isArray(args.to)
          ? args.to.map((r) => r.mail_address || r.email).join(", ")
          : String(args.to);
        return {
          pending_confirmation: true,
          action: "send",
          message: `\u53D1\u9001\u90AE\u4EF6\u9700\u8981\u7528\u6237\u786E\u8BA4\u3002\u8BF7\u4F7F\u7528 AskUserQuestion \u5411\u7528\u6237\u786E\u8BA4\u4EE5\u4E0B\u4FE1\u606F\uFF0C\u83B7\u5F97\u786E\u8BA4\u540E\u518D\u6B21\u8C03\u7528 lark_mail\uFF08action=send\uFF09\u5E76\u6DFB\u52A0\u53C2\u6570 _user_confirmed=true\u3002

\u6536\u4EF6\u4EBA: ${toList}
\u4E3B\u9898: ${args.subject}
\u6B63\u6587\u6458\u8981: ${String(args.body_html || args.body_plain_text || "").slice(0, 200)}`,
        };
      }
      if (!args.subject) throw new Error("subject is required");
      if (!args.to) throw new Error("to is required");
      const data3 = {
        subject: args.subject,
        to: args.to,
      };
      if (args.cc) data3.cc = args.cc;
      if (args.body_html)
        data3.body = { content: args.body_html, content_type: "text/html" };
      else if (args.body_plain_text)
        data3.body = {
          content: args.body_plain_text,
          content_type: "text/plain",
        };
      else throw new Error("body_html or body_plain_text is required");
      const res = await sdk.request(
        {
          method: "POST",
          url: `/open-apis/mail/v1/mailboxes/${validatePathParam(mailboxId, "mailbox_id")}/messages/send`,
          data: data3,
        },
        opts,
      );
      return { message_id: res?.data?.message_id, success: true };
    }
    default:
      throw new Error(`Unknown mail action: ${args.action}`);
  }
}
async function executeApproval(sdk, args, opts) {
  switch (args.action) {
    case "get_definition": {
      if (!args.approval_code) throw new Error("approval_code is required");
      const res = await sdk.request(
        {
          method: "POST",
          url: "/open-apis/approval/v4/approvals/query",
          data: { approval_code: args.approval_code, locale: "zh-CN" },
        },
        opts,
      );
      return { approval: res?.data };
    }
    case "list_instances": {
      if (!args.approval_code) throw new Error("approval_code is required");
      const data3 = { approval_code: args.approval_code };
      if (args.start_time) data3.start_time = args.start_time;
      if (args.end_time) data3.end_time = args.end_time;
      if (args.page_size) data3.page_size = args.page_size;
      if (args.page_token) data3.page_token = args.page_token;
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/approval/v4/instances",
          params: data3,
        },
        opts,
      );
      return {
        items: res?.data?.instance_code_list,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get_instance": {
      if (!args.instance_id) throw new Error("instance_id is required");
      const instanceId = validatePathParam(args.instance_id, "instance_id");
      const res = await sdk.request(
        {
          method: "GET",
          url: `/open-apis/approval/v4/instances/${instanceId}`,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { instance: res?.data };
    }
    case "create": {
      if (!args._user_confirmed) {
        return {
          pending_confirmation: true,
          action: "create",
          message: `\u53D1\u8D77\u5BA1\u6279\u9700\u8981\u7528\u6237\u786E\u8BA4\u3002\u8BF7\u4F7F\u7528 AskUserQuestion \u5411\u7528\u6237\u786E\u8BA4\u4EE5\u4E0B\u4FE1\u606F\uFF0C\u83B7\u5F97\u786E\u8BA4\u540E\u518D\u6B21\u8C03\u7528 lark_approval\uFF08action=create\uFF09\u5E76\u6DFB\u52A0\u53C2\u6570 _user_confirmed=true\u3002

\u5BA1\u6279\u5B9A\u4E49: ${args.approval_code}
\u53D1\u8D77\u4EBA open_id: ${args.open_id}
\u8868\u5355\u5185\u5BB9: ${String(args.form).slice(0, 300)}`,
        };
      }
      if (!args.approval_code) throw new Error("approval_code is required");
      if (!args.open_id) throw new Error("open_id is required (initiator)");
      if (!args.form)
        throw new Error("form is required (JSON string of form values)");
      const data3 = {
        approval_code: args.approval_code,
        open_id: args.open_id,
        form: args.form,
      };
      if (args.node_approver_open_id_list)
        data3.node_approver_open_id_list = args.node_approver_open_id_list;
      const res = await sdk.request(
        {
          method: "POST",
          url: "/open-apis/approval/v4/instances",
          data: data3,
          params: { user_id_type: "open_id" },
        },
        opts,
      );
      return { instance_code: res?.data?.instance_code };
    }
    default:
      throw new Error(`Unknown approval action: ${args.action}`);
  }
}
async function executeContactDepartment(sdk, args, opts) {
  const deptId = args.department_id || "0";
  const deptIdType = args.department_id_type || "open_department_id";
  switch (args.action) {
    case "list": {
      const params = {
        department_id_type: deptIdType,
        parent_department_id: deptId,
        fetch_child: args.fetch_child ?? false,
        page_size: args.page_size,
        page_token: args.page_token,
        user_id_type: "open_id",
      };
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/contact/v3/departments",
          params,
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    case "get_users": {
      const safeDeptId = validatePathParam(deptId, "department_id");
      const res = await sdk.request(
        {
          method: "GET",
          url: "/open-apis/contact/v3/users/find_by_department",
          params: {
            department_id: safeDeptId,
            department_id_type: deptIdType,
            page_size: args.page_size,
            page_token: args.page_token,
            user_id_type: "open_id",
          },
        },
        opts,
      );
      return {
        items: res?.data?.items,
        has_more: res?.data?.has_more,
        page_token: res?.data?.page_token,
      };
    }
    default:
      throw new Error(`Unknown contact_department action: ${args.action}`);
  }
}
async function executeSpeechRecognize(sdk, args, opts) {
  let audioBuffer;
  if (args.file_path) {
    const safePath = assertAllowedFilePath(args.file_path);
    audioBuffer = readFileSync(safePath);
  } else if (args.message_id && args.file_key) {
    const msgId = validatePathParam(args.message_id, "message_id");
    const fileKey = validatePathParam(args.file_key, "file_key");
    const res = await sdk.im.messageResource.get(
      {
        params: { type: "file" },
        path: { message_id: msgId, file_key: fileKey },
      },
      opts,
    );
    const stream2 = res.getReadableStream();
    const chunks = [];
    for await (const chunk of stream2) {
      chunks.push(chunk);
    }
    audioBuffer = Buffer.concat(chunks);
  } else {
    throw new Error("Either file_path or (message_id + file_key) is required");
  }
  if (audioBuffer.length > MAX_AUDIO_SIZE) {
    throw new Error(
      `Audio file too large: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_AUDIO_SIZE / 1024 / 1024}MB limit`,
    );
  }
  const convertAudioToPcm2 = convertAudioToPcm;
  const pcmBuffer = await convertAudioToPcm2(audioBuffer);
  const fileId = randomBytes(8).toString("hex");
  const result = await sdk.request(
    {
      method: "POST",
      url: "/open-apis/speech_to_text/v1/speech/file_recognize",
      data: {
        speech: { speech: pcmBuffer.toString("base64") },
        config: { file_id: fileId, format: "pcm", engine_type: "16k_auto" },
      },
    },
    opts,
  );
  return {
    recognition_text: result?.data?.recognition_text || "",
    audio_size: audioBuffer.length,
    pcm_size: pcmBuffer.length,
  };
}
const TZ_OFFSET_HOURS = 8;
const TZ_OFFSET_STRING = "+08:00";
const ALLOWED_IMAGE_EXTS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".webp",
]);
const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
const EXT_TO_IM_FILE_TYPE = {
  ".opus": "opus",
  ".mp4": "mp4",
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".xls": "xls",
  ".xlsx": "xls",
  ".ppt": "ppt",
  ".pptx": "ppt",
};
const MAX_IM_FILE_UPLOAD = 30 * 1024 * 1024;
const MAX_IM_FILE_DOWNLOAD = 100 * 1024 * 1024;
const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
};
const SMALL_FILE_THRESHOLD = 15 * 1024 * 1024;
