import { libsqlClient } from "../src/lib/db";

async function test() {
  const dcId = "421587";
  console.log(`Querying post ${dcId} from the database...`);
  try {
    const result = await libsqlClient.execute({
      sql: "SELECT dc_id, category, likes, comments_count, title FROM posts WHERE dc_id = ?",
      args: [dcId]
    });
    console.log("Database Query result:");
    if (result.rows.length === 0) {
      console.log("Post not found in database!");
    } else {
      console.log(JSON.stringify(result.rows[0], null, 2));
    }
  } catch (err: any) {
    console.error("DB Query failed:", err.message);
  }
}

test();
