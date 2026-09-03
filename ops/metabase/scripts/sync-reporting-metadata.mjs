const baseUrl = process.env.METABASE_URL?.trim().replace(/\/+$/, "");
const databaseId = Number(process.env.METABASE_DATABASE_ID ?? "2");
const adminEmail = process.env.METABASE_ADMIN_EMAIL?.trim();
const adminPassword = process.env.METABASE_ADMIN_PASSWORD;

if (!baseUrl || !adminEmail || !adminPassword || !Number.isInteger(databaseId)) {
  throw new Error(
    "必须配置 METABASE_URL、METABASE_DATABASE_ID、METABASE_ADMIN_EMAIL 和 METABASE_ADMIN_PASSWORD。",
  );
}

const tableDescriptions = {
  users:
    "应用观察到的用户作用域。user_id 可直接显示 user-example 等标识；姓名、邮箱和部门在接入可信身份系统前为空。",
  reporting_database_tables:
    "数据库基础表目录：展示表总数、每张表的领域、用途和查询时的精确行数。",
  reporting_user_assets:
    "用户与素材报表：一行对应一个用户和一个素材，同时展示用户汇总、素材明细及父视频切片统计。",
};

const fieldDescriptions = {
  users: {
    user_id:
      "用户作用域的大小写敏感稳定标识，例如 user-example；当前来自 API/MCP 请求，并不等同于已认证身份。",
    display_name: "用户展示名称；当前没有可信数据来源，因此允许为空。",
    email: "用户邮箱；当前没有可信数据来源，因此允许为空。",
    department: "用户所属部门；当前没有可信数据来源，因此允许为空。",
    first_seen_at: "数据库第一次观察到该 user_id 的 UTC 时间。",
    last_seen_at: "最近一次携带该 user_id 创建业务任务的 UTC 时间。",
    created_at: "users 登记记录创建时间（UTC）。",
    updated_at: "users 登记记录最后更新时间（UTC）。",
  },
  video_sources: {
    generated_segment_count:
      "父视频首次成功持久化时生成的切片总数；不会随子素材删除或临时任务明细清理而下降。",
  },
  reporting_database_tables: {
    base_table_count: "当前 assets_library schema 中基础表总数；视图不计入。",
    table_name: "基础表名称。",
    domain: "表所属业务领域，例如用户、素材核心、媒体存储或异步任务。",
    description: "该基础表的业务用途。",
    row_count: "打开报表时通过 COUNT(*) 得到的精确行数，不是估算值。",
    calculated_at: "本次实时统计的 UTC 时间。",
  },
  reporting_user_assets: {
    user_id:
      "可搜索的用户作用域标识，例如 user-example；同一用户的多条素材会重复显示该值。",
    display_name: "用户展示名称；当前未接入身份资料时为空。",
    email: "用户邮箱；当前未接入身份资料时为空。",
    department: "用户部门；当前未接入身份资料时为空。",
    first_seen_at: "第一次观察到该用户作用域的 UTC 时间。",
    last_seen_at: "该用户最近创建业务任务的 UTC 时间。",
    task_count: "该用户历史任务总数。",
    done_task_count: "该用户状态为 done 的任务数。",
    failed_task_count: "该用户状态为 failed 的任务数。",
    total_asset_records:
      "该用户全部素材记录数，包含 review_status=deleted 的记录。",
    active_asset_count: "该用户当前未删除素材数。",
    deleted_asset_count: "该用户 review_status=deleted 的素材记录数。",
    image_asset_count: "该用户当前未删除图片素材数。",
    video_slice_count: "该用户当前未删除视频切片素材数；不是父视频文件数。",
    parent_video_count: "该用户当前有效视频素材涉及的不同父视频数。",
    total_storage_bytes:
      "该用户当前有效素材的已持久化主体文件与视频缩略图总字节数，不含完整父视频。",
    asset_id: "素材 UUID；用户没有素材时为空。",
    asset_name: "素材展示名称。",
    asset_description: "素材内容描述，用于浏览和检索。",
    media_type: "素材类型：image 为图片，video 为父视频切出的子视频。",
    processing_status:
      "素材处理状态：queued、validating、analyzing、completed 或 failed。",
    review_status: "素材审核状态：pending_review、published 或 deleted。",
    original_filename:
      "该素材记录保存的原始文件名；视频切片通常为生成的 segment 文件名。",
    mime_type: "素材 MIME 类型。",
    asset_size_bytes: "素材记录声明的主体文件大小，单位字节。",
    stored_media_bytes:
      "当前 persisted 主体媒体对象的实际字节数；对象缺失或非 persisted 时为 0。",
    thumbnail_bytes: "视频首帧缩略图的实际字节数；图片或缩略图缺失时为 0。",
    asset_created_at: "素材创建时间（UTC）。",
    asset_updated_at: "素材最后更新时间（UTC）。",
    asset_deleted_at: "素材逻辑删除时间；未删除时为空。",
    tag_count: "素材当前关联标签数量。",
    tags: "素材标签的 category:value 逗号分隔列表。",
    parent_video_id: "视频切片所属完整父视频 UUID；图片为空。",
    parent_video_filename: "完整父视频上传时的原始文件名。",
    parent_video_duration_ms: "完整父视频时长，单位毫秒。",
    parent_video_size_bytes: "完整父视频文件大小，单位字节。",
    parent_video_status: "父视频处理状态：queued、running、done 或 failed。",
    generated_segment_count:
      "父视频首次成功持久化时生成的历史切片总数，不随删除下降。",
    current_asset_segment_count:
      "该父视频目前仍保留在 private_assets 表中的切片记录数，包含逻辑删除记录。",
    active_asset_segment_count: "该父视频当前未删除的切片素材数。",
  },
};

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let sessionId;

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-metabase-session": sessionId } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`,
    );
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function activeTables(metadata) {
  return new Map(
    metadata.tables
      .filter((table) => table.active)
      .map((table) => [table.name, table]),
  );
}

function schemaReady(metadata) {
  const tables = activeTables(metadata);
  return (
    tables.get("users")?.fields.filter((field) => field.active).length >= 8 &&
    tables
      .get("reporting_database_tables")
      ?.fields.filter((field) => field.active).length >= 6 &&
    tables
      .get("reporting_user_assets")
      ?.fields.filter((field) => field.active).length >= 40 &&
    tables
      .get("video_sources")
      ?.fields.some(
        (field) => field.active && field.name === "generated_segment_count",
      )
  );
}

async function waitForSchema() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const metadata = await api(`/api/database/${databaseId}/metadata`);
    if (schemaReady(metadata)) return metadata;
    await sleep(2_000);
  }
  throw new Error("等待 Metabase schema 同步超时。");
}

async function updateDescriptions(metadata) {
  const tables = activeTables(metadata);
  let updatedTables = 0;
  let updatedFields = 0;

  for (const [tableName, description] of Object.entries(tableDescriptions)) {
    const table = tables.get(tableName);
    if (!table) throw new Error(`Metabase 缺少表/视图 ${tableName}`);
    await api(`/api/table/${table.id}`, {
      method: "PUT",
      body: JSON.stringify({ description }),
    });
    updatedTables += 1;
  }

  for (const [tableName, descriptions] of Object.entries(fieldDescriptions)) {
    const table = tables.get(tableName);
    if (!table) throw new Error(`Metabase 缺少表/视图 ${tableName}`);
    const fields = new Map(
      table.fields
        .filter((field) => field.active)
        .map((field) => [field.name, field]),
    );
    for (const [fieldName, description] of Object.entries(descriptions)) {
      const field = fields.get(fieldName);
      if (!field) throw new Error(`Metabase 缺少字段 ${tableName}.${fieldName}`);
      await api(`/api/field/${field.id}`, {
        method: "PUT",
        body: JSON.stringify({ description }),
      });
      updatedFields += 1;
    }
  }

  return { updatedTables, updatedFields };
}

function verifyDescriptions(metadata) {
  const tables = activeTables(metadata);
  const missing = [];
  for (const [tableName, description] of Object.entries(tableDescriptions)) {
    if (tables.get(tableName)?.description !== description) missing.push(tableName);
  }
  for (const [tableName, descriptions] of Object.entries(fieldDescriptions)) {
    const fields = new Map(
      (tables.get(tableName)?.fields ?? [])
        .filter((field) => field.active)
        .map((field) => [field.name, field]),
    );
    for (const [fieldName, description] of Object.entries(descriptions)) {
      if (fields.get(fieldName)?.description !== description) {
        missing.push(`${tableName}.${fieldName}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(`Metabase 描述回读不一致：${missing.join(", ")}`);
  }
}

try {
  const login = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({ username: adminEmail, password: adminPassword }),
  });
  sessionId = login.id;
  await api(`/api/database/${databaseId}/sync_schema`, { method: "POST" });
  const metadata = await waitForSchema();
  const updated = await updateDescriptions(metadata);
  verifyDescriptions(await api(`/api/database/${databaseId}/metadata`));
  console.log(JSON.stringify({ ...updated, missing: [] }));
} finally {
  if (sessionId) {
    await fetch(`${baseUrl}/api/session`, {
      method: "DELETE",
      headers: { "x-metabase-session": sessionId },
    }).catch(() => undefined);
  }
}
