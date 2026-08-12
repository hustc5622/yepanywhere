export interface PasswordPrompt {
  readHidden(label: string): Promise<string>;
}

export interface TerminalPasswordPromptOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function createTerminalPasswordPrompt(
  options: TerminalPasswordPromptOptions = {},
): PasswordPrompt {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  return {
    async readHidden(label: string): Promise<string> {
      if (
        !input.isTTY ||
        !output.isTTY ||
        typeof input.setRawMode !== "function"
      ) {
        throw new Error("必须在交互式终端中输入密码");
      }

      output.write(label);
      const wasRaw = input.isRaw;
      let onData: ((chunk: Buffer | string) => void) | undefined;

      try {
        input.setRawMode(true);
        input.resume();

        return await new Promise<string>((resolve, reject) => {
          let value = "";
          onData = (chunk: Buffer | string) => {
            const text = chunk.toString();
            for (const character of text) {
              if (character === "\r" || character === "\n") {
                resolve(value);
                return;
              }
              if (character === "\u0003") {
                reject(new Error("管理员密码输入已取消"));
                return;
              }
              if (character === "\u007f" || character === "\b") {
                value = value.slice(0, -1);
              } else {
                value += character;
              }
            }
          };
          input.on("data", onData);
        });
      } finally {
        if (onData) {
          input.off("data", onData);
        }
        input.setRawMode(Boolean(wasRaw));
        input.pause();
        output.write("\n");
      }
    },
  };
}

export function createBase64StdinPasswordPrompt(
  input: NodeJS.ReadStream = process.stdin,
): PasswordPrompt {
  let passwordsPromise: Promise<string[]> | undefined;
  let nextPasswordIndex = 0;

  const readPasswords = async (): Promise<string[]> => {
    let encodedInput = "";
    for await (const chunk of input) {
      encodedInput += chunk.toString();
    }

    const encodedPasswords = encodedInput.split(/\r?\n/);
    if (encodedPasswords.at(-1) === "") {
      encodedPasswords.pop();
    }
    if (encodedPasswords.length !== 2) {
      throw new Error("管理员密码输入格式无效");
    }

    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    return encodedPasswords.map((encodedPassword) => {
      const passwordBytes = Buffer.from(encodedPassword, "base64");
      try {
        if (passwordBytes.toString("base64") !== encodedPassword) {
          throw new Error("管理员密码输入格式无效");
        }
        return utf8Decoder.decode(passwordBytes);
      } catch {
        throw new Error("管理员密码输入格式无效");
      } finally {
        passwordBytes.fill(0);
      }
    });
  };

  return {
    async readHidden(): Promise<string> {
      passwordsPromise ??= readPasswords();
      const passwords = await passwordsPromise;
      const password = passwords[nextPasswordIndex];
      if (password === undefined) {
        throw new Error("管理员密码输入格式无效");
      }
      nextPasswordIndex += 1;
      return password;
    },
  };
}
