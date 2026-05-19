import { libsqlClient } from "../src/lib/db";

async function test() {
  console.log("Querying posts from the database...");
  try {
    const result = await libsqlClient.execute("SELECT dc_id, category, likes, comments_count, title FROM posts LIMIT 10");
    console.log(`Total posts found: ${result.rows.length}`);
    for (const row of result.rows) {
      console.log({
        dc_id: row.dc_id,
        title: row.title,
        category: row.category,
        likes: row.likes,
        comments_count: row.comments_count
      });
    }
  } catch (err: any) {
    console.error("DB Query failed:", err.message);
  }
}

test();
