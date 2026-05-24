import type { Post } from "./db";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discordapp.com/api/webhooks/1508139605432467586/volgppniv55x7gYPJTi3ubzAAyvv3XQtZ0Dy8io2yOrQJu2w3KNaCD3szcJTantRlihC";

// 📨 Generic helper to send JSON payload to Discord Webhook
async function sendWebhook(payload: Record<string, any>) {
  if (!WEBHOOK_URL) {
    console.warn("⚠️ [Discord Webhook] DISCORD_WEBHOOK_URL is missing in environment!");
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ [Discord Webhook] Failed to send webhook. Status: ${res.status}, Error: ${errText}`);
    } else {
      console.log("🔔 [Discord Webhook] Successfully dispatched discord notification!");
    }
  } catch (err) {
    console.error("❌ [Discord Webhook] Network error dispatching webhook:", err);
  }
}

/**
 * Helper to extract the first image URL from a post
 */
function getFirstImageUrl(post: Omit<Post, 'id' | 'archived_at'>): string | undefined {
  if (!post.has_image || !post.images_json) return undefined;
  try {
    const images = JSON.parse(post.images_json);
    if (images.length > 0) {
      let url = images[0];
      if (url.startsWith("/")) {
        url = `https://fangall.com${url}`;
      }
      return url;
    }
  } catch (e) {
    // ignore
  }
  return undefined;
}

/**
 * Helper to parse DC Inside date to ISO timestamp for Discord
 */
function getIsoTimestamp(dateStr: string): string {
  try {
    // Assuming KST (+09:00) for DC Inside dates like "2024-05-25 15:30:00"
    const d = new Date(dateStr.replace(" ", "T") + "+09:00");
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (e) {}
  return new Date().toISOString();
}

/**
 * 🟢 1. Send Alert when a brand new Literature post is archived!
 */
export async function sendDiscordNewPostAlert(post: Omit<Post, 'id' | 'archived_at'>) {
  const postUrl = `https://fangall.com/post/${post.dc_id}`;
  const imageUrl = getFirstImageUrl(post);
  
  const embed: any = {
    url: postUrl,
    color: 3066993,
    timestamp: getIsoTimestamp(post.date),
    footer: {
      text: "등록 시간"
    },
    author: {
      name: post.title,
      url: postUrl,
      icon_url: "https://docs-assets.developer.apple.com/published/812eef8fabcc1034de5a2afef8a9d62e/icons-symbols-meaning-add~dark%402x.png"
    }
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
  }

  const payload = {
    content: "📢 @here **New Post**",
    embeds: [embed]
  };

  await sendWebhook(payload);
}

/**
 * 🔵 2. Send Milestone Alert when a Literature post hits 10, 20, 30... likes!
 */
export async function sendDiscordMilestoneAlert(post: Omit<Post, 'id' | 'archived_at'>, oldLikes: number, milestone: number) {
  const postUrl = `https://fangall.com/post/${post.dc_id}`;
  const imageUrl = getFirstImageUrl(post);
  
  const embed: any = {
    title: `🎉 [칭찬갤 문학관] 개추 ${milestone}개 돌파!`,
    description: `🚀 **아카이브에 보관된 문학작품이 개추 \`${milestone}\`개를 넘었습니다!**\n\n[아카이브에서 명작 다시 감상하기 ➡️](${postUrl})`,
    url: postUrl,
    color: 3447003, // Bright Blue (#3498db)
    fields: [
      {
        name: "📖 제목",
        value: `\`${post.title}\``,
        inline: false
      },
      {
        name: "✍️ 작가",
        value: post.author_ip ? `${post.author} (${post.author_ip})` : post.author,
        inline: true
      },
      {
        name: "📊 현재 스펙",
        value: `👍 개추 **${post.likes}개** (이전: ${oldLikes}개)\n💬 댓글 **${post.comments_count}개**\n👁️ 조회수 **${post.views}회**`,
        inline: true
      }
    ],
    footer: {
      text: "칭찬 미니 갤러리 영구 아카이브 시스템",
      icon_url: "https://nstatic.dcinside.com/dgn/gallery/images/broken_image.png"
    },
    timestamp: getIsoTimestamp(post.date)
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
  }

  const payload = {
    content: `📢 @here **문학 명작 탄생! 개추 돌파 축하합니다!**`,
    embeds: [embed]
  };

  await sendWebhook(payload);
}
