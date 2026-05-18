import { NextResponse } from 'next/server';
import { scrapeDcPost } from '@/lib/scraper';
import { dbApi } from '@/lib/db';


export async function POST(request: Request) {
  try {
    const { url } = await request.json();
    
    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // 1. Scrape the post
    const postData = await scrapeDcPost(url);
    
    // 2. Save to database
    const insertedId = await dbApi.insertPost(postData);



    return NextResponse.json({ 
      success: true, 
      post: { ...postData, id: insertedId }
    });

  } catch (error: any) {
    console.error("Scraping error:", error);
    return NextResponse.json(
      { error: error.message || 'Failed to archive post' }, 
      { status: 500 }
    );
  }
}
