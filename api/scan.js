// api/scan.js
// Fetches a client website server-side (no CORS issues), then sends the
// content to Claude to extract StoryBrand questionnaire answers.

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { url } = await req.json();
    if (!url) {
      return new Response(JSON.stringify({ error: 'No URL provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Step 1: Fetch the website pages server-side ──
    // We try homepage + common sub-pages and grab what we can
    const pagesToTry = [
      url,
      url.replace(/\/$/, '') + '/about',
      url.replace(/\/$/, '') + '/about-us',
      url.replace(/\/$/, '') + '/services',
      url.replace(/\/$/, '') + '/contact',
      url.replace(/\/$/, '') + '/contact-us',
    ];

    const fetchPage = async (pageUrl) => {
      try {
        const res = await fetch(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; UpFrameBot/1.0)',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const html = await res.text();
        // Strip HTML tags and collapse whitespace — keep it readable for Claude
        return html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000); // Cap per page so we don't blow the context window
      } catch {
        return null;
      }
    };

    // Fetch all pages in parallel
    const results = await Promise.all(pagesToTry.map(fetchPage));
    const pageLabels = ['Homepage', 'About', 'About Us', 'Services', 'Contact', 'Contact Us'];

    // Build a combined content string from whatever loaded successfully
    let siteContent = '';
    results.forEach((content, i) => {
      if (content && content.length > 100) {
        siteContent += `\n\n=== ${pageLabels[i]} (${pagesToTry[i]}) ===\n${content}`;
      }
    });

    if (!siteContent) {
      return new Response(
        JSON.stringify({ error: 'Could not fetch any content from the website. The site may block automated requests.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Step 2: Send content to Claude for analysis ──
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Haiku is fast and cheap for extraction tasks
        max_tokens: 2000,
        system: `You are a business analyst extracting information from website content to pre-fill a StoryBrand marketing questionnaire. Extract only what is clearly stated — do not invent or assume. Return null for anything not found.`,
        messages: [{
          role: 'user',
          content: `Analyze this website content and extract business information. Return ONLY valid JSON with these exact keys. Use null for anything not found. No text before or after the JSON.

WEBSITE CONTENT:
${siteContent}

JSON KEYS TO EXTRACT:
{
  "biz": "business name",
  "ind": "industry or business type (e.g. dental clinic, landscaping company, law firm)",
  "liner": "one-sentence description of what they do and for whom",
  "city": "primary city",
  "state": "state abbreviation",
  "area": "service area or other cities mentioned",
  "phone": "phone number",
  "email": "email address",
  "addr": "street address",
  "czip": "city state zip as one string",
  "hours": "business hours (preserve line breaks with \\n)",
  "social": "social media handles or URLs found",
  "kws": "comma-separated keywords they appear to target based on their content",
  "who": "description of their ideal or target customer based on site language",
  "want": "what the customer ultimately wants — inferred from site messaging",
  "ext": "the main external problem their customers face — inferred from site",
  "int": "the internal emotional frustration — inferred from site tone and messaging",
  "empathy": "any empathy statements or customer-first language found verbatim",
  "auth": "credentials, years in business, awards, number of clients, certifications — verbatim",
  "diff": "differentiators — what they claim makes them stand out",
  "story": "origin story or about us narrative — summarized",
  "process": "how to get started or what happens when you contact them",
  "success": "any success stories, results, or transformation language",
  "testim": "any testimonials or reviews found — verbatim if possible",
  "sv1n": "first service or product category name",
  "sv1d": "first service brief description",
  "sv2n": "second service name",
  "sv2d": "second service brief description",
  "sv3n": "third service name",
  "sv3d": "third service brief description",
  "sv4n": "fourth service name",
  "sv4d": "fourth service brief description",
  "sv5n": "fifth service name",
  "sv5d": "fifth service brief description",
  "pricing": "pricing model if mentioned",
  "turn": "turnaround or timeline if mentioned",
  "tone": "brand tone — one of: Professional / Expert, Friendly / Neighborly, Trusted Advisor, Approachable / Casual, Premium / High-End",
  "cta1": "primary call to action button text found on site",
  "cta2": "secondary call to action if found",
  "whycon": "any language about why to contact them or what to expect"
}`
        }]
      }),
    });

    if (!claudeResp.ok) {
      const err = await claudeResp.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Claude analysis failed');
    }

    const claudeData = await claudeResp.json();
    const text = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Could not parse analysis results');

    const extracted = JSON.parse(match[0]);

    return new Response(JSON.stringify({ success: true, data: extracted }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
