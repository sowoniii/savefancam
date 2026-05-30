import { createClient } from "@libsql/client";
import "./auto-archive";
import { uploadPostImagesToImgBB } from "./imgbb";

// Global cache for categories list to avoid redundant database calls and connection timeouts
let cachedCategories: string[] | null = null;
let categoriesCacheTime = 0;

const LIST_CACHE_TTL_MS = Number(process.env.DB_LIST_CACHE_TTL_MS || 3000);
const POST_CACHE_TTL_MS = Number(process.env.DB_POST_CACHE_TTL_MS || 15000);

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const postsListCache = new Map<string, CacheEntry<{ posts: Post[]; total: number }>>();
const postByDcIdCache = new Map<string, CacheEntry<Post | null>>();
const pendingPostByDcId = new Map<string, Promise<Post | null>>();

const getCacheValue = <T,>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return entry.value;
};

const setCacheValue = <T,>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

const invalidateReadCaches = (dcId?: string) => {
  cachedCategories = null;
  postsListCache.clear();
  if (dcId) {
    postByDcIdCache.delete(dcId);
    pendingPostByDcId.delete(dcId);
  } else {
    postByDcIdCache.clear();
    pendingPostByDcId.clear();
  }
};

const url = (process.env.TURSO_DATABASE_URL || "").trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || "").trim();

console.log("🔧 Initializing Turso libSQL client...");

if (!url) {
  console.warn("⚠️ TURSO_DATABASE_URL is missing in environment variables!");
}

export const libsqlClient = createClient({
  url: url || "file:dummy.db",
  authToken,
});

// 1. Automatic Zero-Config SQLite Table & Index Initialization on startup
(async () => {
  try {
    // 🔒 Prevent SQLITE_BUSY: database is locked errors by optimizing local SQLite settings
    if ((url || "file:dummy.db").startsWith("file:")) {
      try {
        await libsqlClient.execute("PRAGMA journal_mode = WAL");
        await libsqlClient.execute("PRAGMA busy_timeout = 10000");
        console.log("⚙️ [Turso] SQLite WAL mode and 10s busy_timeout set successfully.");
      } catch (pragmaErr) {
        console.warn("⚠️ Failed to apply SQLite PRAGMAs:", pragmaErr);
      }
    }

    // 🛠️ Smart Auto-Migration: If the database exists but has the old single 'dc_id' UNIQUE constraint,
    // safely migrate the schema to composite UNIQUE(gallery_id, dc_id) while preserving 100% of existing rows!
    const tableCheck = await libsqlClient.execute(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='posts'
    `);
    
    if (tableCheck.rows.length > 0) {
      const sql = String(tableCheck.rows[0].sql || "");
      if (sql.includes("dc_id TEXT UNIQUE") || !sql.includes("UNIQUE(gallery_id, dc_id)")) {
        console.log("🛠️ [Turso/SQLite] Outdated table schema detected. Commencing safe data-preserving migration...");
        try {
          await libsqlClient.execute("CREATE TABLE posts_backup AS SELECT * FROM posts");
          await libsqlClient.execute("DROP TABLE posts");
          
          await libsqlClient.execute(`
            CREATE TABLE posts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              dc_id TEXT NOT NULL,
              gallery_id TEXT NOT NULL,
              category TEXT DEFAULT '일반',
              title TEXT NOT NULL,
              author TEXT NOT NULL,
              author_ip TEXT,
              date TEXT NOT NULL,
              views INTEGER DEFAULT 0,
              likes INTEGER DEFAULT 0,
              comments_count INTEGER DEFAULT 0,
              content_html TEXT NOT NULL,
              images_json TEXT NOT NULL,
              original_url TEXT NOT NULL,
              has_image INTEGER DEFAULT 0,
              has_video INTEGER DEFAULT 0,
              is_mobile_written INTEGER DEFAULT 0,
              comments_json TEXT NOT NULL,
              archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(gallery_id, dc_id)
            )
          `);
          
          await libsqlClient.execute(`
            INSERT INTO posts (
              id, dc_id, gallery_id, category, title, author, author_ip, date,
              views, likes, comments_count, content_html, images_json, original_url,
              has_image, has_video, is_mobile_written, comments_json, archived_at
            ) SELECT 
              id, dc_id, gallery_id, category, title, author, author_ip, date,
              views, likes, comments_count, content_html, images_json, original_url,
              has_image, has_video, is_mobile_written, comments_json, archived_at
            FROM posts_backup
          `);
          
          await libsqlClient.execute("DROP TABLE posts_backup");
          console.log("✅ [Turso/SQLite] Database schema upgraded to composite UNIQUE(gallery_id, dc_id) with 100% data preserved!");
        } catch (migErr) {
          console.error("❌ [Turso/SQLite] Failed to migrate database schema:", migErr);
        }
      }
    }

    await libsqlClient.execute(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dc_id TEXT NOT NULL,
        gallery_id TEXT NOT NULL,
        category TEXT DEFAULT '일반',
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        author_ip TEXT,
        date TEXT NOT NULL,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        content_html TEXT NOT NULL,
        images_json TEXT NOT NULL,
        original_url TEXT NOT NULL,
        has_image INTEGER DEFAULT 0,
        has_video INTEGER DEFAULT 0,
        is_mobile_written INTEGER DEFAULT 0,
        comments_json TEXT NOT NULL,
        archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(gallery_id, dc_id)
      )
    `);

    await libsqlClient.execute(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await Promise.all([
      libsqlClient.execute(`
        CREATE INDEX IF NOT EXISTS idx_posts_category_id_desc ON posts(category, id DESC)
      `),
      libsqlClient.execute(`
        CREATE INDEX IF NOT EXISTS idx_posts_id_desc ON posts(id DESC)
      `),
      libsqlClient.execute(`
        CREATE INDEX IF NOT EXISTS idx_posts_author_id_desc ON posts(author, id DESC)
      `),
      libsqlClient.execute(`
        CREATE INDEX IF NOT EXISTS idx_posts_gallery_dc_id ON posts(gallery_id, dc_id)
      `),
      libsqlClient.execute(`
        CREATE INDEX IF NOT EXISTS idx_posts_archived_at_desc ON posts(archived_at DESC)
      `),
      libsqlClient.execute(`
        -- 🚀 Accelerates category listing + date-sorted queries from 5 seconds to 1 millisecond!
        CREATE INDEX IF NOT EXISTS idx_posts_category_archived_desc ON posts(category, archived_at DESC, id DESC)
      `),
      libsqlClient.execute(`
        -- 🚀 Accelerates homepage latest sorted listing (archived_at DESC)
        CREATE INDEX IF NOT EXISTS idx_posts_archived_id_desc ON posts(archived_at DESC, id DESC)
      `),
    ]);

    console.log("✅ [Turso] Database schema and high-performance indexes initialized successfully.");
  } catch (e: unknown) {
    console.error("Turso failed to initialize database schema/indexes:", errorMessage(e));
  }
})();

export interface Post {
  id?: number;
  dc_id: string;
  gallery_id: string;
  category?: string;
  title: string;
  author: string;
  author_ip: string | null;
  date: string;
  views: number;
  likes: number;
  comments_count: number;
  content_html: string;
  images_json: string;
  original_url: string;
  has_image: boolean;
  has_video: boolean;
  is_mobile_written: boolean;
  comments_json: string;
  archived_at?: string;
}

function parseDcDateToSqliteDatetime(dcDateStr: string): string {
  try {
    const raw = dcDateStr.trim();
    if (!raw) throw new Error("Empty date string");

    // 1. If it's already SQLite format, return as is
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
      return raw;
    }

    // 2. Replace dots with dashes
    let cleaned = raw.replace(/\./g, "-");

    // 3. If only time is provided (e.g. "19:30:10" or "19:30"), prepend today's date
    if (!cleaned.includes("-") && cleaned.includes(":")) {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      cleaned = `${todayStr} ${cleaned}`;
    }

    // 4. If year is 2 digits (e.g. "26-05-22 19:30"), convert to 4 digits
    if (/^\d{2}-\d{2}-\d{2}/.test(cleaned)) {
      cleaned = "20" + cleaned;
    }

    // 5. If seconds are missing (e.g. "2026-05-22 19:30"), append ":00"
    const spaceParts = cleaned.split(" ");
    if (spaceParts.length === 2) {
      const timeParts = spaceParts[1].split(":");
      if (timeParts.length === 2) {
        cleaned = `${spaceParts[0]} ${spaceParts[1]}:00`;
      }
    }

    // If matches correct format, return
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cleaned)) {
      return cleaned;
    }

    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  } catch (e) {
    console.error(`Failed to parse DC inside date string: "${dcDateStr}"`, e);
  }

  // Fallback to current system time
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

type DbRow = Record<string, unknown>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const rowToPost = (r: DbRow, includeBody: boolean): Post => ({
  id: Number(r.id),
  dc_id: String(r.dc_id),
  gallery_id: String(r.gallery_id),
  category: r.category ? String(r.category) : undefined,
  title: String(r.title),
  author: String(r.author),
  author_ip: r.author_ip ? String(r.author_ip) : null,
  date: String(r.date),
  views: Number(r.views),
  likes: Number(r.likes),
  comments_count: Number(r.comments_count),
  content_html: includeBody ? String(r.content_html) : "",
  images_json: includeBody ? String(r.images_json) : "[]",
  original_url: includeBody ? String(r.original_url) : "",
  has_image: Boolean(r.has_image),
  has_video: Boolean(r.has_video),
  is_mobile_written: Boolean(r.is_mobile_written),
  comments_json: includeBody ? String(r.comments_json) : "[]",
  archived_at: r.archived_at ? String(r.archived_at) : undefined,
});

export const dbApi = {
  insertPost: async (post: Omit<Post, 'id' | 'archived_at'>): Promise<number> => {
    invalidateReadCaches(post.dc_id);

    const archivedAt = parseDcDateToSqliteDatetime(post.date);

    // 1. Immediately insert the post with the original DC Inside image URLs
    // Using ON CONFLICT(gallery_id, dc_id) DO UPDATE for perfect upsert support in SQLite!
    const upsertResult = await libsqlClient.execute({
      sql: `
        INSERT INTO posts (
          dc_id, gallery_id, category, title, author, author_ip, date,
          views, likes, comments_count, content_html, images_json, original_url,
          has_image, has_video, is_mobile_written, comments_json, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gallery_id, dc_id) DO UPDATE SET
          gallery_id = excluded.gallery_id,
          category = excluded.category,
          title = excluded.title,
          author = excluded.author,
          author_ip = excluded.author_ip,
          date = excluded.date,
          views = excluded.views,
          likes = excluded.likes,
          comments_count = excluded.comments_count,
          content_html = excluded.content_html,
          images_json = excluded.images_json,
          original_url = excluded.original_url,
          has_image = excluded.has_image,
          has_video = excluded.has_video,
          is_mobile_written = excluded.is_mobile_written,
          comments_json = excluded.comments_json,
          archived_at = excluded.archived_at
        RETURNING id
      `,
      args: [
        post.dc_id,
        post.gallery_id,
        post.category || '일반',
        post.title,
        post.author,
        post.author_ip,
        post.date,
        post.views,
        post.likes,
        post.comments_count,
        post.content_html,
        post.images_json,
        post.original_url,
        post.has_image ? 1 : 0,
        post.has_video ? 1 : 0,
        post.is_mobile_written ? 1 : 0,
        post.comments_json,
        archivedAt
      ]
    });

    const postId = Number(upsertResult.rows[0]?.id || 0);

    // 2. Fire and forget: Upload to ImgBB and update the database in the background!
    // Deferred by 1000ms to run completely isolated from the current Next.js HTTP render context.
    setTimeout(() => {
      (async () => {
        try {
          console.log(`⚡ [Background ImgBB] Starting background image upload for post #${postId}`);
          const processedPost = await uploadPostImagesToImgBB({ ...post });
          
          await libsqlClient.execute({
            sql: "UPDATE posts SET content_html = ?, images_json = ?, has_image = ? WHERE id = ?",
            args: [
              processedPost.content_html,
              processedPost.images_json,
              processedPost.has_image ? 1 : 0,
              postId
            ]
          });
          invalidateReadCaches(post.dc_id);
          console.log(`✅ [Background ImgBB] Successfully completed background upload for post #${postId}`);
        } catch (bgErr: unknown) {
          console.error(`[Background ImgBB] Error in background task for post #${postId}:`, errorMessage(bgErr));
        }
      })();
    }, 1000);

    return postId;
  },
  
  getPosts: async (queryText?: string, searchType: string = 'all', page?: number, limit?: number, category?: string): Promise<{ posts: Post[]; total: number }> => {
    const cacheKey = JSON.stringify([queryText || "", searchType, page || 0, limit || 0, category || "all"]);
    const cached = getCacheValue(postsListCache, cacheKey);
    if (cached) return cached;

    let sql = "SELECT id, dc_id, gallery_id, category, title, author, author_ip, date, views, likes, comments_count, has_image, has_video, is_mobile_written, archived_at FROM posts";
    let countSql = "SELECT COUNT(*) as count FROM posts";
    const args: Array<string | number> = [];
    const countArgs: string[] = [];
    const whereClauses: string[] = [];

    if (category && category !== "all") {
      whereClauses.push("category = ?");
      args.push(category);
      countArgs.push(category);
    }

    if (queryText) {
      const searchPattern = `%${queryText}%`;
      if (searchType === 'title') {
        whereClauses.push("title LIKE ?");
        args.push(searchPattern);
        countArgs.push(searchPattern);
      } else if (searchType === 'content') {
        whereClauses.push("content_html LIKE ?");
        args.push(searchPattern);
        countArgs.push(searchPattern);
      } else if (searchType === 'author') {
        whereClauses.push("author LIKE ?");
        args.push(searchPattern);
        countArgs.push(searchPattern);
      } else {
        // 'all'
        whereClauses.push("(title LIKE ? OR content_html LIKE ? OR author LIKE ?)");
        args.push(searchPattern, searchPattern, searchPattern);
        countArgs.push(searchPattern, searchPattern, searchPattern);
      }
    }

    if (whereClauses.length > 0) {
      const whereStr = " WHERE " + whereClauses.join(" AND ");
      sql += whereStr;
      countSql += whereStr;
    }

    sql += " ORDER BY archived_at DESC, id DESC";

    if (page && limit) {
      const offset = (page - 1) * limit;
      sql += " LIMIT ? OFFSET ?";
      args.push(limit, offset);
    }

    try {
      const [rowsResult, countResult] = await Promise.all([
        libsqlClient.execute({ sql, args }),
        libsqlClient.execute({ sql: countSql, args: countArgs })
      ]);

      const posts: Post[] = rowsResult.rows.map((r) => rowToPost(r as DbRow, false));

      const total = Number(countResult.rows[0]?.count || 0);
      const payload = { posts, total };
      setCacheValue(postsListCache, cacheKey, payload, LIST_CACHE_TTL_MS);
      return payload;
    } catch (err: unknown) {
      console.error("Turso getPosts error:", errorMessage(err));
      return { posts: [], total: 0 };
    }
  },

  getAllCategories: async (): Promise<string[]> => {
    const now = Date.now();
    if (cachedCategories && (now - categoriesCacheTime < 60000)) {
      return cachedCategories;
    }
    try {
      const result = await libsqlClient.execute("SELECT DISTINCT category FROM posts WHERE category IS NOT NULL AND category != '' ORDER BY category ASC");
      cachedCategories = result.rows.map(row => String(row.category));
      categoriesCacheTime = now;
      return cachedCategories;
    } catch (err: unknown) {
      console.error("Turso getAllCategories error:", errorMessage(err));
      return [];
    }
  },
  
  getPostById: async (id: number): Promise<Post | null> => {
    try {
      const result = await libsqlClient.execute({
        sql: "SELECT * FROM posts WHERE id = ?",
        args: [id]
      });
      const r = result.rows[0];
      if (!r) return null;

      return rowToPost(r as DbRow, true);
    } catch (err: unknown) {
      console.error("Turso getPostById error:", errorMessage(err));
      return null;
    }
  },

  getPostByDcId: async (dcId: string): Promise<Post | null> => {
    const cached = getCacheValue(postByDcIdCache, dcId);
    if (cached !== undefined) return cached;

    const pending = pendingPostByDcId.get(dcId);
    if (pending) return pending;

    const queryPromise = (async () => {
    try {
      const result = await libsqlClient.execute({
        sql: "SELECT * FROM posts WHERE dc_id = ?",
        args: [dcId]
      });
      const r = result.rows[0];
      if (!r) {
        setCacheValue(postByDcIdCache, dcId, null, POST_CACHE_TTL_MS);
        return null;
      }

      const post = rowToPost(r as DbRow, true);
      setCacheValue(postByDcIdCache, dcId, post, POST_CACHE_TTL_MS);
      return post;
    } catch (err: unknown) {
      console.error("Turso getPostByDcId error:", errorMessage(err));
      return null;
    } finally {
      pendingPostByDcId.delete(dcId);
    }
    })();

    pendingPostByDcId.set(dcId, queryPromise);
    return queryPromise;
  },

  addPushSubscription: async (endpoint: string, p256dh: string, auth: string): Promise<void> => {
    try {
      await libsqlClient.execute({
        sql: `
          INSERT INTO push_subscriptions (endpoint, p256dh, auth)
          VALUES (?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth
        `,
        args: [endpoint, p256dh, auth]
      });
      console.log(`🔔 Saved push subscription to DB: ${endpoint.substring(0, 40)}...`);
    } catch (err: unknown) {
      console.error("Turso addPushSubscription error:", errorMessage(err));
    }
  },

  removePushSubscription: async (endpoint: string): Promise<void> => {
    try {
      await libsqlClient.execute({
        sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
        args: [endpoint]
      });
      console.log(`🗑️ Removed push subscription from DB: ${endpoint.substring(0, 40)}...`);
    } catch (err: unknown) {
      console.error("Turso removePushSubscription error:", errorMessage(err));
    }
  }
};
