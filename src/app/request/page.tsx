"use client";

import { ArrowLeft } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RequestPage() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "아카이브 실패");

      // Go to the newly created post
      router.push(`/post/${data.post.dc_id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "아카이브 실패");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="archive-request-page">
      {/* Header */}
      <header className="archive-request-header">
        <div className="archive-request-back">
          <NextLink href="/">
            <ArrowLeft className="archive-request-back-icon" color="#fff" />
          </NextLink>
          <span className="archive-request-back-label">돌아가기</span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="grid archive-request-panel">
        <h2 className="archive-request-title">
          아카이브 게시글 주소 등록
        </h2>

        <form onSubmit={handleSubmit} className="archive-request-form">
          <div>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://m.dcinside.com/mini/fangall/..."
              className="archive-request-input"
              disabled={isLoading}
            />
          </div>

          {error && (
            <div className="archive-request-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="archive-request-submit"
          >
            {isLoading ? "백업 중..." : "백업"}
          </button>
        </form>
      </div>

      {/* Guide/Notice Section styled like a DC gallery notice */}
      <div className="grid archive-request-guide-wrap">
        <div className="archive-request-guide">
          <h3 className="archive-request-guide-title">
            아카이브 이용 안내
          </h3>
          <ul className="archive-request-guide-list">
            <li>이미 백업되어 있는 글을 등록시 최신 정보(추가된 댓글, 조회수, 추천 등)로 <strong>자동 업데이트</strong> 됩니다.</li>
            <li>이미지 파일의 경우 원본 디시 서버의 외부 핫링크 차단을 우회하기 위해 <strong>안전 보안 프록시</strong>를 거쳐 출력됩니다.</li>
            <li>디시인사이드 모바일 버젼 및 PC 버젼의 갤러리/미니갤러리 URL 모두 등록 가능합니다.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
