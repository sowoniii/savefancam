import React from "react";
import NextLink from "next/link";
import { dbApi } from "@/lib/db";
import { notFound } from "next/navigation";
import CaptureButton from "@/components/CaptureButton";

// Enable full static caching. The page will be cached permanently on the first hit,
// and regenerated instantly on-demand via revalidatePath when a new archive is requested!
export const revalidate = false;

type DcComment = {
  author: string;
  date: string;
  ip?: string;
  isReply?: boolean;
  text: string;
};

const renderCommentText = (text: string) => {
  if (!text) return null;

  // Match mentions (Group 1) or URLs (Group 2)
  const combinedRegex = /(@(?:글쓴 익명|익명\s?\d+|글쓴이|[a-zA-Z0-9가-힣_]+))|(https?:\/\/[^\s]+)/g;

  return text.split('\n').map((line: string, lineIdx: number, arr: string[]) => {
    const parts = [];
    let lastIndex = 0;
    let match;

    // Reset regex state for each line
    combinedRegex.lastIndex = 0;

    while ((match = combinedRegex.exec(line)) !== null) {
      const matchIndex = match.index;
      const matchText = match[0];

      if (matchIndex > lastIndex) {
        parts.push(line.substring(lastIndex, matchIndex));
      }

      if (match[1]) {
        // Highlighted mention tag
        parts.push(
          <span key={matchIndex} className="mention">
            {matchText}
          </span>
        );
      } else if (match[2]) {
        // Clickable URL with royal blue highlight color
        parts.push(
          <a key={matchIndex} href={match[2]} target="_blank" rel="noopener noreferrer" className="comment-lnk">
            {matchText}
          </a>
        );
      }

      lastIndex = combinedRegex.lastIndex;
    }

    if (lastIndex < line.length) {
      parts.push(line.substring(lastIndex));
    }

    return (
      <React.Fragment key={lineIdx}>
        {parts}
        {lineIdx !== arr.length - 1 && <br />}
      </React.Fragment>
    );
  });
};

const prioritizeFirstContentImage = (html: string) => {
  let firstImageFound = false;

  return html.replace(/<img\b[^>]*>/i, (tag) => {
    if (firstImageFound) return tag;

    firstImageFound = true;
    const withoutLazy = tag
      .replace(/\sloading=(["'])lazy\1/i, "")
      .replace(/\sfetchpriority=(["'])(?:auto|low)\1/i, "");

    const withDecoding = /\sdecoding=/i.test(withoutLazy)
      ? withoutLazy
      : withoutLazy.replace(/>$/, ' decoding="async">');

    return /\sfetchpriority=/i.test(withDecoding)
      ? withDecoding
      : withDecoding.replace(/>$/, ' fetchpriority="high">');
  });
};

const getFirstImageSrc = (html: string) => {
  const match = html.match(/<img\b[^>]*\ssrc=(["'])(.*?)\1/i);
  return match?.[2];
};

export default async function PostDetail({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  const post = await dbApi.getPostByDcId(resolvedParams.id);

  if (!post) {
    notFound();
  }

  const firstImageSrc = getFirstImageSrc(post.content_html);
  const contentHtml = prioritizeFirstContentImage(post.content_html);

  return (
    <>
      {firstImageSrc && (
        <link rel="preload" href={firstImageSrc} as="image" fetchPriority="high" />
      )}

      <section className="grid gall-tit-group" id="viewtop">
        <div className="gall-tit-box">
          <NextLink href="/" className="gall-tit-lnkempty"></NextLink>
          <h3 className="gall-tit">
            <NextLink href="/" className="gall-tit-lnk">팬갤 아카이브</NextLink>
          </h3>
          <span className="mngall-tit"><span className="mnicon"><em>n</em></span></span>
          <div className="rt">
            <div className="gall-lnk-box">
              <CaptureButton title={post.title} postId={resolvedParams.id} />
            </div>
          </div>
        </div>
      </section>

      {/* Post Wrapper */}
      <section className="grid" id="post_content_wrapper">
        <div className="gallview-tit-box">
          <span className="tit">
            {post.category ? `[${post.category}] ` : '[일반] '}
            {`${post.title} `}
            {post.is_mobile_written && <span className="sp-icon sp-app"></span>}
          </span>
          <div className="btm">
            <ul className="ginfo2">
              <li>
                <div className="ginfo-area">
                  <span className="nick">{post.author}</span>
                  {post.author_ip && <span className="ip">({post.author_ip})</span>}
                </div>
              </li>
              <li>{post.date}</li>
            </ul>
            <div className="rt">
              <button type="button" className="btn-scrap"><em className="blind">스크랩</em></button>
            </div>
          </div>
        </div>

        <div className="gall-thum-btm">
          <div className="gall-thum-btm-inner">
            <ul className="ginfo2">
              <li>조회수 {post.views}</li>
              <li>추천 <span>{post.likes}</span></li>
              <li><a href="#comment_box" className="btn-commentgo">댓글 <span className="point-red">{post.comments_count}</span></a></li>
            </ul>
            <div className="thum-txt">
              <div className="thum-txtin" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: contentHtml }}></div>
            </div>
            <br />
            <br />
            <br />
            {/* COMMENTS */}
            <div id="comment_box" className="all-comment">
              <div className="all-comment-tit flex">
                <div className="tit-box">
                  <a href="#" className="tit">댓글<span className="ct">[{post.comments_count}]</span><span className="sp-reload">새로고침</span></a>
                </div>
                <div className="rt">
                  <div className="box"><a href="#viewtop" className="veiw-top">본문</a></div>
                  <div className="sel-box">
                    <label>등록순</label>
                    <select className="sel">
                      <option value="default">등록순</option>
                      <option value="new">최신순</option>
                      <option value="reply">답글순</option>
                    </select>
                  </div>
                </div>
              </div>

              {(() => {
                let comments = [];
                try { comments = post.comments_json ? JSON.parse(post.comments_json) : []; } catch { }

                if (comments.length === 0) return null;

                return (
                  <ul className="all-comment-lst">
                    {comments.map((cmt: DcComment, idx: number) => (
                      <li key={idx} className={cmt.isReply ? "comment comment-add" : "comment"}>
                        {cmt.isReply && <span className="sp-reply"></span>}
                        <div className="ginfo-area">
                          <button type="button" className="nick">{cmt.author}</button>
                          {cmt.ip && <span className="ip blockCommentIp">({cmt.ip})</span>}
                        </div>
                        <p className="txt">
                          {renderCommentText(cmt.text)}
                        </p>
                        <span className="date">{cmt.date}</span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
