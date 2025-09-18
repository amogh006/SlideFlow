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

    if (!backendResponse.ok) {
        let errorDetail = `Backend returned status ${backendResponse.status}`;
        try {
            // Try to parse the error response from the backend
            const errorJson = await backendResponse.json();
            errorDetail = errorJson.detail || JSON.stringify(errorJson);
        } catch (e) {
            // If parsing fails, use the raw text as detail
            errorDetail = await backendResponse.text();
        }
        return NextResponse.json({ detail: errorDetail }, { status: backendResponse.status });
    }

    const data = await backendResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Proxy error in /api/generate-script:', error);
    let errorMessage = 'An unknown error occurred in the proxy.';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json(
      {detail: `Proxy error: ${errorMessage}`},
      {status: 500}
    );
  }
}
