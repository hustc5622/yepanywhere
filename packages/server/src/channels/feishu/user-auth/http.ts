import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain, FeishuProxyMode } from "@yep-anywhere/shared";

/** Use the same account-scoped proxy policy for OAuth, documents and SDK calls. */
export async function feishuFetch(
  input: string,
  init: RequestInit,
  account: { domain: FeishuDomain; proxyMode?: FeishuProxyMode },
): Promise<Response> {
  if (
    account.proxyMode === "direct" ||
    (account.proxyMode !== "environment" && account.domain === "feishu")
  )
    return fetch(input, init);
  try {
    const data = await defaultHttpInstance.request({
      url: input,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      data:
        init.body instanceof URLSearchParams ? init.body.toString() : init.body,
      timeout: 120_000,
      signal: init.signal,
      maxRedirects: 0,
    } as Parameters<typeof defaultHttpInstance.request>[0]);
    return Response.json(data);
  } catch (error) {
    const response = (error as { response?: { status: number; data: unknown } })
      .response;
    if (response)
      return Response.json(response.data, { status: response.status });
    throw error;
  }
}
