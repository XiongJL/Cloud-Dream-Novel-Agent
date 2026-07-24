# 备份与恢复功能设计方案 (Backup & Restore Design)

## 1. 目标 (Goals)
提供一个安全、可靠的本地数据备份与恢复机制，支持跨设备迁移（Windows/Mac/Mobile），并确保数据隐私。

## 2. 备份格式规范 (Backup Format Specification)

采用 **ZIP** 压缩包格式，扩展名为 `.nebak` (CloudDream Novel Agent Backup)。
文件结构如下：

```
backup.nebak (ZIP Archive)
├── manifest.json       # 元数据 (版本、时间、加密信息)
└── data.json           # 核心数据 (未加密时)
    OR
└── data.bin            # 核心数据 (加密时)
```

### 2.1 Manifest 结构 (元数据)
```json
{
  "version": 1,
  "appVersion": "0.1.0",
  "createdAt": "2024-03-20T10:00:00.000Z",
  "platform": "win32",
  "encrypted": true,
  "encryption": {  // 仅当 encrypted=true 时存在
    "algo": "aes-256-gcm",
    "salt": "hex_string", // 用于 PBKDF2 密钥派生
    "iv": "hex_string",   // 初始化向量
    "authTag": "hex_string" // GCM 认证标签 (用于验证密码正确性)
  }
}
```

### 2.2 Data 结构 (JSON Payload)
数据以纯 JSON 格式存储，保持关系型结构以便于逻辑恢复。此时 `Chapter.content` 为 Lexical JSON 字符串，保持原样导出即可。

```json
{
  "novels": [ ... ],
  "volumes": [ ... ],
  "chapters": [ ... ],
  "characters": [ ... ],
  "ideas": [ ... ],
  "tags": [ ... ]
}
```

## 3. 技术实现 (Technical Implementation)

### 3.1 技术栈
- **环境**: Electron Node.js Main Process
- **压缩**: `adm-zip` 或 `archiver` (推荐 `adm-zip` 因API简单且支持 Buffer)
- **加密**: Node.js原生 `crypto` 模块 (AES-256-GCM + PBKDF2)
- **数据库交互**: Prisma Client

### 3.2 导出流程 (Export Workflow)
1.  **UI**: 用户点击“导出备份”，可选填写密码。
2.  **Main**: 
    - 调用 `prisma.$transaction` 获取所有表数据。
    - 构建 Data JSON 对象。
3.  **加密处理** (如果提供了密码):
    - 生成随机 Salt (16 bytes) 和 IV (12 bytes)。
    - 使用 `crypto.pbkdf2` (100,000 iterations, sha256) 从密码派生 32-byte Key。
    - 使用 `aes-256-gcm` 加密 Data JSON。
    - 获取 AuthTag。
    - 将加密后的 Buffer 存为 `data.bin`，并在 Manifest 中记录 salt, iv, authTag。
4.  **打包**:
    - 将 Manifest 和 Data (或 Encrypted Data) 写入 ZIP。
5.  **保存**:
    - 弹出文件保存对话框，保存为 `NovelData_YYYYMMDD.nebak`。

### 3.3 恢复流程 (Restore Workflow)
1.  **UI**: 用户点击“恢复备份”，选择 `.nebak` 文件。
2.  **Main**:
    - 解压读取 `manifest.json`。
    - 检查版本兼容性。
    - **密码验证**: 
      - 如果 `manifest.encrypted` 为 `true`，通知渲染进程弹窗询问密码。
      - 接收密码，进行解密尝试。
      - 使用 GCM AuthTag 验证密码是否正确。如失败，抛出错误提示用户重试。
3.  **数据恢复策略 (Full Restore)**:
    - **安全备份 (Auto-Backup)**: 
      - 在覆盖前，自动在应用数据目录的 `backups/auto/` 下创建 `auto_backup_{timestamp}.nebak`。
      - **轮替策略**: 检查该目录，如果文件数超过 3 个，按修改时间删除最旧的文件，确保最多保留 3 份。
    - **清空旧数据**: 使用事务清空当前数据库 (`deleteMany` on all tables)。
    - **写入新数据**: 按照依赖顺序 (`Novel` -> `Volume` -> `Chapter/Character/Idea`) 插入数据。
    - **原子性**: 整个过程在一个 Prisma 交互式事务 (`$transaction`) 中完成，确保要么全成功，要么全回滚。
4.  **完成**:
    - 通知前端恢复成功。
    - 建议用户重启应用或自动刷新页面以重新加载数据。

## 4. UI 设计 (UI/UX)

在 **设置 (Settings)** -> **备份与恢复 (Backup & Restore)** 面板中添加：

- **导出 (Export)** Card:
  - 标题: 导出数据
  - 描述: 创建当前所有作品的完整备份。
  - 控件: [包含密码保护 (Checkbox)] -> [导出按钮]
- **导入 (Import)** Card:
  - 标题: 恢复数据
  - 描述: 从备份文件恢复。**⚠️ 注意：此操作将覆盖当前所有数据。**
  - 控件: [恢复按钮]
- **自动备份 (Auto Backups)** List:
  - 标题: 自动备份回滚
  - 描述: 最近 3 次恢复操作前的自动备份。
  - 列表项:
    - `2024-03-20 10:00` [恢复]
    - `2024-03-19 15:30` [恢复]

## 5. 兼容性 (Compatibility)
- JSON 格式天然支持所有平台。
- 未来的 Mac/Mobile 端只需实现相同的解压与解密逻辑即可读取数据。
- 数据库 Schema 变更时，需要在恢复逻辑中增加 Data Migration 层 (检查 manifest.version)。


## 6. AI ???????2026-03-06 ???
- AI API Key / API Token ????? Electron userData/ai-settings.json?
- ?????????????????????
- ???????? i-settings.json ?????????
- ????????AI ????????????????

