![Sub2API ImageGen MCP](docs/assets/sub2api-imagegen-banner.jpg)

# Sub2API ImageGen MCP

使用已有的 Sub2API API Key，让 Codex 生成和编辑图片。

## 能干什么

这个本地 MCP 提供 `sub2api_imagegen.imagegen` 工具，可生成图片，也可用 1–5
张本地参考图进行编辑。图片会返回给 Codex，并以私有权限保存到本地。

它通过 STDIO 工作，不监听端口，也无需修改 Sub2API。你的实例只需支持：

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- 返回 `data[0].b64_json`

注意：它不是 Codex 内置的 `image_gen`，调用时请明确指定
`sub2api_imagegen.imagegen`。

## 一键安装

需要 Node.js `>=20.19.0`、Git、npm，以及可执行 `codex mcp` 的 Codex。

### Windows

在 Windows PowerShell 5.1 或 PowerShell 7 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm 'https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.ps1' | iex"
```

### macOS / Linux / WSL2

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh | bash
```

按提示输入 Sub2API 地址和 Key。安装器会：

- 将 Key 保存在仓库外，并限制为当前用户可读；不写入仓库、`config.toml`
  或命令历史；
- 构建 MCP、更新 Codex 配置，并在失败时恢复原配置；
- 保留 Key、配置备份和已生成图片，重复运行同一命令即可升级。

安装完成后，完全退出并重新启动 Codex，新建任务运行 `/mcp`，确认
`sub2api_imagegen` 已连接。

默认上游超时为 10 分钟，Codex 工具超时为 11 分钟。大图可在升级时提高到最大
15/16 分钟：

```powershell
$env:SUB2API_TIMEOUT_MS = "900000"
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.ps1' | iex"
```

```bash
curl -fsSL https://raw.githubusercontent.com/BillSJC/sub2api-imagegen-mcp/main/install.sh |
  env SUB2API_TIMEOUT_MS=900000 bash
```

## 使用示例

下面的例子都使用 `1024x1024` 和 `quality: low`，构图简单、通常耗时较短。直接
复制到 Codex 即可；每次调用仍可能产生费用。

### 雨衣橘猫贴纸

```text
请使用 sub2api_imagegen.imagegen，只调用一次：
prompt: 一只穿亮黄色雨衣的圆脸橘猫，手拿小荷叶，扁平贴纸风格，粗黑轮廓，三种颜色，纯白背景，居中，无文字
size: 1024x1024
quality: low
background: opaque
output_name: raincoat-cat
完成后返回本地保存路径。
```

### 玻璃罐里的月球营地

```text
请使用 sub2api_imagegen.imagegen，只调用一次：
prompt: 透明玻璃罐里的一座迷你月球营地，一顶橙色帐篷、一名小宇航员和两块岩石，等距 3D 玩具风，深蓝纯色背景，柔和灯光，无文字
size: 1024x1024
quality: low
background: opaque
output_name: moon-camp-jar
完成后返回本地保存路径。
```

### 午夜拉面机器人

```text
请使用 sub2api_imagegen.imagegen，只调用一次：
prompt: 一个圆滚滚的小机器人在午夜街边煮拉面，红蓝双色丝网印刷风格，简单几何形状，米白背景，居中，无文字
size: 1024x1024
quality: low
background: opaque
output_name: ramen-robot
完成后返回本地保存路径。
```

### 编辑刚生成的图片

把路径替换为真实的绝对路径：

```text
请使用 sub2api_imagegen.imagegen，只调用一次：
prompt: 保持主体、构图和画风不变，只把背景改成柔和的薄荷绿色
referenced_image_paths: ["/绝对路径/raincoat-cat.png"]
size: 1024x1024
quality: low
background: opaque
output_name: raincoat-cat-mint
完成后返回本地保存路径。
```

## 其他内容

### 关键限制

- 无参考图时调用 `/v1/images/generations`，有参考图时调用
  `/v1/images/edits`。
- 默认模型为 `gpt-image-2`，上游必须返回 base64 图片。
- 参考图支持 PNG、JPEG、WebP；必须是绝对路径、普通文件且不能是符号链接。
- MCP 不自动重试。超时不代表上游任务已取消；再次调用前先检查 Sub2API 请求和
  计费状态。
- 默认 `writes` 审批用于避免意外产生费用。

### 工具参数

| 参数                     | 可选值或说明                                     |
| ------------------------ | ------------------------------------------------ |
| `prompt`                 | 必填，生成或编辑指令                             |
| `referenced_image_paths` | 可选，1–5 个本地绝对路径                         |
| `quality`                | `auto`、`low`、`medium`、`high`                  |
| `size`                   | `auto`、`1024x1024`、`1536x1024`、`1024x1536`    |
| `background`             | `auto`、`opaque`、`transparent`                  |
| `output_name`            | 可选，本地文件名；危险字符会被过滤，同名不会覆盖 |

常用环境变量：`SUB2API_IMAGE_MODEL`、`SUB2API_TIMEOUT_MS`、
`SUB2API_MAX_INPUT_IMAGE_BYTES`、`SUB2API_MAX_RESPONSE_BYTES`。长期使用 Key
文件；`SUB2API_API_KEY` 与 `SUB2API_API_KEY_FILE` 只能设置一个。

### 验收与卸载

1. 重启 Codex，在新任务运行 `/mcp`。
2. 确认 `sub2api_imagegen` 已连接并列出 `imagegen`。
3. 运行一个低质量示例，确认 Codex 返回图片、本地出现文件、Sub2API 只有一条
   对应请求。
4. 用生成图片的绝对路径执行一次编辑，确认请求进入 `/v1/images/edits`。

只移除 Codex 注册项：

```bash
codex mcp remove sub2api_imagegen
```

这不会删除 Key、图片、源码或配置备份。

### 常见问题

| 症状                           | 处理                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| 提示 `image_gen` 未注入        | 这是另一个工具；重启后在新任务明确调用 `sub2api_imagegen.imagegen`                |
| MCP 不出现                     | 检查 `/mcp`、`codex mcp get sub2api_imagegen --json` 和 Codex MCP 日志            |
| `invalid_config`               | 只设置一个 Key 来源；Key 文件须为绝对路径、普通文件、非链接，并限制为当前用户可读 |
| HTTP 401/403                   | 检查 Key、余额、分组状态、图片权限和可用模型                                      |
| HTTP 404                       | 检查 Sub2API 地址和两个图片端点                                                   |
| 超时                           | 升级时将 `SUB2API_TIMEOUT_MS` 提高到 `900000`；先查请求与计费，未经确认不要重试   |
| 只有 URL，没有 `b64_json`      | 确认 Sub2API/上游接受 `response_format = "b64_json"`                              |
| `user cancelled MCP tool call` | 非交互任务无法完成 `writes` 审批；改用可交互任务，或在接受费用后调整审批策略      |

### 开发与安全

```bash
npm ci
npm run check
```

测试全部使用模拟响应，不需要真实 Key，也不会产生费用。CI 在 Ubuntu 和 Windows
运行，并扫描当前文件及 Git 历史中的常见凭据模式。更多说明见
[SECURITY.md](SECURITY.md)。
