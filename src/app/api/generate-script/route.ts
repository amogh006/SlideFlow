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
      const errorText = await backendResponse.text();
       // Try to parse as JSON, but fallback to text if it fails
      try {
        const errorJson = JSON.parse(errorText);
        return NextResponse.json(errorJson, {status: backendResponse.status});
      } catch (e) {
         return new NextResponse(errorText, {status: backendResponse.status, headers: {'Content-Type': 'application/json'}});
      }
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
