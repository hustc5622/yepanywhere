import { AdminPasswordService } from "./auth/AdminPasswordService.js";
import type { PasswordPrompt } from "./cli-password-prompt.js";

export interface SetupAdminPasswordOptions {
  prompt: PasswordPrompt;
  adminPasswordService?: AdminPasswordService;
}

export async function setupAdminPassword(
  options: SetupAdminPasswordOptions,
): Promise<void> {
  const adminPasswordService =
    options.adminPasswordService ?? new AdminPasswordService();
  console.log(`管理员密码文件：${adminPasswordService.getFilePath()}`);
  if (await adminPasswordService.isConfigured()) {
    console.log("此操作会重置整个项目共用的管理员密码。");
  }
  const password = await options.prompt.readHidden("新管理员密码：");
  const confirmation = await options.prompt.readHidden("确认管理员密码：");
  if (password !== confirmation) {
    throw new Error("两次输入的管理员密码不一致");
  }
  await adminPasswordService.setPassword(password);
  console.log("管理员密码已保存。");
  console.log("请妥善保存管理员密码；本项目不保存可找回的明文密码。");
}
