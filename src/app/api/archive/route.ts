import { NextResponse } from 'next/server';
import { scrapeDcPost } from '@/lib/scraper';
import { dbApi } from '@/lib/db';
import { revalidatePath } from 'next/cache';


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
    revalidatePath("/");
    revalidatePath(`/post/${postData.dc_id}`);


    return NextResponse.json({ 
      success: true, 
      post: { ...postData, id: insertedId }
    });

  } catch (error: unknown) {
    console.error("Scraping error:", error);
    const message = error instanceof Error ? error.message : 'Failed to archive post';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
