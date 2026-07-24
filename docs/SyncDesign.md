# 云同步架构设计 (Cloud Sync Architecture)

## 1. 系统概览 (System Overview)

本系统旨在实现本地桌面端 (Electron + SQLite) 与云端 (Spring Boot + MariaDB) 之间的高效、增量数据同步。

*   **客户端**: 桌面应用，离线优先，使用 SQLite 存储。
*   **服务端**: Java Spring Boot 应用，作为数据中心，使用 MariaDB 存储。
*   **兼容性**: 支持未来扩展表 (角色、场景、大纲) 和大文件同步 (图片)。

## 2. 数据库设计方案 (Database Schema)

云端数据库 (MariaDB) 将作为超集，包含所有本地表的结构，并增加同步所需的元数据。

### 核心表 (Core Tables)
所有支持同步的表都必须包含 `id` (UUID), `updatedAt` (Timestamp), `deleted` (Boolean) 和 `version` (Int) 字段。

1.  **User (用户/作者表)**
    *   `id`: UUID
    *   `username`: String
    *   `passwordHash`: String
    *   `nickname`: String (显示名称)
    *   `avatarUrl`: String
    *   `lastSyncAt`: Timestamp (最后同步时间)

2.  **Novel (小说表)**
    *   `id`: UUID (Primary Key)
    *   `userId`: UUID (Foreign Key)
    *   `title`: String
    *   `description`: Text
    *   `coverUrl`: String
    *   `formatting`: JSON (小说格式化设置)
    *   `updatedAt`: Timestamp
    *   `deleted`: Boolean (软删除)

3.  **Volume (卷表)**
    *   `id`: UUID
    *   `novelId`: UUID
    *   `title`: String
    *   `order`: Integer
    *   `updatedAt`: Timestamp
    *   `deleted`: Boolean

4.  **Chapter (章节表)**
    *   `id`: UUID
    *   `volumeId`: UUID
    *   `title`: String
    *   `content`: LongText (Lexical JSON 格式)
    *   `wordCount`: Integer
    *   `order`: Integer
    *   `updatedAt`: Timestamp
    *   `deleted`: Boolean

### 扩展表 (Future Tables - 预留)
为了支持"兼容性"，设计通用的扩展表结构或在实体表中预留 `properties` (JSON) 字段。独立表更适合结构化查询。

5.  **Character (角色表)** - *Future*
    *   `id`, `novelId`, `name`, `age`, `bio`, `tags` (JSON), `avatarUrl`.
6.  **Scene (场景表)** - *Future*
    *   `id`, `novelId`, `name`, `description`, `location`, `imageUrl`.
7.  **PlotLine (情节线表)** - **New**
    *   `id`, `novelId`, `name`, `description`, `color`, `sortOrder`, `updatedAt`, `deleted`.
8.  **PlotPoint (情节点表)** - **New**
    *   `id`, `novelId`, `plotLineId`, `title`, `description`, `type`, `status`, `order`, `updatedAt`, `deleted`.
9.  **PlotPointAnchor (情节锚点表)** - **New**
    *   `id`, `plotPointId`, `chapterId`, `type`, `lexicalKey`, `offset`, `length`, `updatedAt`.

## 3. 同步协议 API (Sync Protocol API)

采用 **"Sync Cursor" (同步游标)** 机制，基于 `updatedAt` 时间戳进行增量同步。

### 3.1 认证 (Authentication)
*   **POST** `/api/auth/login`
    *   Req: `{ username, password }`
    *   Res: `{ token, user: { id, nickname, ... } }`

### 3.2 数据上行 (Push) - 客户端推送到云端
客户端上传自上次同步以来发生变化的数据。

*   **POST** `/api/sync/push`
    *   **Header**: `Authorization: Bearer <token>`
    *   **Request Body**:
        ```json
        {
          "lastSyncCursor": 1700000000000,
          "changes": {
            "novels": [ { "id": "uuid", "title": "...", "updatedAt": 1700000100000 }, ... ],
            "chapters": [ { "id": "uuid", "title": "...", "content": "...", "updatedAt": ... } ],
            "plotLines": [ ... ],
            "plotPoints": [ ... ],
            "deletedIds": { "novels": [], "chapters": [], "plotLines": [] }
          }
        }
        ```
    *   **Response**:
        ```json
        {
          "success": true,
          "processedCount": 15,
          "conflicts": []
        }
        ```

### 3.3 数据下行 (Pull) - 客户端从云端拉取
客户端获取云端自 `lastSyncCursor` 之后更新的数据，支持分页和全查。

*   **POST** `/api/sync/pull`
    *   **Request Body**:
        ```json
        {
          "lastSyncCursor": 1700000000000
        }
        ```
    *   **Response**:
        ```json
        {
          "newSyncCursor": 1700000200000,
          "data": {
            "novels": [...],
            "chapters": [...],
            "characters": [...]
          }
        }
        ```

### 3.4 文件同步 (File Sync)
针对图片等大文件，不走 JSON API，使用独立接口。

*   **POST** `/api/files/upload` (Multipart)
*   **GET** `/api/files/{fileId}`

## 4. 章节内容格式 (Content Format)

章节内容现在使用 **Lexical Editor State JSON** 格式存储，而非纯文本。

```json
{
  "root": {
    "children": [
      {
        "type": "paragraph",
        "children": [
          { "type": "text", "text": "这是一段文字。" }
        ]
      }
    ],
    "type": "root"
  }
}
```

**兼容性处理**:
- 老数据（纯文本）在加载时会自动转换为 Lexical 格式。
- 同步时应保持 JSON 格式传输。

## 5. 兼容性与健壮性策略 (Compatibility & Robustness)

1.  **JSON 字段容错**:
    *   在 Java 实体类中，对于非核心字段，可以使用 `Map<String, Object> extraProperties` 来接收客户端发送的但服务端尚未明确定义的字段。
    *   Api 响应中包含 `schemaVersion`，客户端检查版本。
    
2.  **表结构迁移**:
    *   客户端 (SQLite) 使用 Prisma 迁移。
    *   服务端 (MariaDB) 使用 Flyway 或 Liquibase 管理数据库版本。

3.  **健壮性设计**:
    *   **事务性**: Push 接口应在一个事务中处理所有变更。
    *   **分批传输**: 大量数据应分批 (Batch) 调用 Push/Pull 接口。

## 6. 项目结构 (Project Structure)

```text
d:/aiproject/novalEditor/
├── apps/
│   ├── desktop/
│   │   └── src/components/LexicalEditor/  # Lexical 编辑器
│   └── backend/           # Java Spring Boot Project
│       ├── src/main/java/com/noveleditor/
│       │   ├── controller/ # SyncController, AuthController
│       │   ├── service/    # SyncService
│       │   ├── entity/     # JPA Entities (Novel, Chapter...)
│       │   └── repository/ # Spring Data JPA
│       ├── pom.xml         # Maven build
│       └── application.yml
├── packages/
│   └── core/              # Prisma Schema & Shared Types
└── SyncDesign.md          # 本文档
```
