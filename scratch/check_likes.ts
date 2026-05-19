import { libsqlClient } from "../src/lib/db";

async function test() {
  const dcId = "421587";
  try {
    const result = await libsqlClient.execute({
      sql: "SELECT dc_id, category, likes, comments_count, title FROM posts WHERE dc_id = ?",
      args: [dcId]
    });
    console.log("Current post state in database:", JSON.stringify(result.rows[0], null, 2));
  } catch (err: any) {
    console.error("DB Query failed:", err.message);
  }
}

test();
