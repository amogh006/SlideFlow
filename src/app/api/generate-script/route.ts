import {NextRequest, NextResponse} from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    
    const backendUrl = 'http://147.93.102.137:8000/upload-slides-generate-script/';

    const backendResponse = await fetch(backendUrl, {
      method: 'POST',
      body: formData,
    });
    
    const responseBody = await backendResponse.text();

    if (!backendResponse.ok) {
      let errorDetail = `Backend error: Status ${backendResponse.status}`;
      // Try to parse the error as JSON, otherwise use the raw text
      try {
        const errorJson = JSON.parse(responseBody);
        errorDetail = errorJson.detail || responseBody;
      } catch (e) {
        errorDetail = responseBody;
      }
      return NextResponse.json({ detail: errorDetail }, { status: backendResponse.status });
    }
    
    // The request was successful, so we expect JSON.
    try {
        const data = JSON.parse(responseBody);
        return NextResponse.json(data);
    } catch(e) {
        return NextResponse.json({ detail: "Backend returned invalid JSON." }, { status: 502 }); // 502 Bad Gateway
    }

  } catch (error: any) {
    console.error('Proxy error in /api/generate-script:', error);
    // This catches network errors (e.g., server unreachable) and other exceptions
    return NextResponse.json(
      {detail: `Proxy error: ${error.message || 'Unable to connect to backend service.'}`},
      {status: 500}
    );
  }
}
