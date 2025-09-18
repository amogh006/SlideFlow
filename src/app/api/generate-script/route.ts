
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
      const errorData = await backendResponse.text();
      try {
        const jsonData = JSON.parse(errorData);
        return NextResponse.json(jsonData, {status: backendResponse.status});
      } catch (e) {
        return new NextResponse(errorData, {status: backendResponse.status});
      }
    }

    const data = await backendResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    let errorMessage = 'An unknown error occurred in the proxy.';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json(
      {detail: errorMessage},
      {status: 500}
    );
  }
}
