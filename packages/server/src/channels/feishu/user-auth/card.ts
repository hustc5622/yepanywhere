/** OAuth is completed on the provider's page, never through an approval callback. */
export function buildFeishuAuthorizationCard(url?: string) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: url ? "连接飞书账号" : "飞书授权已完成",
      },
      template: url ? "blue" : "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: url
            ? `需要你的飞书授权才能继续此任务。\n\n[授权并继续](${url})\n\n请使用发起任务的账号。仍在等待的工具会继续；已结束的任务请回复“继续”。`
            : "授权已完成。仍在等待的工具会继续；如果原任务已结束，请回复“继续”。",
        },
      ],
    },
  };
}
