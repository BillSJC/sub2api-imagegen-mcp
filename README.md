# Sub2API ImageGen MCP

## 能干什么

让 Codex / ChatGPT 桌面版使用现有 **Sub2API API Key** 生成图片，或编辑 1–5 张
本地参考图。它提供的是 MCP 工具 `sub2api_imagegen.imagegen`，不是宿主内置的
`image_gen`。

无需修改 Sub2API；实例只需支持：

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- 返回 `data[0].b64_json`

图片会直接返回给 Codex，同时以私有权限保存到本地。MCP 使用 STDIO，不开放
监听端口。

## 一键安装

要求 macOS/Linux、Node.js `>=20.19.0`、Git、curl、npm，以及可执行
`codex mcp` 的 Codex：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh | bash
```

按提示输入 Sub2API 地址和 Key。Key 会保存在仓库外的
`~/.config/sub2api-imagegen-mcp/sub2api-api.key`（`0600`），不会写入
`config.toml`、仓库或命令历史。安装器会自动构建 MCP、备份并更新 Codex 配置；
失败时恢复原配置。

安装后完全重启 Codex，新建任务并运行 `/mcp`，确认 `sub2api_imagegen` 已连接。
重复执行同一命令即可升级。

默认上游超时为 10 分钟，Codex 工具超时为 11 分钟。大图或高质量任务可升级并
提高到最大 15/16 分钟：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  env SUB2API_TIMEOUT_MS=900000 bash
```

## 使用示例

以下示例都使用当前支持的最小尺寸 `1024x1024`、`quality: low` 和简洁构图，
相对更快。直接复制任意一段到 Codex；每次调用仍可能产生费用。

### 雨衣橘猫贴纸

```text
请明确使用 sub2api_imagegen 的 imagegen 工具，只调用一次：
prompt: 一只穿亮黄色雨衣的圆脸橘猫，手拿一片小荷叶，扁平贴纸风格，粗黑轮廓，三种颜色，纯白背景，居中，无文字
size: 1024x1024
quality: low
background: opaque
output_name: raincoat-cat
完成后返回本地保存路径。
```

### 玻璃罐里的月球营地

```text
请明确使用 sub2api_imagegen 的 imagegen 工具，只调用一次：
prompt: 透明玻璃罐里的一座迷你月球露营地，一顶橙色帐篷、一名小宇航员和两块岩石，等距 3D 玩具风格，深蓝纯色背景，柔和灯光，无文字
size: 1024x1024
quality: low
background: opaque
output_name: moon-camp-jar
完成后返回本地保存路径。
```

### 午夜拉面机器人

```text
请明确使用 sub2api_imagegen 的 imagegen 工具，只调用一次：
prompt: 一个圆滚滚的小机器人在午夜街边煮拉面，红蓝双色丝网印刷风格，简单几何形状，米白色背景，构图居中，无文字
size: 1024x1024
quality: low
background: opaque
output_name: ramen-robot
完成后返回本地保存路径。
```

### 快速编辑刚生成的图片

把路径替换为上一张图片的真实绝对路径：

```text
请明确使用 sub2api_imagegen 的 imagegen 工具，只调用一次：
prompt: 保持主体、构图和画风不变，只把背景改成柔和的薄荷绿色
referenced_image_paths: ["/绝对路径/raincoat-cat.png"]
size: 1024x1024
quality: low
background: opaque
output_name: raincoat-cat-mint
完成后返回本地保存路径。
```

## 其他内容

### 工作方式与限制

- 无参考图时调用 `/v1/images/generations`；有参考图时调用
  `/v1/images/edits`。
- 默认模型为 `gpt-image-2`；要求上游返回 base64 图片，不跟随返回的 URL。
- 支持 PNG、JPEG、WebP 参考图；路径必须是绝对路径且不能是符号链接。
- 生成文件采用防碰撞名称和私有权限。
- MCP 不自动重试。超时不代表上游任务已取消，重试前必须检查 Sub2API 请求和
  计费状态，并由用户明确确认新的付费调用。

### 安装器进阶用法

无人值守安装建议预先准备仓库外的 `0600` Key 文件：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  env SUB2API_BASE_URL="https://sub2api.example.com/v1" \
  SUB2API_API_KEY_FILE="$HOME/.config/sub2api-imagegen-mcp/sub2api-api.key" \
  SUB2API_TIMEOUT_MS=900000 \
  bash -s -- --non-interactive
```

查看所有选项：

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  bash -s -- --help
```

需要先审阅脚本时：

```bash
curl -fL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh \
  -o /tmp/sub2api-imagegen-mcp-install.sh
less /tmp/sub2api-imagegen-mcp-install.sh
bash /tmp/sub2api-imagegen-mcp-install.sh
```

只卸载 Codex 注册项：

```bash
codex mcp remove sub2api_imagegen
```

卸载命令不会删除 Key、图片、源码或 `config.toml` 备份。

### 手动安装与配置

```bash
git clone https://github.com/BillSJC/sub2api-imagegen-mcp.git
cd sub2api-imagegen-mcp
npm ci
npm run check
npm run build
```

将 Key 放在仓库外的私有普通文件中，目录权限设为 `0700`，文件权限设为
`0600`。不要把真实 Key 放进下面的 TOML：

```toml
[mcp_servers.sub2api_imagegen]
command = "/Node可执行文件的绝对路径/node"
args = ["/仓库绝对路径/dist/index.js"]
cwd = "/仓库绝对路径"
enabled = true
required = true
startup_timeout_sec = 10
tool_timeout_sec = 660
default_tools_approval_mode = "writes"

[mcp_servers.sub2api_imagegen.env]
SUB2API_BASE_URL = "https://sub2api.example.com/v1"
SUB2API_API_KEY_FILE = "/用户目录/.config/sub2api-imagegen-mcp/sub2api-api.key"
SUB2API_IMAGE_OUTPUT_DIR = "/用户目录/Pictures/Sub2API"
SUB2API_IMAGE_MODEL = "gpt-image-2"
SUB2API_TIMEOUT_MS = "600000"
```

若把 `SUB2API_TIMEOUT_MS` 调到 `900000`，同时将 `tool_timeout_sec` 调到
`960`。用以下命令验证配置；它不会发起图片请求或产生费用：

```bash
SUB2API_BASE_URL="https://sub2api.example.com/v1" \
SUB2API_API_KEY_FILE="/Key文件绝对路径" \
SUB2API_IMAGE_OUTPUT_DIR="/图片输出目录绝对路径" \
SUB2API_TIMEOUT_MS=600000 \
node /仓库绝对路径/dist/index.js --check-config
```

### 工具参数

| 参数                     | 说明                                                   |
| ------------------------ | ------------------------------------------------------ |
| `prompt`                 | 必填，生成或编辑指令                                   |
| `referenced_image_paths` | 可选，1–5 个本地绝对路径；支持 PNG、JPEG、WebP         |
| `quality`                | `auto`、`low`、`medium`、`high`                        |
| `size`                   | `auto`、`1024x1024`、`1536x1024`、`1024x1536`          |
| `background`             | `auto`、`opaque`、`transparent`                        |
| `output_name`            | 可选，本地文件基本名；服务会过滤危险字符并避免同名覆盖 |

可选环境变量：

| 变量                            | 默认值        | 说明               |
| ------------------------------- | ------------- | ------------------ |
| `SUB2API_IMAGE_MODEL`           | `gpt-image-2` | 图片模型           |
| `SUB2API_TIMEOUT_MS`            | `600000`      | 上游请求超时       |
| `SUB2API_MAX_INPUT_IMAGE_BYTES` | `20971520`    | 单张参考图大小上限 |
| `SUB2API_MAX_RESPONSE_BYTES`    | `41943040`    | 上游响应体大小上限 |

`SUB2API_API_KEY` 与 `SUB2API_API_KEY_FILE` 必须且只能设置一个。长期使用推荐
外部 Key 文件。

### 验收

1. 完全重启 Codex 并新建任务。
2. 运行 `/mcp`，确认服务器 `sub2api_imagegen` 已连接且列出 `imagegen`。
3. 复制上面的低质量小图示例，只批准一次调用。
4. 确认 MCP 返回图片、本地输出目录出现文件，Sub2API 只有一条对应请求和计费。
5. 用生成文件的绝对路径执行一次编辑，确认走
   `/v1/images/edits`。
6. 确认 MCP 结果、Codex 日志和仓库均没有 API Key。

默认 `writes` 审批用于防止图片请求在未确认时产生费用。真实环境验收完成前，
不建议改成自动批准。

### 排错

| 症状                           | 处理                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| 仍提示 `image_gen` 未注入      | 这是不同工具；在 `/mcp` 中确认并明确调用 `sub2api_imagegen.imagegen`，重启后使用新任务    |
| MCP 不出现                     | 检查 `codex mcp get sub2api_imagegen --json`、绝对路径、`dist/index.js` 和客户端 MCP 日志 |
| `invalid_config`               | 只设置一个 Key 来源；Key 文件必须是绝对路径、普通文件、非符号链接且权限为 `0600`          |
| HTTP 401/403                   | 检查 Key、余额、用户/分组状态、图片权限和支持图片模型的上游账号                           |
| HTTP 404                       | 检查 Sub2API 地址以及实例是否注册 `/v1/images/generations` 和 `/v1/images/edits`          |
| 10 分钟仍超时                  | 升级时设置 `SUB2API_TIMEOUT_MS=900000`；超时后先查请求与计费，未经确认不要重试            |
| 只返回 URL，没有 `b64_json`    | 确认 Sub2API/上游接受 `response_format = "b64_json"`                                      |
| `user cancelled MCP tool call` | 非交互任务无法完成 `writes` 审批；改用可交互任务或在明确接受费用后调整审批策略            |

### 开发与安全

```bash
npm ci
npm run check
```

测试使用模拟响应，不需要真实 Key，也不会产生费用。CI 会扫描当前文件及完整 Git
历史中的常见凭据模式；若真实凭据曾进入公开历史，必须立即撤销/轮换，不能只在后续
提交中删除。完整安全边界见 [SECURITY.md](SECURITY.md)。
