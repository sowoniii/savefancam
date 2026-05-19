import { createClient } from "@libsql/client";
import "./auto-archive";
import { uploadPostImagesToImgBB } from "./imgbb";

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
    await libsqlClient.execute(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dc_id TEXT UNIQUE NOT NULL,
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
        archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create high-performance indexes to guarantee sub-millisecond query execution speeds
    await libsqlClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_category_id_desc ON posts(category, id DESC)
    `);
    await libsqlClient.execute(`
      CREATE INDEX IF NOT EXISTS idx_posts_id_desc ON posts(id DESC)
    `);

    console.log("✅ [Turso] Database schema and high-performance indexes initialized successfully.");
  } catch (e: any) {
    console.error("❌ [Turso] Failed to initialize database schema/indexes:", e.message);
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

export const dbApi = {
  insertPost: async (post: Omit<Post, 'id' | 'archived_at'>): Promise<number> => {
    // 1. Immediately insert the post with the original DC Inside image URLs
    // Using ON CONFLICT(dc_id) DO UPDATE for perfect upsert support in SQLite!
    await libsqlClient.execute({
      sql: `
        INSERT INTO posts (
          dc_id, gallery_id, category, title, author, author_ip, date,
          views, likes, comments_count, content_html, images_json, original_url,
          has_image, has_video, is_mobile_written, comments_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dc_id) DO UPDATE SET
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
          comments_json = excluded.comments_json
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
        post.comments_json
      ]
    });

    // Retrieve the row ID
    const selectResult = await libsqlClient.execute({
      sql: "SELECT id FROM posts WHERE dc_id = ?",
      args: [post.dc_id]
    });
    const postId = Number(selectResult.rows[0]?.id || 0);

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
          console.log(`✅ [Background ImgBB] Successfully completed background upload for post #${postId}`);
        } catch (bgErr: any) {
          console.error(`❌ [Background ImgBB] Error in background task for post #${postId}:`, bgErr.message);
        }
      })();
    }, 1000);

    return postId;
  },
  
  getPosts: async (queryText?: string, searchType: string = 'all', page?: number, limit?: number, category?: string): Promise<{ posts: Post[]; total: number }> => {
    let sql = "SELECT * FROM posts";
    let countSql = "SELECT COUNT(*) as count FROM posts";
    const args: any[] = [];
    const countArgs: any[] = [];
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

    sql += " ORDER BY id DESC";

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

      const posts: Post[] = rowsResult.rows.map((r: any) => ({
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
        content_html: String(r.content_html),
        images_json: String(r.images_json),
        original_url: String(r.original_url),
        has_image: Boolean(r.has_image),
        has_video: Boolean(r.has_video),
        is_mobile_written: Boolean(r.is_mobile_written),
        comments_json: String(r.comments_json),
        archived_at: r.archived_at ? String(r.archived_at) : undefined,
      }));

      const total = Number(countResult.rows[0]?.count || 0);
      return { posts, total };
    } catch (err: any) {
      console.error("Turso getPosts error:", err.message);
      return { posts: [], total: 0 };
    }
  },

  getAllCategories: async (): Promise<string[]> => {
    try {
      const result = await libsqlClient.execute("SELECT DISTINCT category FROM posts WHERE category IS NOT NULL AND category != '' ORDER BY category ASC");
      return result.rows.map(row => String(row.category));
    } catch (err: any) {
      console.error("Turso getAllCategories error:", err.message);
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

      return {
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
        content_html: String(r.content_html),
        images_json: String(r.images_json),
        original_url: String(r.original_url),
        has_image: Boolean(r.has_image),
        has_video: Boolean(r.has_video),
        is_mobile_written: Boolean(r.is_mobile_written),
        comments_json: String(r.comments_json),
        archived_at: r.archived_at ? String(r.archived_at) : undefined,
      };
    } catch (err: any) {
      console.error("Turso getPostById error:", err.message);
      return null;
    }
  },

  getPostByDcId: async (dcId: string): Promise<Post | null> => {
    try {
      const result = await libsqlClient.execute({
        sql: "SELECT * FROM posts WHERE dc_id = ?",
        args: [dcId]
      });
      const r = result.rows[0];
      if (!r) return null;

      return {
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
        content_html: String(r.content_html),
        images_json: String(r.images_json),
        original_url: String(r.original_url),
        has_image: Boolean(r.has_image),
        has_video: Boolean(r.has_video),
        is_mobile_written: Boolean(r.is_mobile_written),
        comments_json: String(r.comments_json),
        archived_at: r.archived_at ? String(r.archived_at) : undefined,
      };
    } catch (err: any) {
      console.error("Turso getPostByDcId error:", err.message);
      return null;
    }
  }
};
