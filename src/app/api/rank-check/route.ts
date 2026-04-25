import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Fuse from 'fuse.js';
import { generateRankCheckFeedback, urlsMatch } from '@/lib/gemini';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    
    const authHeader = request.headers.get('authorization');
    let user;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const { data } = await supabase.auth.getUser(token);
      user = data.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data.user;
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { search_id, target_url } = await request.json();
    if (!search_id || !target_url) {
      return NextResponse.json({ error: 'search_id and target_url are required' }, { status: 400 });
    }

    // Fetch search results and keyword
    const { data: searchInfo } = await supabase
      .from('searches')
      .select('keyword')
      .eq('id', search_id)
      .single();

    const { data: results } = await supabase
      .from('search_results')
      .select('position, title, url, snippet')
      .eq('search_id', search_id)
      .order('position');

    if (!results || results.length === 0 || !searchInfo) {
      return NextResponse.json({ error: 'Search context not found' }, { status: 404 });
    }

    // Use normalized matching function
    let matchedResult = results.find((r) => urlsMatch(target_url, r.url));

    // Fallback to fuzzy match using Fuse.js if no direct match found
    if (!matchedResult) {
      const fuse = new Fuse(results, {
        keys: ['url'],
        threshold: 0.4,
        includeScore: true,
      });
      const fuseResults = fuse.search(target_url);
      if (fuseResults.length > 0 && (fuseResults[0].score || 1) < 0.4) {
        matchedResult = fuseResults[0].item;
      }
    }

    // Generate AI feedback
    const feedback = await generateRankCheckFeedback(
      searchInfo.keyword,
      target_url,
      matchedResult?.position || null,
      results
    );

    // Save rank check
    await supabase.from('rank_checks').insert({
      search_id,
      target_url,
      is_listed: !!matchedResult,
      position: matchedResult?.position || null,
      feedback,
    });

    return NextResponse.json({
      is_listed: !!matchedResult,
      position: matchedResult?.position || null,
      feedback,
      matched_url: matchedResult?.url || null,
    });
  } catch (error) {
    console.error('Rank check error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
