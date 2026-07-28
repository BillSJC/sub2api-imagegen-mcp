# Sub2API ImageGen MCP

一个本地 STDIO MCP 服务器，让 Codex / ChatGPT 桌面版通过现有
**Sub2API API Key** 调用 OpenAI 兼容的图片生成与编辑接口。

它解决的是“内置 `image_gen` 没有被宿主注入”这一类问题：安装后出现的是
MCP 工具 `imagegen`，不是修复或伪装成宿主内置的 `image_gen`。Sub2API 本身
不需要改代码，只需已经提供并允许当前 API Key 使用：

- `POST /v1/images/generations`
- `POST /v1/images/edits`

## 工作方式

- 无引用图：调用 `/v1/images/generations`
- 有 1–5 张本地引用图：转成 data URL 后调用 `/v1/images/edits`
- 要求 Sub2API 返回 `data[0].b64_json`
- MCP 同时返回图片内容，并以 `0600` 权限保存一份本地文件
- 不启动网络监听端口；Codex 通过 STDIO 启动和连接它

默认模型是 `gpt-image-2`。图片生成可能产生费用，服务不会自动重试。

## 前置条件

- Node.js `20.19.0` 或更高版本（推荐当前 LTS 或 Node.js 24）
- Git、curl、npm
- 可在终端执行 `codex mcp` 的 Codex CLI / 桌面版
- 一个可用的 Sub2API 地址和 API Key
- API Key 所属分组已开启图片生成权限，且有可用余额/额度与支持图片模型的上游账号

验证 Node.js：

```bash
node --version
npm --version
```

## 一键安装（推荐）

在 macOS 或 Linux 终端运行：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh | bash
```

安装器会通过终端安全地询问 Sub2API 地址和 API Key，然后自动：

1. 将公开仓库克隆或快进更新到
   `~/.local/share/sub2api-imagegen-mcp`。
2. 按锁文件安装依赖、构建 MCP，并移除开发依赖。
3. 将 Key 写入仓库外的
   `~/.config/sub2api-imagegen-mcp/sub2api-api.key`，权限设为 `0600`。
4. 在不发送图片请求、不产生费用的前提下检查配置。
5. 备份 `~/.codex/config.toml`，通过官方 `codex mcp` 命令注册
   `sub2api_imagegen`，再写入图片生成所需的超时和审批设置。
6. 若 Codex 配置步骤失败，自动恢复安装前的 `config.toml`。

Key 不会出现在命令历史、仓库或 Codex `config.toml` 中。安装完成后完全重启
ChatGPT/Codex，新建任务并运行 `/mcp`，确认 `sub2api_imagegen` 已连接且提供
`imagegen` 工具。

重复运行同一条命令就是升级；安装器只接受 Git 快进更新，不覆盖源码中的本地
修改。每次修改 Codex 配置前都会在 `~/.codex/` 保留带时间戳的私有备份。

如果希望先审阅脚本：

```bash
curl -fL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh \
  -o /tmp/sub2api-imagegen-mcp-install.sh
less /tmp/sub2api-imagegen-mcp-install.sh
bash /tmp/sub2api-imagegen-mcp-install.sh
```

### 无人值守安装

推荐预先创建仓库外的 `0600` Key 文件，再运行：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  env SUB2API_BASE_URL="https://sub2api.example.com/v1" \
  SUB2API_API_KEY_FILE="$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key" \
  bash -s -- --non-interactive
```

也可下载脚本后直接执行：

```bash
SUB2API_BASE_URL="https://sub2api.example.com/v1" \
SUB2API_API_KEY_FILE="$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key" \
bash /tmp/sub2api-imagegen-mcp-install.sh --non-interactive
```

查看全部路径和模型覆盖选项：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  bash -s -- --help
```

不要把真实 Key 作为命令行参数；安装器也没有 `--api-key` 选项。自动化环境若
确实只能注入 Secret，可临时设置 `SUB2API_API_KEY`，安装器会将其转存到外部
私有文件并在启动子进程前从环境中移除。

### 卸载 MCP 注册项

```bash
codex mcp remove sub2api_imagegen
```

这只移除 Codex 注册项。为避免意外删除凭据，一键安装器不会自动删除 Key 文件、
已生成图片、源码目录或 `config.toml` 备份；确认不再需要后可自行处理这些路径。

## 手动安装

选择一个不在其他项目内的独立目录：

```bash
cd /你准备存放源码的绝对父目录
git clone https://github.com/BillSJC/sub2api-imagegen-mcp.git
cd sub2api-imagegen-mcp
npm ci
npm run check
npm run build
```

公开仓库通过 HTTPS 克隆不需要 GitHub 凭据。已经配置 GitHub SSH 的机器也可以
改用 `git@github.com:BillSJC/sub2api-imagegen-mcp.git`。

构建产物是 `dist/index.js`。升级时执行：

```bash
cd /该仓库的绝对路径
git pull --ff-only
npm ci
npm run check
npm run build
```

## 安全保存 API Key

公开仓库、Git 配置、Codex `config.toml` 和 shell 历史中都不应出现真实
API Key。桌面应用也不一定继承交互式 shell 的环境变量，因此推荐使用仓库
外的私有凭据文件。

以下命令会安全地交互读取 API Key，不把值写入命令历史：

```bash
mkdir -p "$HOME/.config/sub2api-imagegen-mcp"
chmod 700 "$HOME/.config/sub2api-imagegen-mcp"
install -m 600 /dev/null "$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key"
read -r -s "SUB2API_KEY_INPUT?Sub2API API Key: "
printf '\n'
printf '%s\n' "$SUB2API_KEY_INPUT" > "$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key"
unset SUB2API_KEY_INPUT
chmod 600 "$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key"
```

上面的 `read` 语法适用于 macOS 默认的 zsh。Linux/bash 可使用：

```bash
read -r -s -p "Sub2API API Key: " SUB2API_KEY_INPUT
printf '\n'
```

凭据文件必须是绝对路径、普通文件、非符号链接，并在 macOS/Linux 上保持
`0600`。

## 先检查配置

创建图片输出目录：

```bash
mkdir -p "$HOME/Pictures/Sub2API"
chmod 700 "$HOME/Pictures/Sub2API"
```

用真实的绝对路径替换下面示例中的路径和地址，然后运行：

```bash
SUB2API_BASE_URL="https://sub2api.example.com/v1" \
SUB2API_API_KEY_FILE="$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key" \
SUB2API_IMAGE_OUTPUT_DIR="$HOME/Pictures/Sub2API" \
node /该仓库的绝对路径/dist/index.js --check-config
```

成功时会输出脱敏配置和 `"ok": true`，不会输出 API Key。这里不发起图片请求，
也不会产生图片费用。

## 接入 Codex / ChatGPT 桌面版

ChatGPT 桌面版、Codex CLI 和 Codex IDE 扩展在同一台主机上共享
`~/.codex/config.toml`。将以下内容加入该文件，所有路径都替换为真实绝对路径：

```toml
[mcp_servers.sub2api_imagegen]
command = "/Node可执行文件的绝对路径/node"
args = ["/该仓库的绝对路径/dist/index.js"]
cwd = "/该仓库的绝对路径"
enabled = true
required = true
startup_timeout_sec = 10
tool_timeout_sec = 360
default_tools_approval_mode = "writes"

[mcp_servers.sub2api_imagegen.env]
SUB2API_BASE_URL = "https://sub2api.example.com/v1"
SUB2API_API_KEY_FILE = "/你的用户目录/.config/sub2api-imagegen-mcp/sub2api-api.key"
SUB2API_IMAGE_OUTPUT_DIR = "/你的用户目录/Pictures/Sub2API"
SUB2API_IMAGE_MODEL = "gpt-image-2"
```

查找 Node.js 的绝对路径：

```bash
command -v node
```

保存配置后：

1. 完全重启 ChatGPT 桌面版，或重启 Codex CLI / IDE 扩展。
2. 在会话中输入 `/mcp`。
3. 确认服务器 `sub2api_imagegen` 已连接，且列出工具 `imagegen`。
4. 最好新建一个任务测试，避免旧任务保留启动时的工具快照。
5. 第一次调用时批准写入型 MCP 工具；这是因为它会产生外部费用并保存本地文件。

也可以用 `codex mcp list` 查看配置，用
`codex mcp get sub2api_imagegen --json` 检查该项；输出内容中不应包含 API Key。

默认的 `writes` 审批策略是有意设置的。确认真实环境稳定后，如果明确接受每次
图片请求自动产生费用和本地写入，可以自行改成：

```toml
[mcp_servers.sub2api_imagegen.tools.imagegen]
approval_mode = "approve"
```

不建议在尚未完成真实环境验收时开启自动批准。非交互 `codex exec` 若无法弹出
审批，会把调用报告为 `user cancelled MCP tool call`。

## 真实环境验收

先做一次低风险的纯生成请求：

> 请明确使用 sub2api_imagegen 的 imagegen 工具，生成一张 1024x1024 的极简
> 黑白几何图，白色背景，只有一个小黑圆，并返回本地保存路径。

验收以下结果：

- 工具调用名是 `sub2api_imagegen.imagegen`（界面可能显示完整 MCP 命名空间）
- MCP 返回图片内容
- `SUB2API_IMAGE_OUTPUT_DIR` 中出现 PNG/JPEG/WebP 文件
- Sub2API 中只有一次对应请求和一次计费记录
- MCP 输出和应用日志中没有 API Key

再测试编辑：把上一步生成图片的绝对路径作为
`referenced_image_paths`，要求把黑圆改成蓝色。此时 Sub2API 应收到
`/v1/images/edits` 请求。

## 工具参数

`imagegen` 支持：

- `prompt`：必填，完整生成或编辑指令
- `referenced_image_paths`：可选，最多 5 个绝对本地路径；支持 PNG、JPEG、WebP
- `quality`：`auto`、`low`、`medium`、`high`
- `size`：`auto`、`1024x1024`、`1536x1024`、`1024x1536`
- `background`：`auto`、`opaque`、`transparent`
- `output_name`：可选、安全的本地文件基本名

可选环境变量：

| 变量                            | 默认值        | 说明           |
| ------------------------------- | ------------- | -------------- |
| `SUB2API_IMAGE_MODEL`           | `gpt-image-2` | 图片模型       |
| `SUB2API_TIMEOUT_MS`            | `300000`      | 上游请求超时   |
| `SUB2API_MAX_INPUT_IMAGE_BYTES` | `20971520`    | 单张引用图上限 |
| `SUB2API_MAX_RESPONSE_BYTES`    | `41943040`    | 上游响应体上限 |

`SUB2API_API_KEY` 与 `SUB2API_API_KEY_FILE` 必须且只能设置一个。长期桌面使用
推荐后者。

## 排错

### 仍然提示“image_gen 未注入”

这是预期的命名差异。不要继续调用宿主内置 `image_gen`；检查 `/mcp`，并明确
调用 `sub2api_imagegen` 服务器提供的 `imagegen`。如果 MCP 工具也没有出现：

1. 确认已运行 `npm run build`，且 `dist/index.js` 存在。
2. 确认 `command`、`args`、`cwd` 都是绝对路径。
3. 在同一终端运行 `node .../dist/index.js --check-config`。
4. 完全重启客户端并新建任务。
5. 检查 `codex mcp get sub2api_imagegen --json` 和客户端 MCP 日志。

### `invalid_config`

- 只设置一个 Key 来源。
- 凭据文件执行 `chmod 600`，目录执行 `chmod 700`。
- 使用绝对路径，凭据文件不能是符号链接。
- 正式 Sub2API 地址必须是 HTTPS。

### HTTP 401 / 403

- Key 无效、过期或用户/分组被禁用。
- 当前分组没有开启图片生成权限。
- 不要把完整 Key 或响应体粘贴到公开 Issue。

### HTTP 404

确认 `SUB2API_BASE_URL` 指向正确实例。填写域名根地址或 `/v1` 都可以；服务会
规范化根地址到 `/v1/`。同时确认该 Sub2API 版本已注册同步图片路由。

### 超时

图片生成可能超过 Codex 默认 60 秒。保持 `tool_timeout_sec = 360`，必要时同步
提高 `SUB2API_TIMEOUT_MS`。服务不会自动重试，以免重复计费；先在 Sub2API
后台核实原请求状态。

### 返回 URL，没有 `b64_json`

本 MCP 有意不跟随上游 URL，避免服务端请求伪造与额外凭据泄漏风险。确认
Sub2API/上游接受 `response_format = "b64_json"`。

## 开发验证

本地测试完全使用模拟响应，不需要真实 API Key，也不产生费用：

```bash
npm ci
npm run check
```

安全设计和漏洞报告方式见 [SECURITY.md](SECURITY.md)。
