export interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
}

export interface Attribution {
  sentence: string;
  sourcePosition: number;
  contributionScore: number;
}

export interface AIOverview {
  summary: string;
  attributions: Attribution[];
}

export interface SearchResponse {
  results: SearchResult[];
  aiOverview: AIOverview;
}

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function callGeminiWithRetry(apiKey: string, prompt: string, retries = 3, tools?: any[], config?: any): Promise<any> {
  const systemInstruction = `### SYSTEM ROLE: SEARCH-GROUNDED BRAND AUDITOR
You are a specialized AI Auditor for the NeuraGlobal ecosystem. Your goal is to replicate the "Gemini Search Grounding" logic: prioritizing factual, live-web evidence over internal training data.

### OPERATIONAL PIPELINE:
1. DIVERGENCE (Research Phase):
   - When a user asks about a domain or keyword, your first step is to generate 3-5 specific search queries.
   - You MUST cross-reference the top 15 results from the live web (Google Search Index).
   - Identify the "Identity Consensus"—how the world currently defines this brand.

2. GOVERNANCE (Audit Phase):
   - Compare the live results to your internal "Memory." 
   - If there is a conflict (e.g., LivBio is "Clothing" in search but "Biotech" in memory), you MUST flag this as an "Identity Gap" in your summary.
   - Do not hallucinate. If you cannot find a specific product on the live domain, do not list it.

3. CONVERGENCE (Synthesis Phase):
   - Provide a final JSON output.
   - Include "results": An array of 15 items from the Search Index.
   - Include "aiOverview": A summary with "attributions" (linking claims to result indices 1-15).
   - Assign a "visibilityScore": Based on the brand's dominance in search snippets.

### STYLISTIC GUIDELINES:
- Tone: Professional, clinical, and data-driven (like a Google Search Console report).
- Bias: Strictly local. Prioritize Indian regional context (Bharat) for .in domains.
- Persistence: Stay in "JSON Mode" even if the user asks a follow-up question.

Return ONLY valid JSON. Keep keys consistent.`;
  
  const url = `${GEMINI_API_URL}?key=${apiKey}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const body: any = {
        contents: [{ parts: [{ text: prompt }] }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generationConfig: config || {
          temperature: 0.0,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      };

      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json();
        return data;
      }

      const retriable = [429, 500, 503, 504];
      if (retriable.includes(response.status)) {
        const waitTime = Math.pow(1.5, attempt) * 1000 + 500;
        console.warn(`Gemini API Busy (${response.status}) - Retry ${attempt + 1}/${retries}...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      const errText = await response.text();
      throw new Error(`API Error ${response.status}: ${errText.slice(0, 50)}`);
    } catch (err: any) {
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('The AI service is currently at peak capacity. Please try again in 30 seconds.');
}

export async function fetchSearchResults(keyword: string): Promise<SearchResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('API Key missing');

  const prompt = `Search the web for: "${keyword}"

Using your google_search tool, find the top 15 real search results for this keyword. Then return them as a JSON object with this exact structure:
{
  "results": [
    { "position": 1, "title": "...", "url": "...", "snippet": "..." },
    ...up to 15 items
  ],
  "aiOverview": {
    "summary": "2-3 sentence summary of what these results reveal about this keyword's search landscape.",
    "attributions": []
  }
}
Return ONLY valid JSON. No markdown, no explanation.`;

  const tools = [{ google_search: {} }];
  const data = await callGeminiWithRetry(apiKey, prompt, 3, tools);
  
  const candidate = data.candidates?.[0];
  const groundingChunks = candidate?.groundingMetadata?.groundingChunks;

  if (groundingChunks && groundingChunks.length > 0) {
    // Build results from real grounded data
    return {
      results: groundingChunks.slice(0, 15).map((chunk: any, i: number) => ({
        position: i + 1,
        title: chunk.web?.title || 'Untitled',
        url: chunk.web?.uri || '#',
        snippet: chunk.web?.snippet || 'No description.',
      })),
      aiOverview: {
        summary: candidate?.content?.parts?.[0]?.text || 'No summary available.',
        attributions: [],
      },
    };
  }

  // Fall back to existing text JSON parsing only if groundingChunks is missing
  const textContent = candidate?.content?.parts?.[0]?.text;
  if (!textContent) throw new Error('Failed to parse AI results.');

  let jsonString = textContent.trim();
  const start = jsonString.indexOf('{');
  const end = jsonString.lastIndexOf('}');
  if (start !== -1 && end !== -1) jsonString = jsonString.substring(start, end + 1);

  const parsed = JSON.parse(jsonString);
  
  if (parsed.results && Array.isArray(parsed.results)) {
    return {
      results: parsed.results.slice(0, 15).map((r: any, i: number) => ({
        position: i + 1,
        title: String(r.title || 'Untitled Result'),
        url: String(r.url || '#'),
        snippet: String(r.snippet || 'No description.'),
      })),
      aiOverview: {
        summary: String(parsed.aiOverview?.summary || parsed.summary || 'No summary available.'),
        attributions: Array.isArray(parsed.aiOverview?.attributions || parsed.attributions) 
          ? (parsed.aiOverview?.attributions || parsed.attributions).map((a: any) => ({
              sentence: String(a.sentence || ''),
              sourcePosition: Math.max(1, Math.min(15, Number(a.sourcePosition || a.position || 1))),
              contributionScore: Math.max(1, Number(a.contributionScore || a.score || 10)),
            }))
          : []
      }
    };
  }

  throw new Error('Failed to parse AI results.');
}

export function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

export function urlsMatch(targetUrl: string, resultUrl: string): boolean {
  const normalTarget = normalizeUrl(targetUrl);
  const normalResult = normalizeUrl(resultUrl);
  // Exact match or one contains the other
  if (normalResult.includes(normalTarget) || normalTarget.includes(normalResult)) return true;
  // Domain-level match
  const targetDomain = normalTarget.split('/')[0];
  const resultDomain = normalResult.split('/')[0];
  return targetDomain === resultDomain;
}

function getMockRankFeedback(keyword: string, targetUrl: string, position: number | null): string {
  if (position) {
    return `Your website is performing well for "${keyword}", ranking at position #${position}. To improve further, focus on optimizing your title tags and building high-quality backlinks from relevant domains.`;
  }
  return `Your website "${targetUrl}" was not found in the top results for "${keyword}". Consider improving your on-page SEO, increasing content depth, and ensuring your site is mobile-friendly to boost rankings.`;
}

export async function generateRankCheckFeedback(keyword: string, targetUrl: string, position: number | null, results: SearchResult[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return getMockRankFeedback(keyword, targetUrl, position);

  const status = position ? `found at position #${position}` : "not found in the top 15 results";
  const prompt = `Provide 1-2 sentences of professional SEO advice for "${targetUrl}" regarding "${keyword}". Status: ${status}. Be concise and professional.`;

  try {
    const data = await callGeminiWithRetry(apiKey, prompt, 1);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || getMockRankFeedback(keyword, targetUrl, position);
  } catch (err) {
    console.warn('Gemini feedback failed, using mock:', err);
    return getMockRankFeedback(keyword, targetUrl, position);
  }
}

export interface DomainAuditItem {
  title: string;
  url: string;
  type: 'page' | 'product' | 'article';
  relevanceScore: number;
}

export interface DomainIntent {
  query: string;
  intent: 'navigational' | 'informational' | 'transactional' | 'commercial';
  context: string;
}

export interface DeepDomainAuditResponse {
  domain: string;
  pages: DomainAuditItem[];
  visibilityScore: number;
  verdict: string;
  recoveryUsed?: boolean;
}

export async function performDeepDomainAudit(domain: string): Promise<DeepDomainAuditResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('API Key missing');

  const prompt = `Perform a SEARCH-GROUNDED "Deep AI Memory Audit" for: "${domain}".
  
  1. Audit the live web to identify 6 key pages, products, or assets associated with this domain.
  2. Compare live visibility with internal AI memory to detect representation gaps.
  3. Provide a "verdict" based on the "Identity Consensus" found via search.

Return a JSON object with:
{
  "visibilityScore": number,
  "pages": [ {"title": string, "url": string, "type": "product"|"page", "relevanceScore": number} ],
  "verdict": string
}
IMPORTANT: Base score and verdict on regional context (India/Bharat) for .in domains.`;

  const tools = [{ google_search: {} }]; 
  const generationConfig = {
    temperature: 0.0,
    maxOutputTokens: 4096,
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        visibilityScore: { type: "number" },
        verdict: { type: "string" },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              type: { type: "string", enum: ["page", "product", "article"] },
              relevanceScore: { type: "number" }
            }
          }
        }
      }
    }
  };

  const responseData = await callGeminiWithRetry(apiKey, prompt, 3, tools, generationConfig);
  const textContent = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) throw new Error('Failed to get audit data from Gemini');

  const data = JSON.parse(textContent);
  return {
    domain,
    pages: (data.pages || []).slice(0, 7).map((p: any) => ({
      title: String(p.title || 'Untitled'),
      url: String(p.url || '#'),
      type: ['page','product','article'].includes(p.type) ? p.type : 'page',
      relevanceScore: Math.min(100, Math.max(0, Number(p.relevanceScore || 50))),
    })),
    visibilityScore: Number(data.visibilityScore || 30),
    verdict: String(data.verdict || 'No verdict available.'),
    recoveryUsed: false,
  };
}

export function estimateTokensUsed(keyword: string): number {
  return Math.ceil(keyword.length / 4) + 1000;
}
