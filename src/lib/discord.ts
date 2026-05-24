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
 * 🟢 1. Send Alert when a brand new Literature post is archived!
 */
export async function sendDiscordNewPostAlert(post: Omit<Post, 'id' | 'archived_at'>) {
  const postUrl = `https://fangall.com/post/${post.dc_id}`;
  
  const payload = {
    content: "📢 @here **칭찬갤 문학관에 신작 입고 완료!**",
    embeds: [
      {
        title: "🆕 [칭찬갤 문학관] 신작 문학 등록!",
        description: `✍️ **따끈따끈한 새로운 문학 게시글이 수집되었습니다!**\n\n[지금 즉시 최초 감상하기 ➡️](${postUrl})`,
        url: postUrl,
        color: 3066993, // Emerald Green (#2ecc71)
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
            name: "📅 등록시간",
            value: post.date,
            inline: true
          }
        ],
        footer: {
          text: "칭찬 미니 갤러리 영구 아카이브 시스템",
          icon_url: "https://nstatic.dcinside.com/dgn/gallery/images/broken_image.png"
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  await sendWebhook(payload);
}

/**
 * 🔵 2. Send Milestone Alert when a Literature post hits 10, 20, 30... likes!
 */
export async function sendDiscordMilestoneAlert(post: Omit<Post, 'id' | 'archived_at'>, oldLikes: number, milestone: number) {
  const postUrl = `https://fangall.com/post/${post.dc_id}`;
  
  const payload = {
    content: `📢 @here **문학 명작 탄생! 개추 돌파 축하합니다!**`,
    embeds: [
      {
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
        timestamp: new Date().toISOString()
      }
    ]
  };

  await sendWebhook(payload);
}
