
import NextLink from "next/link";
import { dbApi } from "@/lib/db";

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; page?: string }> }) {
  const resolvedSearchParams = await searchParams;
  const q = resolvedSearchParams.q || "";
  const type = resolvedSearchParams.type || "all";
  const page = parseInt(resolvedSearchParams.page || "1") || 1;
  const limit = 20;

  const { posts, total } = await dbApi.getPosts(q, type, page, limit);

  return (
    <>
      <section className="grid gall-tit-group" id="viewtop">
        <div className="gall-tit-box">
          <NextLink href="/" className="gall-tit-lnkempty"></NextLink>
          <h3 className="gall-tit">
            <NextLink href="/" className="gall-tit-lnk">팬갤 아카이브</NextLink>
          </h3>
          <span className="mngall-tit"><span className="mnicon"><em>n</em></span></span>
          <div className="rt">
            <div className="gall-lnk-box">
              <NextLink href="/request" className="btn-write lnk">수동 아카이브</NextLink>
            </div>
          </div>
        </div>
      </section>

      <section className="grid">
        <div className="gall-tit-box">
          <NextLink href="/" className="gall-tit-lnkempty"></NextLink>
          <h3 className="gall-tit">
            <NextLink href="/" className="gall-tit-lnk">게시글</NextLink>
          </h3>
          <span className="count">({total})</span>
        </div>

        {q && (
          <div className="archive-search-status">
            <span>🔍 <strong>&quot;{q}&quot;</strong> 검색 결과 ({total}건)</span>
            <NextLink href="/" className="archive-search-reset">검색 초기화</NextLink>
          </div>
        )}

        <ul className="gall-detail-lst">
          {posts.length === 0 && (
            <li className="empty-lst archive-empty-list">
              아직 아카이브된 게시글이 없습니다.
            </li>
          )}
          {posts.map((post) => (
            <li key={post.id}>
              <div className="gall-detail-lnktb">
                <NextLink href={`/post/${post.dc_id}`} className="lt">
                  <span className="subject-add">
                    {post.has_image && <span className="sp-lst sp-lst-img">이미지</span>}
                    {post.has_video && <span className="sp-lst sp-lst-movie">동영상</span>}
                    {!post.has_image && !post.has_video && <span className="sp-lst sp-lst-txt">텍스트</span>}
                    <span className="subjectin">{post.title}</span>
                  </span>
                  <ul className="ginfo">
                    <li>{post.category || '일반'}</li>
                    <li className="list-nick">{post.author}</li>
                    <li>{post.date}</li>
                    <li>조회 {post.views}</li>
                    <li>추천 <span>{post.likes}</span></li>
                  </ul>
                </NextLink>
                {post.comments_count > 0 && (
                  <NextLink href={`/post/${post.dc_id}#comment_box`} className="rt">
                    <span className="ct">{post.comments_count}</span>
                  </NextLink>
                )}
              </div>
            </li>
          ))}
        </ul>

        {/* Paging */}
        {(() => {
          const totalPages = Math.ceil(total / limit) || 1;
          if (totalPages <= 1) return null;

          const startPage = Math.max(1, page - 2);
          const endPage = Math.min(totalPages, startPage + 4);
          
          return (
            <div className="paging">
              {page > 1 ? (
                <NextLink href={`/?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}&type=${type}` : ''}`} className="prev">
                  <span className="blind">이전페이지</span>
                </NextLink>
              ) : (
                <span className="prev archive-paging-disabled">
                  <span className="blind">이전페이지</span>
                </span>
              )}
              
              {Array.from({ length: endPage - startPage + 1 }, (_, i) => {
                const p = startPage + i;
                return (
                  <NextLink 
                    key={p} 
                    href={`/?page=${p}${q ? `&q=${encodeURIComponent(q)}&type=${type}` : ''}`} 
                    className={p === page ? "on" : ""}
                  >
                    {p}
                  </NextLink>
                );
              })}

              {page < totalPages ? (
                <NextLink href={`/?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}&type=${type}` : ''}`} className="next">
                  <span className="blind">다음페이지</span>
                </NextLink>
              ) : (
                <span className="next archive-paging-disabled">
                  <span className="blind">다음페이지</span>
                </span>
              )}
            </div>
          );
        })()}

        {/* Bottom Search Bar */}
        <div className="bottom-schbox archive-bottom-search">
          <form action="/" method="GET" className="archive-bottom-search-form">
            <select name="type" defaultValue={type} className="archive-bottom-search-select">
              <option value="all">전체</option>
              <option value="title">제목</option>
              <option value="content">내용</option>
              <option value="author">글쓴이</option>
            </select>
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="검색어를 입력하세요"
              className="archive-bottom-search-input"
            />
            <button
              type="submit"
              className="archive-bottom-search-button"
            >
              검색
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
