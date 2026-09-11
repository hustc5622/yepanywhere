function getRequiredScopes(toolName, action) {
  const key = action ? `${toolName}.${action}` : `${toolName}.default`;
  return TOOL_SCOPES[key] ?? [];
}
const TOOL_SCOPES = {
  // -- Calendar --
  "lark_calendar_event.create": [
    "calendar:calendar.event:create",
    "calendar:calendar.event:update",
  ],
  "lark_calendar_event.list": ["calendar:calendar.event:read"],
  "lark_calendar_event.get": ["calendar:calendar.event:read"],
  "lark_calendar_event.patch": ["calendar:calendar.event:update"],
  "lark_calendar_event.delete": ["calendar:calendar.event:delete"],
  "lark_calendar_event.search": ["calendar:calendar.event:read"],
  "lark_calendar_event.reply": ["calendar:calendar.event:reply"],
  "lark_calendar_event.instances": ["calendar:calendar.event:read"],
  "lark_calendar_event.instance_view": ["calendar:calendar.event:read"],
  "lark_calendar_freebusy.list": ["calendar:calendar.free_busy:read"],
  "lark_calendar_attendee.list": ["calendar:calendar.event:read"],
  "lark_calendar_attendee.add": ["calendar:calendar.event:update"],
  "lark_calendar_attendee.remove": [
    "calendar:calendar.event:read",
    "calendar:calendar.event:update",
  ],
  // -- Task --
  "lark_task.create": ["task:task:write", "task:task:writeonly"],
  "lark_task.get": ["task:task:read", "task:task:write"],
  "lark_task.list": ["task:task:read", "task:task:write"],
  "lark_task.patch": ["task:task:write", "task:task:writeonly"],
  "lark_tasklist.create": ["task:tasklist:write"],
  "lark_tasklist.list": ["task:tasklist:read", "task:tasklist:write"],
  "lark_tasklist.get": ["task:tasklist:read", "task:tasklist:write"],
  "lark_tasklist.tasks": ["task:tasklist:read", "task:tasklist:write"],
  "lark_tasklist.add_members": ["task:tasklist:write"],
  "lark_task_comment.create": ["task:comment:write"],
  "lark_task_comment.list": ["task:comment:read", "task:comment:write"],
  "lark_task_comment.get": ["task:comment:read", "task:comment:write"],
  "lark_task_subtask.create": ["task:task:write"],
  "lark_task_subtask.list": ["task:task:read", "task:task:write"],
  // -- Bitable --
  "lark_bitable_app.create": ["base:app:create"],
  "lark_bitable_app.get": ["base:app:read"],
  "lark_bitable_app.list": ["space:document:retrieve"],
  "lark_bitable_app.patch": ["base:app:update"],
  "lark_bitable_app.copy": ["base:app:copy"],
  "lark_bitable_table.create": ["base:table:create"],
  "lark_bitable_table.list": ["base:table:read"],
  "lark_bitable_table.patch": ["base:table:update"],
  "lark_bitable_table.delete": ["base:table:delete"],
  "lark_bitable_record.create": ["base:record:create"],
  "lark_bitable_record.update": ["base:record:update"],
  "lark_bitable_record.delete": ["base:record:delete"],
  "lark_bitable_record.batch_create": ["base:record:create"],
  "lark_bitable_record.batch_update": ["base:record:update"],
  "lark_bitable_record.batch_delete": ["base:record:delete"],
  "lark_bitable_record.list": ["base:record:retrieve"],
  "lark_bitable_field.create": ["base:field:create"],
  "lark_bitable_field.list": ["base:field:read"],
  "lark_bitable_field.update": ["base:field:read", "base:field:update"],
  "lark_bitable_field.delete": ["base:field:delete"],
  "lark_bitable_view.create": ["base:view:write_only"],
  "lark_bitable_view.get": ["base:view:read"],
  "lark_bitable_view.list": ["base:view:read"],
  "lark_bitable_view.patch": ["base:view:write_only"],
  "lark_bitable_view.delete": ["base:view:write_only"],
  // -- Search --
  "lark_search.search": ["search:docs:read"],
  // -- Drive --
  "lark_drive_file.list": ["space:document:retrieve"],
  "lark_drive_file.get_meta": ["drive:drive.metadata:readonly"],
  "lark_drive_file.copy": ["docs:document:copy"],
  "lark_drive_file.move": ["space:document:move"],
  "lark_drive_file.delete": ["space:document:delete"],
  "lark_drive_file.upload": ["drive:file:upload"],
  "lark_drive_file.download": ["drive:file:download"],
  // -- Doc --
  "lark_doc_media.download": [
    "board:whiteboard:node:read",
    "docs:document.media:download",
  ],
  "lark_doc_media.insert": [
    "docx:document:write_only",
    "docs:document.media:upload",
  ],
  "lark_doc_comments.list": ["wiki:node:read", "docs:document.comment:read"],
  "lark_doc_comments.create": [
    "wiki:node:read",
    "docs:document.comment:create",
  ],
  "lark_doc_comments.patch": ["docs:document.comment:update"],
  // -- Wiki --
  "lark_wiki_node.list": ["wiki:node:retrieve"],
  "lark_wiki_node.get": ["wiki:node:read"],
  "lark_wiki_node.create": ["wiki:node:create"],
  "lark_wiki_node.move": ["wiki:node:move"],
  "lark_wiki_node.copy": ["wiki:node:copy"],
  "lark_wiki_space.list": ["wiki:space:retrieve"],
  "lark_wiki_space.get": ["wiki:space:read"],
  "lark_wiki_space.create": ["wiki:space:write_only"],
  // -- Sheet --
  "lark_sheet.info": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
  ],
  "lark_sheet.read": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
  ],
  "lark_sheet.write": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "lark_sheet.append": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "lark_sheet.find": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
  ],
  "lark_sheet.create": [
    "sheets:spreadsheet.meta:read",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet:create",
    "sheets:spreadsheet:write_only",
  ],
  "lark_sheet_export.create": ["docs:document:export"],
  "lark_sheet_export.query": ["docs:document:export"],
  "lark_sheet_export.download": ["docs:document:export"],
  // -- IM (user identity) --
  "lark_im_get_messages.default": [
    "im:chat:read",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
  ],
  "lark_im_search_messages.default": [
    "im:chat:read",
    "im:message:readonly",
    "search:message",
  ],
  "lark_im_fetch_resource.default": [
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "im:message:readonly",
  ],
  // -- IM (bot identity -- no user scope needed, these use TAT) --
  "lark_im_message.send": [],
  // TAT -- no user scope
  "lark_im_message.reply": [],
  // TAT -- no user scope
  // -- Chat --
  "lark_chat.search": ["im:chat:read"],
  "lark_chat.get": ["im:chat:read"],
  "lark_chat_members.default": ["im:chat.members:read"],
  // -- Common --
  "lark_get_user.default": [
    "contact:contact.base:readonly",
    "contact:user.base:readonly",
  ],
  "lark_search_user.default": ["contact:user:search"],
  // -- Mail --
  "lark_mail.list": ["mail:user_mailbox:read"],
  "lark_mail.get": ["mail:user_mailbox:read"],
  "lark_mail.send": ["mail:user_mailbox:send_as_user"],
  // -- Contact Department --
  "lark_contact_department.list": ["contact:department.base:readonly"],
  "lark_contact_department.get_users": [
    "contact:department.base:readonly",
    "contact:user.base:readonly",
  ],
  // -- MCP Doc --
  "lark_fetch_doc.default": ["docx:document:readonly", "wiki:node:read"],
  "lark_create_doc.default": [
    "docx:document:create",
    "docx:document:readonly",
    "docx:document:write_only",
    "wiki:node:create",
    "wiki:node:read",
  ],
  "lark_update_doc.default": [
    "docx:document:create",
    "docx:document:readonly",
    "docx:document:write_only",
  ],
};

export { getRequiredScopes };
